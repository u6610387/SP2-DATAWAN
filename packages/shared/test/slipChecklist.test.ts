/** Owner slip checklist rules (manual slip mode): flags only, the owner decides. */
import { describe, expect, it } from 'vitest';
import { ownerSlipChecks } from '../src/slipChecklist';

const created = '2026-11-28T16:39:13.000Z';
const now = new Date('2026-11-28T16:45:00.000Z');
const ctx = { totalSatang: 100, orderCreatedAt: created, now };
const rules = (c: ReturnType<typeof ownerSlipChecks>) => c.map((x) => `${x.rule}:${x.result}`);

describe('ownerSlipChecks', () => {
  it('a matching slip passes all three', () => {
    expect(rules(ownerSlipChecks({ amountSatang: 100, receiverIsShop: true, slipTime: '2026-11-28T23:41:00+07:00' }, ctx))).toEqual(['AMOUNT:PASS', 'RECEIVER:PASS', 'TIME:PASS']);
  });

  it('production A19 pattern: 105 THB to another shop, before the order → three FAILs', () => {
    const c = ownerSlipChecks({ amountSatang: 10500, receiverIsShop: false, slipTime: '2026-11-28T13:24:00+07:00' }, ctx);
    expect(rules(c)).toEqual(['AMOUNT:FAIL', 'RECEIVER:FAIL', 'TIME:FAIL']);
    expect(c[0]!.detail).toContain('฿105');
    expect(c[0]!.detail).toContain('฿1');
  });

  it('time: same minute as the order is fine (slips show minutes); a minute earlier or >10 min ahead fails', () => {
    const t = (slipTime: string) => ownerSlipChecks({ amountSatang: 100, receiverIsShop: true, slipTime }, ctx)[2]!.result;
    expect(t('2026-11-28T23:39:00+07:00')).toBe('PASS'); // 16:39 UTC, order at 16:39:13
    expect(t('2026-11-28T23:38:00+07:00')).toBe('FAIL');
    expect(t('2026-11-28T23:54:00+07:00')).toBe('PASS'); // 9 min ahead: phone clock skew
    expect(t('2026-11-28T23:56:00+07:00')).toBe('FAIL');
    expect(t('not a time')).toBe('FAIL');
  });

  it('amount: exact satang match only; no total to compare is a FAIL', () => {
    expect(ownerSlipChecks({ amountSatang: 101, receiverIsShop: true, slipTime: now.toISOString() }, ctx)[0]!.result).toBe('FAIL');
    expect(ownerSlipChecks({ amountSatang: 100, receiverIsShop: true, slipTime: now.toISOString() }, { ...ctx, totalSatang: null })[0]!.result).toBe('FAIL');
  });
});
