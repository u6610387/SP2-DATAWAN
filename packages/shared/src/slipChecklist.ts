/**
 * Owner slip checklist (GEMINI_SLIP_MODE=manual: nothing reads the slip, CLAUDE.md D1).
 *
 * The bank Mini-QR only proves the transaction reference is real and unused; it carries no amount,
 * receiver or time. So before ยืนยันรับเงิน the owner types what the slip shows, and these pure
 * rules (same code on the dashboard preview and in the worker) flag mismatches. Code only flags:
 * a FAIL needs a typed override reason, and confirming is always the owner's tap (§3.1).
 */
import { formatTHB } from './money';
import type { SlipCheck } from './contracts/views';

export interface OwnerSlipChecklistInput {
  /** Amount printed on the slip, in satang. */
  amountSatang: number;
  /** Owner ticked "the receiver on the slip is our shop". */
  receiverIsShop: boolean;
  /** Transfer time printed on the slip (ISO 8601 with offset). */
  slipTime: string;
}

/** Slips show minutes only: allow the transfer in the same minute the order was created. */
const minuteFloor = (ms: number) => Math.floor(ms / 60_000) * 60_000;
/** Phone clock skew allowed for a slip time "in the future". */
const FUTURE_SKEW_MS = 10 * 60_000;

export function ownerSlipChecks(input: OwnerSlipChecklistInput, ctx: { totalSatang: number | null; orderCreatedAt: string; now: Date }): SlipCheck[] {
  const checks: SlipCheck[] = [];

  if (ctx.totalSatang === null) {
    checks.push({ rule: 'AMOUNT', result: 'FAIL', detail: 'ออเดอร์ยังไม่มียอดให้เทียบ' });
  } else if (input.amountSatang === ctx.totalSatang) {
    checks.push({ rule: 'AMOUNT', result: 'PASS', detail: `ยอดในสลิปตรงกับยอดออเดอร์ ${formatTHB(ctx.totalSatang)} (เจ้าของร้านกรอก)` });
  } else {
    checks.push({ rule: 'AMOUNT', result: 'FAIL', detail: `ยอดในสลิป ${formatTHB(input.amountSatang)} ≠ ยอดออเดอร์ ${formatTHB(ctx.totalSatang)}` });
  }

  checks.push(
    input.receiverIsShop
      ? { rule: 'RECEIVER', result: 'PASS', detail: 'เจ้าของร้านยืนยันว่าผู้รับในสลิปคือร้าน' }
      : { rule: 'RECEIVER', result: 'FAIL', detail: 'ผู้รับในสลิปไม่ใช่ร้าน (หรือยังไม่ได้ยืนยัน)' },
  );

  const t = Date.parse(input.slipTime);
  if (Number.isNaN(t)) {
    checks.push({ rule: 'TIME', result: 'FAIL', detail: 'เวลาในสลิปไม่ถูกต้อง' });
  } else if (t < minuteFloor(Date.parse(ctx.orderCreatedAt))) {
    checks.push({ rule: 'TIME', result: 'FAIL', detail: 'เวลาโอนในสลิปเก่ากว่าเวลาที่สร้างออเดอร์ (อาจเป็นสลิปเก่า)' });
  } else if (t > ctx.now.getTime() + FUTURE_SKEW_MS) {
    checks.push({ rule: 'TIME', result: 'FAIL', detail: 'เวลาโอนในสลิปอยู่ในอนาคต' });
  } else {
    checks.push({ rule: 'TIME', result: 'PASS', detail: 'เวลาโอนหลังสร้างออเดอร์' });
  }
  return checks;
}
