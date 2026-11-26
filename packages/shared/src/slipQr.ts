/**
 * Thai bank slip "verify" Mini-QR (shared: the customer's browser gates uploads with it, the
 * Worker re-validates, the owner's dashboard re-reads the stored image).
 * (printed on every transfer slip). Free, local, no bank API:
 *   00 { 00 API ID "000001" (Verify Pay Slip), 01 sending bank BOT code, 02 transRef } · 51 "TH" · 91 CRC
 * CRC is CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the payload up to and including "9104".
 *
 * What this proves: the slip carries a well-formed bank QR with this transRef, and (via the DB)
 * whether that transRef was already used. What it does NOT prove: that the transfer happened,
 * its amount, receiver or time — that needs a bank API, which CLAUDE.md §3.2 rules out after
 * handover. The owner still checks those on the image.
 */

export type SlipQrResult =
  | { ok: true; apiId: string; sendingBank: string; transRef: string }
  | { ok: false; reason: 'NOT_SLIP_QR' | 'BAD_CRC' };

export function crc16ccitt(s: string): string {
  let crc = 0xffff;
  for (let k = 0; k < s.length; k++) {
    const byte = s.charCodeAt(k) & 0xff; // slip QR payloads are ASCII
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parseTlv(s: string): Map<string, string> | null {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    if (i + 4 > s.length) return null;
    const tag = s.slice(i, i + 2);
    const len = s.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(len)) return null;
    const n = Number(len);
    if (i + 4 + n > s.length) return null;
    out.set(tag, s.slice(i + 4, i + 4 + n));
    i += 4 + n;
  }
  return out;
}

export function parseSlipQr(raw: string): SlipQrResult {
  const s = raw.trim();
  const top = parseTlv(s);
  const inner = top?.get('00');
  const sub = inner ? parseTlv(inner) : null;
  const crc = top?.get('91');
  if (!top || !sub || !crc || top.get('51') !== 'TH' || sub.get('00') !== '000001') return { ok: false, reason: 'NOT_SLIP_QR' };
  const sendingBank = sub.get('01');
  const transRef = sub.get('02');
  if (!sendingBank || !/^\d{3}$/.test(sendingBank) || !transRef || !/^[0-9A-Za-z]{6,40}$/.test(transRef)) return { ok: false, reason: 'NOT_SLIP_QR' };
  if (!s.endsWith(crc) || crc16ccitt(s.slice(0, -4)) !== crc.toUpperCase()) return { ok: false, reason: 'BAD_CRC' };
  return { ok: true, apiId: '000001', sendingBank, transRef };
}

/** Major Thai banks by BOT code; others are shown by code. */
const BANKS: Record<string, string> = {
  '002': 'กรุงเทพ',
  '004': 'กสิกรไทย',
  '006': 'กรุงไทย',
  '011': 'ทหารไทยธนชาต',
  '014': 'ไทยพาณิชย์',
  '025': 'กรุงศรีอยุธยา',
  '030': 'ออมสิน',
};
export function bankName(code: string): string {
  return BANKS[code] ? `ธ.${BANKS[code]}` : `ธนาคารรหัส ${code}`;
}

/** Builds a valid slip QR string (correct CRC). Tests only. */
export function buildSlipQrForTest(bank: string, transRef: string, o: { country?: string; apiId?: string } = {}): string {
  const f = (tag: string, v: string) => `${tag}${String(v.length).padStart(2, '0')}${v}`;
  const body = f('00', f('00', o.apiId ?? '000001') + f('01', bank) + f('02', transRef)) + f('51', o.country ?? 'TH') + '9104';
  return body + crc16ccitt(body);
}
