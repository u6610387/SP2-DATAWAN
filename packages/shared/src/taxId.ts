/**
 * Thai juristic-person / personal Tax ID (13 digits) checksum.
 * sum(d[i] * (13 - i)) for i in 0..11; check = (11 - sum % 11) % 10 must equal d[12].
 * A pass only means "well-formed"; the owner still decides (CLAUDE.md §3.1).
 */
export function isValidThaiTaxId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}
