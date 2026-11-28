import { describe, expect, it } from 'vitest';
import { buildPromptPayPayload } from '../src/services/promptpay';
import { findPostback, makeHarness, OWNER_AUTH } from './harness';

describe('E2E happy path — 9 steps through the signed webhook (mock AI)', () => {
  it('order → location → price → negotiate → ship → slip → paid → dispatch → delivered', async () => {
    const h = makeHarness();
    await h.seedCosts();
    const order = () => h.repo.orders[0]!;

    // 1. Order placement (casual Thai → mock parse → confirm card via reply)
    await h.customerText('เอากุ้งแม่น้ำเป็นๆ 2 โล กับหอยแครงโลนึง ส่งพรุ่งนี้เช้านะคะ');
    expect(order()).toMatchObject({ status: 'AWAITING_CONFIRMATION', code: 'A1', requested_delivery_at: '2027-01-15T07:00:00+07:00' });
    expect(h.repo.items.map((i) => [i.product_id, i.qty, i.prep_type])).toEqual([['p-kung', 2, 'live'], ['p-hoi', 1, 'any']]);
    expect(h.line.lastReplyText()).toContain('สรุปออเดอร์ A1');

    // 2. Confirm + delivery location (LINE pin)
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    expect(order().status).toBe('AWAITING_LOCATION');
    expect(h.line.lastReplyText()).toContain('"type":"location"');
    await h.customerLocation(13.7234, 100.4761, 'ตลาดสดธนบุรี');
    expect(order().status).toBe('AWAITING_PRICE');
    expect(h.notifier.alerts.at(-1)).toMatchObject({ kind: 'NEW_ORDER', code: 'A1', suggestedPriceSatang: 169000 }); // cost ฿1,350 × 1.25 = ฿1,687.50 → ฿1,690

    // 3. Owner prices via LINE: margin shown, push 1 of 3 (price quote; not present in LIFF)
    await h.ownerText('A1 1850 กุ้งได้ 2.1 กก.');
    expect(order()).toMatchObject({ status: 'PRICE_QUOTED', product_price_satang: 185000, price_note: 'กุ้งได้ 2.1 กก.' });
    expect(h.line.lastReplyText()).toContain('✅ A1 ราคา ฿1,850 | ต้นทุน ฿1,350 | กำไร +฿500 (27%) 🟢');
    expect(h.line.pushes).toHaveLength(1);

    // 4. Customer haggles in chat → owner accepts
    await h.customerText('1700 ได้ไหมคะ');
    expect(order().status).toBe('NEGOTIATING');
    expect(h.notifier.alerts.at(-1)).toMatchObject({ kind: 'COUNTER_OFFER', amountSatang: 170000, marginColor: 'GREEN' });
    await h.ownerText('A1 ok');
    expect(order()).toMatchObject({ status: 'AWAITING_SHIPPING_FEE', product_price_satang: 170000 });

    // 5–6. Shipping fee → total + payment window; Lalamove copy card for the owner; push 2 (total)
    await h.ownerText('A1 ship 120');
    expect(order()).toMatchObject({ status: 'AWAITING_PAYMENT', shipping_fee_satang: 12000, total_satang: 182000 });
    expect(order().payment_expires_at).toBe('2027-01-14T03:05:00.000Z'); // +45 min
    expect(h.line.lastReplyText()).toContain('Lalamove');
    expect(h.line.lastReplyText()).toContain('maps/search/?api=1\\u0026query=13.7234,100.4761'.replace('\\u0026', '&'));
    expect(h.line.pushes).toHaveLength(2); // push 2 of 3: total + PromptPay/slip card
    expect(JSON.stringify(h.line.pushes[1]!.messages)).toContain('PromptPay');
    expect(buildPromptPayPayload(h.deps.cfg.PROMPTPAY_ID, order().total_satang!)).toContain('54071820.00');

    // 7. Slip in chat (fallback) → mock read → code check PASS → PAYMENT_REVIEW (NOT paid)
    await h.customerImage('img-1', new Uint8Array(200).fill(9));
    expect(order().status).toBe('PAYMENT_REVIEW');
    expect(h.repo.payments[0]).toMatchObject({ check_result: 'PASS', amount_satang: 182000, confirmed_by: null });
    expect(order().paid_confirmed_by).toBeNull();

    // 7b. Owner confirms payment
    await h.ownerText('A1 paid');
    expect(order()).toMatchObject({ status: 'PAID', paid_confirmed_by: OWNER_AUTH });
    expect(h.repo.payments[0]!.confirmed_by).toBe(OWNER_AUTH);

    // 8. Dispatch with tracking link
    await h.ownerText('A1 track https://share.lalamove.com/abc123');
    expect(order()).toMatchObject({ status: 'DELIVERING', tracking_url: 'https://share.lalamove.com/abc123' });
    expect(h.line.pushes).toHaveLength(3); // push 3 of 3: Lalamove dispatched + tracking link
    expect(JSON.stringify(h.line.pushes[2]!.messages)).toContain('https://share.lalamove.com/abc123');
    // Exactly the 3 lifecycle pushes, once each and in order; the negotiation used none.
    expect(h.repo.events.filter((e) => e.event === 'PUSH_SENT').map((e) => (e.payload as { why: string }).why)).toEqual(['PRICE_READY', 'TOTAL_READY', 'TRACKING_LINK']);

    // 9. Delivered → stock deducted, sell price history, active order cleared
    await h.ownerText('A1 done');
    expect(order().status).toBe('DELIVERED');
    expect(h.repo.stockLogs.map((s) => [s.product_id, s.qty_delta, s.reason, s.created_by])).toEqual([
      ['p-kung', -2, 'sale', OWNER_AUTH],
      ['p-hoi', -1, 'sale', OWNER_AUTH],
    ]);
    expect(h.repo.priceHistory.filter((p) => p.kind === 'sell')).toHaveLength(2);
    expect(h.repo.users[0]!.active_order_id).toBeNull();

    // Audit trail: every status change recorded with the right actor
    const transitions = h.repo.events.filter((e) => e.to_status).map((e) => `${e.actor}:${e.event}`);
    expect(transitions).toEqual([
      'customer:CUSTOMER_CONFIRM', 'customer:LOCATION_SET', 'owner:OWNER_SET_PRICE', 'customer:CUSTOMER_COUNTER',
      'owner:OWNER_ACCEPT', 'owner:OWNER_SET_SHIPPING', 'customer:SLIP_UPLOADED', 'owner:OWNER_CONFIRM_PAYMENT',
      'owner:OWNER_DISPATCH', 'owner:OWNER_DELIVERED',
    ]);
    // LIFF got a realtime ping for every change, with no PII in the channel payload
    expect(h.realtime.sent.length).toBeGreaterThanOrEqual(10);
    expect(h.realtime.sent[0]!.channel).toMatch(/^order:[0-9a-f-]+:[0-9a-f]{32}$/);
  });
});
