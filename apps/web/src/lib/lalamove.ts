/**
 * Values for the 4 inputs on web.lalamove.com, exactly as each wants them (no labels/prefixes):
 *   pin     → destination search bar: "lat, lng" (6 decimals) drops the pin at the customer's spot
 *   name    → "ชื่อ"
 *   phone   → typed after Lalamove's fixed "+66" box: national number without the leading 0
 *   address → "เลขที่/ห้อง/ชั้น" details
 */
import { formatThaiPhone, normalizeThaiPhone, type OwnerOrderView } from '@datawan/shared';

export interface LalamoveFields {
  pin: string | null;
  mapUrl: string | null;
  name: string | null;
  /** Shown on screen, e.g. 093-329-3729. */
  phoneDisplay: string | null;
  /** Copied, e.g. 933293729 (pastes right after +66). */
  phoneForPlus66: string | null;
  address: string | null;
  /** "Copy all" fallback: the full card text. */
  all: string | null;
}

function coord(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function lalamoveFields(order: Pick<OwnerOrderView, 'delivery' | 'lalamoveCard'>): LalamoveFields {
  const d = order.delivery;
  const lat = coord(d.lat);
  const lng = coord(d.lng);
  const pin = lat !== null && lng !== null ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : null;
  const phone = d.recipientPhone ? normalizeThaiPhone(d.recipientPhone) : null;
  return {
    pin,
    mapUrl: order.lalamoveCard?.mapUrl ?? (pin ? `https://www.google.com/maps/search/?api=1&query=${lat!.toFixed(6)},${lng!.toFixed(6)}` : null),
    name: d.recipientName?.trim() || null,
    phoneDisplay: phone ? formatThaiPhone(phone) : null,
    phoneForPlus66: phone ? phone.slice(1) : null,
    address: d.addressText?.trim() || null,
    all: order.lalamoveCard?.text ?? null,
  };
}

/** Clipboard write with a fallback for browsers without the async Clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  return ok;
}
