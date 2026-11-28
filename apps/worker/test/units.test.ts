import { describe, expect, it } from 'vitest';
import { parseOwnerCommand } from '../src/line/ownerCommands';
import { dailyBudgetRemaining, decidePush, LIFECYCLE_PUSHES, PUSH_PRIORITY, quotaMode } from '../src/line/quota';
import { parseMapsLink } from '../src/services/location';
import { buildPromptPayPayload } from '../src/services/promptpay';
import { checkSlip, receiverMatches, SLIP_MANUAL_REVIEW_DETAIL } from '../src/services/slipCheck';
import { daysLeftInMonth, nextBangkokMonthStart } from '../src/util/time';

describe('owner command parser', () => {
  it.each([
    ['A12 1850', { kind: 'price', code: 'A12', amountSatang: 185000, note: null }],
    ['a12 1,850 ปูได้ 1.2 กก.', { kind: 'price', code: 'A12', amountSatang: 185000, note: 'ปูได้ 1.2 กก.' }],
    ['1850', { kind: 'price', code: null, amountSatang: 185000 }],
    ['A12 ship 120', { kind: 'ship', code: 'A12', feeSatang: 12000 }],
    ['ship 120', { kind: 'ship', code: null, feeSatang: 12000 }],
    ['A12 track https://share.lalamove.com/x', { kind: 'track', url: 'https://share.lalamove.com/x' }],
    ['A12 ok', { kind: 'ok', code: 'A12' }],
    ['A12 hold', { kind: 'hold' }],
    ['A12 1700', { kind: 'price', amountSatang: 170000 }],
    ['A12 paid', { kind: 'paid', overrideReason: null }],
    ['A12 paid! โอนสองครั้ง', { kind: 'paid', overrideReason: 'โอนสองครั้ง' }],
    ['A12 done', { kind: 'done' }],
    ['A12 note ปูหมด มีกุ้งแม่น้ำ 900', { kind: 'note', text: 'ปูหมด มีกุ้งแม่น้ำ 900' }],
    ['list', { kind: 'list' }],
    ['?', { kind: 'list' }],
    ['A๑๒ ๑๘๕๐', { kind: 'price', code: 'A12', amountSatang: 185000 }],
    ['สวัสดี', { kind: 'unknown' }],
    ['A12 0', { kind: 'unknown' }],
  ])('%s', (input, expected) => {
    expect(parseOwnerCommand(input)).toMatchObject(expected);
  });
});

describe('quota guard decisions', () => {
  const base = { priority: 'P1' as const, alreadySent: false, dailyReserve: 3, customerPresent: false, customerActive: true, mode: 'NORMAL' as const, orderPushCount: 0, maxPerOrder: 3, dailyRemaining: 5 };
  it('order of checks', () => {
    expect(decidePush(base)).toEqual({ send: true });
    expect(decidePush({ ...base, customerPresent: true })).toMatchObject({ reason: 'PRESENT' });
    expect(decidePush({ ...base, mode: 'QUOTA_SAVER' })).toMatchObject({ reason: 'QUOTA_SAVER' });
    expect(decidePush({ ...base, mode: 'WARNING', priority: 'P2' })).toMatchObject({ reason: 'WARNING_P2' });
    expect(decidePush({ ...base, mode: 'WARNING' })).toEqual({ send: true });
    expect(decidePush({ ...base, orderPushCount: 3 })).toMatchObject({ reason: 'ORDER_CAP' });
    expect(decidePush({ ...base, dailyRemaining: 0 })).toMatchObject({ reason: 'DAILY_BUDGET' });
    expect(decidePush({ ...base, customerActive: false })).toMatchObject({ reason: 'INACTIVE_USER' });
  });
  it('one push per reason per order, before anything else but an inactive user', () => {
    expect(decidePush({ ...base, alreadySent: true })).toMatchObject({ reason: 'ALREADY_SENT' });
    expect(decidePush({ ...base, alreadySent: true, customerPresent: true })).toMatchObject({ reason: 'ALREADY_SENT' });
    expect(decidePush({ ...base, alreadySent: true, customerActive: false })).toMatchObject({ reason: 'INACTIVE_USER' });
  });
  it('tight daily budget: total + tracking (P1) keep the reserve, the price quote (P2) does not', () => {
    expect(decidePush({ ...base, priority: 'P2', dailyRemaining: 4 })).toEqual({ send: true });
    expect(decidePush({ ...base, priority: 'P2', dailyRemaining: 3 })).toMatchObject({ reason: 'DAILY_RESERVE' });
    expect(decidePush({ ...base, priority: 'P1', dailyRemaining: 1 })).toEqual({ send: true });
    expect(decidePush({ ...base, priority: 'P1', dailyRemaining: 0 })).toMatchObject({ reason: 'DAILY_BUDGET' });
  });
  it('lifecycle priorities: only the price quote yields when quota is tight', () => {
    expect(LIFECYCLE_PUSHES).toEqual(['PRICE_READY', 'TOTAL_READY', 'TRACKING_LINK']);
    expect(PUSH_PRIORITY).toEqual({ PRICE_READY: 'P2', TOTAL_READY: 'P1', TRACKING_LINK: 'P1' });
  });
  it('thresholds 240 / 285 of 300', () => {
    const cfg = { QUOTA_WARN_RATIO: 0.8, QUOTA_SAVER_RATIO: 0.95 };
    expect(quotaMode(239, 300, cfg)).toBe('NORMAL');
    expect(quotaMode(240, 300, cfg)).toBe('WARNING');
    expect(quotaMode(285, 300, cfg)).toBe('QUOTA_SAVER');
  });
  it('daily pacing spreads the remaining budget', () => {
    // 285 ceiling, 0 used, 31 days → 9/day
    expect(dailyBudgetRemaining({ used: 0, limit: 300, saverRatio: 0.95, pushesToday: 0, daysLeft: 31 })).toBe(9);
    expect(dailyBudgetRemaining({ used: 9, limit: 300, saverRatio: 0.95, pushesToday: 9, daysLeft: 31 })).toBe(0);
  });
  it('Bangkok month boundaries', () => {
    const now = new Date('2027-01-31T18:00:00Z'); // 1 Feb 01:00 Bangkok
    expect(nextBangkokMonthStart(now).toISOString()).toBe('2027-02-28T17:00:00.000Z');
    expect(daysLeftInMonth(new Date('2027-01-14T02:00:00Z'))).toBe(18);
  });
});

describe('PromptPay payload', () => {
  function crc16(s: string): string {
    let crc = 0xffff;
    for (const ch of s) {
      crc ^= ch.charCodeAt(0) << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
  it('has the exact amount and a valid CRC', () => {
    const p = buildPromptPayPayload('081-234-5678', 182000);
    expect(p.startsWith('000201010212')).toBe(true); // dynamic QR
    expect(p).toContain('0066812345678');
    expect(p).toContain('54071820.00');
    expect(p.slice(-4)).toBe(crc16(p.slice(0, -4)));
    expect(() => buildPromptPayPayload('0812345678', 0)).toThrow();
  });
});

describe('slip checks', () => {
  const ctx = { order: { total_satang: 182000, quoted_at: '2027-01-14T02:00:00Z', status: 'AWAITING_PAYMENT' as const }, receiverName: 'ดา ทะวัน', promptpayId: '0812345678', referenceAlreadyUsed: false, now: new Date('2027-01-14T02:30:00Z') };
  const slip = { is_slip: true, bank: 'KBANK', amount: 1820, date_time: '2027-01-14T09:25:00+07:00', receiver_name_or_id: 'นาง ดา ท***', reference_no: 'R1' };
  it('PASS when everything matches; still requires the owner', () => {
    expect(checkSlip(slip, ctx).result).toBe('PASS');
  });
  it('FAIL on amount, receiver or reused reference; WARN when unreadable', () => {
    expect(checkSlip({ ...slip, amount: 1800 }, ctx).result).toBe('FAIL');
    expect(checkSlip({ ...slip, receiver_name_or_id: 'นาย สมชาย ใ***' }, ctx).result).toBe('FAIL');
    expect(checkSlip(slip, { ...ctx, referenceAlreadyUsed: true }).result).toBe('FAIL');
    expect(checkSlip({ ...slip, reference_no: null }, ctx).result).toBe('WARN');
    expect(checkSlip(null, ctx).result).toBe('WARN');
  });
  // Production runs GEMINI_SLIP_MODE=manual (CLAUDE.md D1): no AI read is attempted, so the
  // owner must not be told the slip was "unreadable" — it was never read on purpose.
  it('manual slip mode: WARN with a "check it yourself" message, not "unreadable"', () => {
    const manual = checkSlip(null, { ...ctx, manualReview: true });
    expect(manual.result).toBe('WARN');
    expect(manual.checks).toEqual([{ rule: 'READABLE', result: 'WARN', detail: SLIP_MANUAL_REVIEW_DETAIL }]);
    expect(SLIP_MANUAL_REVIEW_DETAIL).not.toContain('อ่านสลิปไม่ได้');
    // a real read failure keeps the original wording
    expect(checkSlip(null, ctx).checks[0]!.detail).toBe('อ่านสลิปไม่ได้ ให้เจ้าของร้านตรวจจากรูป');
  });
  it('receiver match by masked name or last 4 digits', () => {
    expect(receiverMatches('xxx-x-x5678-x', '', '0812345678')).toBe(true);
    expect(receiverMatches('ดา ท***', 'ดา ทะวัน', '0899999999')).toBe(true);
    expect(receiverMatches('สม ใ***', 'ดา ทะวัน', '0899999999')).toBe(false);
  });
});

describe('maps links', () => {
  it('extracts coordinates', () => {
    expect(parseMapsLink('https://www.google.com/maps/@13.7234,100.4761,17z')).toEqual({ lat: 13.7234, lng: 100.4761 });
    expect(parseMapsLink('https://maps.google.com/?q=13.7,100.5')).toEqual({ lat: 13.7, lng: 100.5 });
    expect(parseMapsLink('13.7234, 100.4761')).toEqual({ lat: 13.7234, lng: 100.4761 });
    expect(parseMapsLink('https://maps.app.goo.gl/abc')).toBeNull();
  });
});
