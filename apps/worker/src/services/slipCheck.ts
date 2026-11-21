/**
 * Slip cross-check — PROJECT_SPEC §5. Code may flag (WARN/FAIL) but never approve:
 * even PASS waits for the owner's tap (seafood-domain-rules §1).
 */
import { bahtToSatang, formatTHB, type CheckLevel, type OrderRow, type SlipCheck, type SlipReadResult } from '@datawan/shared';

export interface SlipCheckContext {
  order: Pick<OrderRow, 'total_satang' | 'quoted_at' | 'status'>;
  receiverName: string;
  promptpayId: string;
  referenceAlreadyUsed: boolean;
  now: Date;
}

export interface SlipCheckOutcome {
  result: CheckLevel;
  checks: SlipCheck[];
}

const RANK: Record<CheckLevel, number> = { PASS: 0, WARN: 1, FAIL: 2 };
const TITLES = /^(นาย|นางสาว|นาง|น\.ส\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i;

function norm(s: string): string {
  return s.replace(TITLES, '').replace(/[\s.*xX\-]/g, '').toLowerCase();
}

/** Receiver matches if the last 4 digits of the PromptPay ID appear, or the visible name prefix matches. */
export function receiverMatches(printed: string, expectedName: string, promptpayId: string): boolean {
  const digits = promptpayId.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  if (last4.length === 4 && printed.replace(/\D/g, '').includes(last4)) return true;
  if (!expectedName) return false;
  // Slips mask names: "นาง ดา ท***" → visible prefix "ดาท". Compare each visible word prefix.
  const printedWords = printed.replace(TITLES, '').split(/\s+/).map((w) => w.replace(/[*xX]+$/, '')).filter((w) => w.length > 0);
  const expectedWords = expectedName.replace(TITLES, '').split(/\s+/).filter(Boolean);
  if (printedWords.length === 0) return false;
  if (norm(printed).length >= 2 && norm(expectedName).startsWith(norm(printed))) return true;
  return printedWords.every((w, i) => (expectedWords[i] ?? '').toLowerCase().startsWith(w.toLowerCase())) && printedWords.join('').length >= 2;
}

export function checkSlip(slip: SlipReadResult | null, ctx: SlipCheckContext): SlipCheckOutcome {
  const checks: SlipCheck[] = [];
  if (!slip || !slip.is_slip) {
    checks.push({ rule: 'READABLE', result: 'WARN', detail: 'อ่านสลิปไม่ได้ ให้เจ้าของร้านตรวจจากรูป' });
    return { result: 'WARN', checks };
  }
  const missing = (['amount', 'date_time', 'receiver_name_or_id', 'reference_no'] as const).filter((k) => slip[k] === null);
  checks.push(
    missing.length
      ? { rule: 'READABLE', result: 'WARN', detail: `อ่านไม่ออก: ${missing.join(', ')}` }
      : { rule: 'READABLE', result: 'PASS', detail: 'อ่านครบ' },
  );

  if (slip.amount === null || ctx.order.total_satang === null) {
    checks.push({ rule: 'AMOUNT', result: 'FAIL', detail: 'ไม่มียอดให้เทียบ' });
  } else {
    const amt = bahtToSatang(slip.amount);
    checks.push(
      amt === ctx.order.total_satang
        ? { rule: 'AMOUNT', result: 'PASS', detail: `ยอดตรง ${formatTHB(amt)}` }
        : { rule: 'AMOUNT', result: 'FAIL', detail: `สลิป ${formatTHB(amt)} ≠ ยอด ${formatTHB(ctx.order.total_satang)}` },
    );
  }

  if (slip.date_time === null || Number.isNaN(Date.parse(slip.date_time))) {
    checks.push({ rule: 'TIME', result: 'WARN', detail: 'ไม่มีเวลาโอน' });
  } else {
    const t = Date.parse(slip.date_time);
    const from = ctx.order.quoted_at ? Date.parse(ctx.order.quoted_at) : -Infinity;
    const ok = t >= from - 60_000 && t <= ctx.now.getTime() + 5 * 60_000;
    checks.push(ok ? { rule: 'TIME', result: 'PASS', detail: 'เวลาโอนอยู่ในช่วงออเดอร์' } : { rule: 'TIME', result: 'WARN', detail: 'เวลาโอนอยู่นอกช่วงออเดอร์' });
    if (ctx.order.status === 'PAYMENT_EXPIRED') checks.push({ rule: 'TIME', result: 'WARN', detail: 'ส่งสลิปหลังหมดเวลา' });
  }

  if (slip.receiver_name_or_id === null) {
    checks.push({ rule: 'RECEIVER', result: 'WARN', detail: 'ไม่พบชื่อ/บัญชีผู้รับ' });
  } else {
    checks.push(
      receiverMatches(slip.receiver_name_or_id, ctx.receiverName, ctx.promptpayId)
        ? { rule: 'RECEIVER', result: 'PASS', detail: 'ผู้รับตรงกับร้าน' }
        : { rule: 'RECEIVER', result: 'FAIL', detail: `ผู้รับ "${slip.receiver_name_or_id}" ไม่ตรงกับร้าน` },
    );
  }

  if (slip.reference_no === null) {
    checks.push({ rule: 'REFERENCE', result: 'WARN', detail: 'ไม่มีเลขอ้างอิง' });
  } else {
    checks.push(
      ctx.referenceAlreadyUsed
        ? { rule: 'REFERENCE', result: 'FAIL', detail: 'เลขอ้างอิงนี้เคยใช้แล้ว (สลิปซ้ำ?)' }
        : { rule: 'REFERENCE', result: 'PASS', detail: 'เลขอ้างอิงไม่ซ้ำ' },
    );
  }

  const result = checks.reduce<CheckLevel>((w, c) => (RANK[c.result] > RANK[w] ? c.result : w), 'PASS');
  return { result, checks };
}
