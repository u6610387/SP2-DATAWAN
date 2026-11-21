/**
 * LINE_OWNER_USER_ID accepts a comma-separated list (owner may use more than one LINE
 * account/device). Both configured IDs must route to the owner command handler, not the
 * customer order-parsing flow.
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, OWNER_LINE, OWNER_LINE_2 } from './harness';

describe('multi-owner LINE_OWNER_USER_ID routing', () => {
  it('routes the primary owner id to the owner command handler', async () => {
    const h = makeHarness();
    await h.ownerText('?');
    expect(h.line.lastReplyText()).toContain('ไม่มีออเดอร์ค้าง');
  });

  it('routes the second owner id to the owner command handler, same as the first', async () => {
    const h = makeHarness();
    await h.ownerText2('?');
    expect(h.line.lastReplyText()).toContain('ไม่มีออเดอร์ค้าง');
    // Owner "list" command never creates an order; confirms it did not fall through to customer parsing.
    expect(await h.repo.listOpenOrders()).toHaveLength(0);
  });

  it('still treats an unconfigured LINE userId as a customer', async () => {
    const h = makeHarness();
    await h.send('Ustranger000000000000000000000000', {
      type: 'message',
      message: { id: 'm-stranger', type: 'text', quoteToken: 'q', text: '?' },
    });
    // A stranger's "?" is routed as a customer message, never the owner "list open orders" reply.
    expect(h.line.lastReplyText()).not.toContain('ไม่มีออเดอร์ค้าง');
  });

  it('parses the config as a list containing both owner ids', () => {
    const h = makeHarness();
    expect(h.deps.cfg.LINE_OWNER_USER_ID).toEqual([OWNER_LINE, OWNER_LINE_2]);
  });
});
