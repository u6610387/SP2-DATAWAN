/**
 * Owner-side Mini-QR check of an uploaded slip (free, no bank API — CLAUDE.md §3.2, D1).
 * The owner's dashboard decodes the QR from the stored slip image on the owner's own device and
 * sends the text here. Code may FLAG (duplicate / tampered QR) but never approves: the result
 * only updates the payment's REFERENCE check; confirming still needs the owner's tap, and a
 * WARN/FAIL overall still needs an override reason (seafood-domain-rules §1).
 */
import type { CheckLevel, OrderRow, PaymentRow, SlipCheck } from '@datawan/shared';
import type { Deps } from '../deps';
import { logEvent } from './orders';
import { bankName, parseSlipQr } from './slipQr';

export type SlipQrCheckResult =
  | { ok: true; payment: PaymentRow; check: SlipCheck }
  | { ok: false; reason: 'ALREADY_CONFIRMED' };

const RANK: Record<CheckLevel, number> = { PASS: 0, WARN: 1, FAIL: 2 };
const worst = (checks: SlipCheck[]): CheckLevel =>
  checks.reduce<CheckLevel>((acc, c) => (RANK[c.result] > RANK[acc] ? c.result : acc), 'PASS');

export async function ownerCheckSlipQr(deps: Deps, order: OrderRow, payment: PaymentRow, ownerId: string, payload: string | null): Promise<SlipQrCheckResult> {
  if (payment.confirmed_at) return { ok: false, reason: 'ALREADY_CONFIRMED' };

  let check: SlipCheck;
  let referenceNo: string | null = null;
  const parsed = payload === null ? null : parseSlipQr(payload);

  if (parsed === null) {
    check = { rule: 'REFERENCE', result: 'WARN', detail: 'ไม่พบ QR บนรูปสลิป ตรวจเลขอ้างอิงจากรูปด้วยตนเอง' };
  } else if (!parsed.ok && parsed.reason === 'BAD_CRC') {
    check = { rule: 'REFERENCE', result: 'FAIL', detail: 'QR บนสลิปไม่ถูกต้อง (ตรวจสอบรหัสไม่ผ่าน) สลิปอาจถูกแก้ไข' };
  } else if (!parsed.ok) {
    check = { rule: 'REFERENCE', result: 'WARN', detail: 'QR บนรูปไม่ใช่ QR ตรวจสอบสลิปของธนาคาร ตรวจจากรูปด้วยตนเอง' };
  } else if (payment.reference_no && payment.reference_no !== parsed.transRef) {
    check = { rule: 'REFERENCE', result: 'FAIL', detail: `เลขอ้างอิงใน QR (${parsed.transRef}) ไม่ตรงกับเลขที่อ่านได้จากสลิป (${payment.reference_no})` };
  } else {
    const other = await deps.repo.findPaymentByReference(parsed.transRef);
    if (other && other.id !== payment.id) {
      const otherOrder = await deps.repo.getOrder(other.order_id);
      check = { rule: 'REFERENCE', result: 'FAIL', detail: `สลิปซ้ำ: เลขอ้างอิง ${parsed.transRef} เคยใช้กับออเดอร์ ${otherOrder?.code ?? '-'} แล้ว` };
    } else {
      referenceNo = parsed.transRef;
      check = { rule: 'REFERENCE', result: 'PASS', detail: `QR ธนาคารถูกต้อง: ${bankName(parsed.sendingBank)} เลขอ้างอิง ${parsed.transRef} ยังไม่เคยใช้` };
    }
  }

  const details = (payment.check_details ?? {}) as { checks?: SlipCheck[]; [k: string]: unknown };
  const checks = [...(details.checks ?? []).filter((c) => c.rule !== 'REFERENCE'), check];
  const patch = {
    check_details: { ...details, checks, qr: parsed?.ok ? { sending_bank: parsed.sendingBank } : { status: parsed ? parsed.reason : 'NOT_FOUND' } },
    check_result: worst(checks),
    ...(referenceNo ? { reference_no: referenceNo } : {}),
  };

  let updated: PaymentRow;
  try {
    updated = await deps.repo.updatePayment(payment.id, patch);
  } catch (e) {
    // Lost a race with another payment claiming the same transRef: the unique index decides.
    if (!referenceNo || !/payments_reference_uidx|duplicate key/i.test((e as Error).message)) throw e;
    check = { rule: 'REFERENCE', result: 'FAIL', detail: `สลิปซ้ำ: เลขอ้างอิง ${referenceNo} ถูกใช้กับออเดอร์อื่นแล้ว` };
    const raceChecks = [...checks.slice(0, -1), check];
    updated = await deps.repo.updatePayment(payment.id, { check_details: { ...patch.check_details, checks: raceChecks }, check_result: worst(raceChecks) });
  }
  await logEvent(deps, order, 'owner', 'SLIP_QR_CHECKED', { payment_id: payment.id, result: check.result, owner_id: ownerId });
  return { ok: true, payment: updated, check };
}
