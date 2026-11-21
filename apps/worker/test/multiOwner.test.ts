import { describe, expect, it } from 'vitest';
import { isOwnerLineUser, loadConfig } from '../src/env';
import { CUSTOMER_LINE, makeHarness, OWNER_LINE, OWNER_LINE_2 } from './harness';

const base = {
  LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', PROMPTPAY_ID: '0812345678',
  OWNER_AUTH_USER_ID: '11111111-1111-4111-8111-111111111111',
};
const A = 'U1111111111111111111111111111aaaa';
const B = 'U2222222222222222222222222222bbbb';

describe('LINE_OWNER_USER_ID (comma-separated)', () => {
  it('parses a single ID', () => {
    expect(loadConfig({ ...base, LINE_OWNER_USER_ID: A }).LINE_OWNER_USER_ID).toEqual([A]);
  });
  it('parses, trims and de-duplicates multiple IDs', () => {
    const cfg = loadConfig({ ...base, LINE_OWNER_USER_ID: ` ${A} , ${B},,${A}` });
    expect(cfg.LINE_OWNER_USER_ID).toEqual([A, B]);
    expect(isOwnerLineUser(cfg, A)).toBe(true);
    expect(isOwnerLineUser(cfg, B)).toBe(true);
    expect(isOwnerLineUser(cfg, 'Uffffffffffffffffffffffffffffffff')).toBe(false);
    expect(isOwnerLineUser(cfg, undefined)).toBe(false);
  });
  it('rejects empty or malformed values', () => {
    expect(() => loadConfig({ ...base, LINE_OWNER_USER_ID: ' , ' })).toThrow(/LINE_OWNER_USER_ID/);
    expect(() => loadConfig({ ...base, LINE_OWNER_USER_ID: `${A},not-an-id` })).toThrow(/LINE_OWNER_USER_ID/);
  });
});

describe('webhook routes every configured owner to the owner handler', () => {
  const text = (h: ReturnType<typeof makeHarness>, userId: string, t: string) =>
    h.send(userId, { type: 'message', message: { id: `m-${t}-${userId}`, type: 'text', quoteToken: 'q', text: t } });

  it('second owner gets the same owner reply as the first; a customer does not', async () => {
    const h = makeHarness();
    await text(h, OWNER_LINE, 'list');
    const ownerReply = h.line.lastReplyText();
    await text(h, OWNER_LINE_2, 'list');
    expect(h.line.lastReplyText()).toBe(ownerReply);
    await text(h, CUSTOMER_LINE, 'list');
    expect(h.line.lastReplyText()).not.toBe(ownerReply);
  });
});
