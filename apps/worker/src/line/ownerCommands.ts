/**
 * Owner LINE command grammar — API_AND_AI_CONTRACTS §4.2. Deterministic regex, never AI.
 *
 *   [A12 ]1850[ note]   [A12 ]ship 120   [A12 ]track <url>   [A12 ]ok | hold
 *   [A12 ]paid[! reason]   [A12 ]done   [A12 ]note <text>   list | ?
 */
import { bahtToSatang } from '@datawan/shared';

export type OwnerCommand =
  | { kind: 'price'; code: string | null; amountSatang: number; note: string | null }
  | { kind: 'ship'; code: string | null; feeSatang: number }
  | { kind: 'track'; code: string | null; url: string }
  | { kind: 'ok'; code: string | null }
  | { kind: 'hold'; code: string | null }
  | { kind: 'paid'; code: string | null; overrideReason: string | null }
  | { kind: 'done'; code: string | null }
  | { kind: 'note'; code: string | null; text: string }
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

const CODE_RE = /^([A-Za-z]\d{1,3})(?:\s+|$)/;

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ''));
}

export function parseOwnerCommand(input: string): OwnerCommand {
  const text = input.trim().replace(/[๐-๙]/g, (d) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)));
  if (/^(list|\?|ออเดอร์|รายการ)$/i.test(text)) return { kind: 'list' };
  if (/^(help|ช่วย|วิธีใช้)$/i.test(text)) return { kind: 'help' };

  const cm = CODE_RE.exec(text);
  const code = cm ? cm[1]!.toUpperCase() : null;
  const body = (cm ? text.slice(cm[0].length) : text).trim();

  let m: RegExpExecArray | null;
  if ((m = /^(?:ship|ส่ง|ค่าส่ง)\s+(\d{1,3}(?:,\d{3})*|\d+)$/i.exec(body))) return { kind: 'ship', code, feeSatang: bahtToSatang(toNumber(m[1]!)) };
  if ((m = /^track\s+(https?:\/\/\S+)$/i.exec(body))) return { kind: 'track', code, url: m[1]! };
  if (/^https?:\/\/\S*lalamove\S*$/i.test(body)) return { kind: 'track', code, url: body };
  if ((m = /^note\s+([\s\S]+)$/i.exec(body))) return { kind: 'note', code, text: m[1]!.trim() };
  if ((m = /^paid(?:!\s*([\s\S]+))?$/i.exec(body))) return { kind: 'paid', code, overrideReason: m[1]?.trim() || null };
  if (/^(done|delivered|ส่งแล้ว)$/i.test(body)) return { kind: 'done', code };
  if (/^(ok|ตกลง|รับ)$/i.test(body)) return { kind: 'ok', code };
  if (/^(hold|ยืนราคา)$/i.test(body)) return { kind: 'hold', code };
  if ((m = /^(\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.(\d{1,2}))?(?:\s+([\s\S]+))?$/.exec(body))) {
    const baht = toNumber(m[1]!) + (m[2] ? Number(`0.${m[2]}`) : 0);
    if (baht > 0) return { kind: 'price', code, amountSatang: bahtToSatang(baht), note: m[3]?.trim() || null };
  }
  return { kind: 'unknown', text };
}
