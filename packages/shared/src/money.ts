/**
 * Money helpers. All amounts are integer satang (฿1 = 100 satang).
 * Never do money math in floats outside these helpers.
 */
import type { MarginColor } from './contracts/views';

export function bahtToSatang(baht: number): number {
  if (!Number.isFinite(baht)) throw new RangeError(`invalid baht amount: ${baht}`);
  return Math.round(baht * 100);
}

export function satangToBaht(satang: number): number {
  return satang / 100;
}

/** ฿1,850 or ฿1,850.50 (decimals only when needed). */
export function formatTHB(satang: number): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  const baht = Math.floor(abs / 100);
  const st = abs % 100;
  const bahtStr = baht.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}฿${bahtStr}${st ? '.' + st.toString().padStart(2, '0') : ''}`;
}

export interface Margin {
  marginSatang: number | null;
  /** 0.23 = 23% of the offered price. */
  marginPct: number | null;
  color: MarginColor;
}

/**
 * margin = offer − Σ cost. GREY when any item cost is unknown.
 * PROJECT_SPEC.md §4.2
 */
export function computeMargin(offerSatang: number, itemCostsSatang: (number | null)[]): Margin {
  if (itemCostsSatang.length === 0 || itemCostsSatang.some((c) => c === null)) {
    return { marginSatang: null, marginPct: null, color: 'GREY' };
  }
  const cost = (itemCostsSatang as number[]).reduce((a, b) => a + b, 0);
  const margin = offerSatang - cost;
  return {
    marginSatang: margin,
    marginPct: offerSatang > 0 ? margin / offerSatang : null,
    color: margin >= 0 ? 'GREEN' : 'RED',
  };
}

/** Round up to the next ฿10 (in satang). */
export function roundUpTo10Baht(satang: number): number {
  return Math.ceil(satang / 1000) * 1000;
}

/** cost × qty × (1 + markup), rounded up to ฿10. PROJECT_SPEC.md §4.1 */
export function suggestedPrice(totalCostSatang: number, markup: number): number {
  return roundUpTo10Baht(Math.round(totalCostSatang * (1 + markup)));
}

/** Multiply a per-unit satang price by a (possibly fractional) quantity. */
export function lineAmount(unitSatang: number, qty: number): number {
  return Math.round(unitSatang * qty);
}
