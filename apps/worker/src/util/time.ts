/** Asia/Bangkok helpers (UTC+7, no DST). Store UTC, compute "today"/"month" in Bangkok. */
const BKK_MS = 7 * 3600_000;

export function bangkokDate(now: Date): string {
  return new Date(now.getTime() + BKK_MS).toISOString().slice(0, 10);
}
/** First day of the Bangkok month, e.g. '2027-01-01' (quota_logs.month). */
export function bangkokMonthStart(now: Date): string {
  return `${bangkokDate(now).slice(0, 7)}-01`;
}
/** UTC instant of 00:00 Bangkok today. */
export function startOfBangkokDay(now: Date): Date {
  return new Date(Date.parse(`${bangkokDate(now)}T00:00:00+07:00`));
}
/** UTC instant of 00:00 Bangkok on the 1st of next month (quota reset). */
export function nextBangkokMonthStart(now: Date): Date {
  const [y, m] = bangkokDate(now).split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return new Date(Date.parse(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+07:00`));
}
/** Days left in the Bangkok month including today (≥ 1). */
export function daysLeftInMonth(now: Date): number {
  return Math.max(1, Math.ceil((nextBangkokMonthStart(now).getTime() - startOfBangkokDay(now).getTime()) / 86_400_000));
}
/** "14:05" in Bangkok time. */
export function bangkokHHMM(iso: string): string {
  return new Date(Date.parse(iso) + BKK_MS).toISOString().slice(11, 16);
}
export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}
