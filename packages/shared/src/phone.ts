/**
 * Thai phone numbers for the delivery recipient (pasted into Lalamove by the owner).
 * Stored normalised: leading 0, digits only, 9 digits (landline, e.g. 02-xxx-xxxx) or 10 digits
 * (mobile, e.g. 08x-xxx-xxxx). Accepts spaces/dashes/dots, +66 / 66 country code and Thai digits.
 * PII: lives only in Supabase (users.phone, addresses/orders.recipient_phone) — CLAUDE.md §3.3.
 */
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

export function normalizeThaiPhone(input: string): string | null {
  const ascii = input.trim().replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
  if (!/^\+?[\d\s.\-()]+$/.test(ascii)) return null;
  let digits = ascii.replace(/\D/g, '');
  if (ascii.startsWith('+') && !digits.startsWith('66')) return null;
  if (digits.startsWith('66')) digits = `0${digits.slice(2)}`;
  return /^0\d{8,9}$/.test(digits) ? digits : null;
}

/** 0812345678 → 081-234-5678; 021234567 → 02-123-4567. */
export function formatThaiPhone(normalized: string): string {
  if (normalized.length === 10) return `${normalized.slice(0, 3)}-${normalized.slice(3, 6)}-${normalized.slice(6)}`;
  if (normalized.length === 9) return `${normalized.slice(0, 2)}-${normalized.slice(2, 5)}-${normalized.slice(5)}`;
  return normalized;
}
