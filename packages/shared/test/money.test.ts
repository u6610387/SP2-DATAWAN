import { describe, expect, it } from 'vitest';
import { bahtToSatang, computeMargin, formatTHB, suggestedPrice } from '../src/money';

describe('money', () => {
  it('converts and formats', () => {
    expect(bahtToSatang(1970.1)).toBe(197010);
    expect(formatTHB(185000)).toBe('฿1,850');
    expect(formatTHB(185050)).toBe('฿1,850.50');
    expect(formatTHB(-43000)).toBe('-฿430');
  });
  it('margin colours', () => {
    expect(computeMargin(185000, [100000, 42000])).toMatchObject({ marginSatang: 43000, color: 'GREEN' });
    expect(computeMargin(100000, [120000])).toMatchObject({ marginSatang: -20000, color: 'RED' });
    expect(computeMargin(100000, [50000, null]).color).toBe('GREY');
  });
  it('suggested price rounds up to ฿10', () => {
    expect(suggestedPrice(142000, 0.25)).toBe(178000); // 1775 → 1780
  });
});
