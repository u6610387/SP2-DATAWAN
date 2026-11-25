/**
 * POST /api/owner/orders/:id/cancel — API_AND_AI_CONTRACTS.md §2.3.
 *
 * Regression for production order A2: it sat in AWAITING_PRICE after the customer started a
 * newer order (so it was no longer their active order). Nothing could cancel it:
 *   - the customer's LINE `cancel` postback only targets their active order;
 *   - ABANDON_TIMEOUT deliberately never cancels AWAITING_PRICE (owner offline ≠ abandon);
 *   - OWNER_CANCEL existed in the state machine but no endpoint or button fired it.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { applyEvent } from '../src/services/orders';
import { findPostback, makeHarness, OWNER_AUTH, OWNER_TOKEN } from './harness';

function post(body: unknown, extra: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  };
}

async function orderAwaitingPrice() {
  const h = makeHarness();
  await h.customerText('หอยแครง 2 โล');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7234, 100.4761, 'ตลาดสดธนบุรี');
  const order = h.repo.orders.at(-1)!;
  expect(order.status).toBe('AWAITING_PRICE');
  return { h, order, app: createApp(h.deps) };
}

describe('owner cancel', () => {
  it('cancels an AWAITING_PRICE order that is no longer the customer\'s active order (A2)', async () => {
    const { h, order, app } = await orderAwaitingPrice();
    await h.repo.setActiveOrder(order.user_id, null); // customer moved on to a newer order
    const pushesBefore = h.line.pushes.length;

    const res = await app.request(`/api/owner/orders/${order.id}/cancel`, post({ reason: 'test order' }, { 'If-Match': String(order.version) }));
    expect(res.status).toBe(200);
    const view = (await res.json()) as { status: string };
    expect(view.status).toBe('CANCELLED');

    const row = h.repo.orders.find((o) => o.id === order.id)!;
    expect(row.status).toBe('CANCELLED');
    expect(row.cancel_reason).toBe('owner: test order');
    expect(row.cancelled_at).not.toBeNull();

    const ev = h.repo.events.filter((e) => e.order_id === order.id && e.event === 'OWNER_CANCEL');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor: 'owner', from_status: 'AWAITING_PRICE', to_status: 'CANCELLED' });
    expect(ev[0]!.payload).toMatchObject({ reason: 'test order', owner_id: OWNER_AUTH });

    expect(h.line.pushes.length).toBe(pushesBefore); // no LINE push spent on a cancel
  });

  it('cancels an empty NEEDS_REVIEW order and clears it as the customer\'s active order', async () => {
    const h = makeHarness();
    await h.customerText('กุ้ง 2 โล'); // no matching product → 0 items, needs_owner_review
    const order = h.repo.orders.at(-1)!;
    expect(h.repo.items.filter((i) => i.order_id === order.id)).toHaveLength(0);
    expect(order.needs_owner_review).toBe(true);
    expect((await h.repo.getUser(order.user_id))!.active_order_id).toBe(order.id);

    const res = await createApp(h.deps).request(`/api/owner/orders/${order.id}/cancel`, post({ reason: 'empty order' }));
    expect(res.status).toBe(200);
    expect(h.repo.orders.find((o) => o.id === order.id)!.status).toBe('CANCELLED');
    expect((await h.repo.getUser(order.user_id))!.active_order_id).toBeNull();
  });

  it('leaves another active order alone', async () => {
    const { h, order, app } = await orderAwaitingPrice();
    const other = 'some-other-order-id';
    await h.repo.setActiveOrder(order.user_id, other);
    await app.request(`/api/owner/orders/${order.id}/cancel`, post({ reason: 'x' }));
    expect((await h.repo.getUser(order.user_id))!.active_order_id).toBe(other);
  });

  it('refuses after payment is confirmed (409) and needs a reason (400)', async () => {
    const { h, order, app } = await orderAwaitingPrice();
    expect((await app.request(`/api/owner/orders/${order.id}/cancel`, post({}))).status).toBe(400);
    expect((await app.request(`/api/owner/orders/${order.id}/cancel`, post({ reason: '   ' }))).status).toBe(400);

    // Force the order to PAID through the machine's owner path to check the guard.
    let o = h.repo.orders.find((x) => x.id === order.id)!;
    for (const [ev, patch] of [
      ['OWNER_SET_PRICE', { product_price_satang: 30000 }],
      ['CUSTOMER_ACCEPT', {}],
      ['OWNER_SET_SHIPPING', { shipping_fee_satang: 5000 }],
      ['SLIP_UPLOADED', {}],
      ['OWNER_CONFIRM_PAYMENT', { paid_at: '2027-01-14T03:00:00Z', paid_confirmed_by: OWNER_AUTH }],
    ] as const) {
      const actor = ev.startsWith('OWNER') ? 'owner' : 'customer';
      const r = await applyEvent(h.deps, o, ev, actor, patch);
      if (!r.ok) throw new Error(`${ev} failed: ${r.reason}`);
      o = r.order;
    }
    expect(o.status).toBe('PAID');
    const res = await app.request(`/api/owner/orders/${order.id}/cancel`, post({ reason: 'too late' }));
    expect(res.status).toBe(409);
    expect(h.repo.orders.find((x) => x.id === order.id)!.status).toBe('PAID');
  });

  it('rejects a stale If-Match without changing the order', async () => {
    const { h, order, app } = await orderAwaitingPrice();
    const res = await app.request(`/api/owner/orders/${order.id}/cancel`, post({ reason: 'x' }, { 'If-Match': '1' }));
    expect(res.status).toBe(409);
    expect(h.repo.orders.find((o) => o.id === order.id)!.status).toBe('AWAITING_PRICE');
  });
});
