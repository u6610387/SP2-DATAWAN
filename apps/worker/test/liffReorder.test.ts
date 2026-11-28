/** LIFF order history + one-tap reorder: route-level on the in-memory repo. */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { findPostback, LIFF_TOKEN, makeHarness } from './harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

const AUTH = { Authorization: `Bearer ${LIFF_TOKEN}`, 'Content-Type': 'application/json' };
const post = (body?: unknown, ifMatch?: number) => ({
  method: 'POST',
  headers: { ...AUTH, ...(ifMatch !== undefined ? { 'If-Match': String(ifMatch) } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

/** Chat order → confirm → location → priced, then marked DELIVERED (as if the full flow ran). */
async function deliveredOrder(h: ReturnType<typeof makeHarness>) {
  await h.seedCosts();
  await h.customerText('เอากุ้งแม่น้ำเป็นๆ 2 โล กับหอยแครงโลนึง ส่งพรุ่งนี้เช้านะคะ');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7234, 100.4761, 'ตลาดสดธนบุรี');
  await h.ownerText('A1 1850');
  const o = h.repo.orders[0]!;
  o.status = 'DELIVERED';
  o.total_satang = 197000;
  o.delivered_at = h.clock.now().toISOString();
  return o;
}

describe('LIFF order history + reorder', () => {
  it('lists only the caller\'s own orders, by scope', async () => {
    const h = makeHarness();
    const src = await deliveredOrder(h);
    const app = createApp(h.deps);

    let res = await app.request('/api/liff/orders?scope=history', { headers: AUTH });
    expect(res.status).toBe(200);
    const list = await jsonOf(res);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: src.id, code: src.code, status: 'DELIVERED', itemCount: 2, totalSatang: 197000, reorderable: true });
    expect(list[0].itemsPreview[0]).toMatchObject({ name: 'กุ้งแม่น้ำ', qty: 2, unit: 'kg' });
    expect(JSON.stringify(list)).not.toMatch(/cost|margin/i);

    res = await app.request('/api/liff/orders?scope=open', { headers: AUTH });
    expect(await jsonOf(res)).toEqual([]);
    res = await app.request('/api/liff/orders?scope=bogus', { headers: AUTH });
    expect(res.status).toBe(400);

    h.auth.liffUsers.set('other-token', 'Uother0000000000000000000000000000');
    res = await app.request('/api/liff/orders?scope=history', { headers: { Authorization: 'Bearer other-token' } });
    expect(await jsonOf(res)).toEqual([]);
  });

  it('reorder copies items with no prices and no AI call, then confirm + same address reaches the shop', async () => {
    const h = makeHarness();
    const src = await deliveredOrder(h);
    const app = createApp(h.deps);
    const srcItems = await h.repo.getItems(src.id);
    h.line.pushes.length = 0;
    h.notifier.alerts.length = 0;

    let res = await app.request('/api/liff/reorder', post({ sourceOrderId: src.id }));
    expect(res.status).toBe(201);
    const view = await jsonOf(res);
    expect(view).toMatchObject({ status: 'AWAITING_CONFIRMATION', sourceOrderId: src.id, productPriceSatang: null, totalSatang: null, skippedItems: [], deduped: false });
    expect(view.items.map((i: { productId: string; qty: number; prepType: string }) => [i.productId, i.qty, i.prepType])).toEqual(
      srcItems.map((i) => [i.product_id, i.qty, i.prep_type]),
    );
    const order = h.repo.orders.find((o) => o.id === view.id)!;
    expect(order).toMatchObject({ channel: 'liff', ai_parse: null, needs_owner_review: false, product_price_satang: null });
    expect(h.repo.users[0]!.active_order_id).toBe(order.id);
    expect(h.line.pushes).toHaveLength(0); // no LINE push quota used

    // Double tap: the same draft comes back.
    res = await app.request('/api/liff/reorder', post({ sourceOrderId: src.id }));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ id: order.id, deduped: true });
    expect(h.repo.orders).toHaveLength(2);

    // Stale If-Match is refused.
    res = await app.request(`/api/liff/orders/${order.id}/confirm`, post(undefined, order.version + 5));
    expect(res.status).toBe(409);

    res = await app.request(`/api/liff/orders/${order.id}/confirm`, post(undefined, view.version));
    expect(res.status).toBe(200);
    const confirmed = await jsonOf(res);
    expect(confirmed.status).toBe('AWAITING_LOCATION');
    expect(confirmed.reuseAddress).toMatchObject({ id: src.address_id, addressText: 'ตลาดสดธนบุรี' });

    res = await app.request(`/api/liff/orders/${order.id}/location`, post({ addressId: src.address_id }, confirmed.version));
    expect(res.status).toBe(200);
    const located = await jsonOf(res);
    expect(located).toMatchObject({ status: 'AWAITING_PRICE', reuseAddress: null });
    expect(located.delivery).toMatchObject({ hasLocation: true, needsRecipient: false });
    expect(h.notifier.alerts.map((a) => a.kind)).toEqual(['NEW_ORDER']);
    expect(h.line.pushes).toHaveLength(0);

    const events = await h.repo.listOrderEvents(order.id);
    expect(events.map((e) => `${e.actor}:${e.event}`)).toEqual([
      'customer:ORDER_CREATED', 'customer:CUSTOMER_CONFIRM', 'customer:LOCATION_SET', 'customer:ADDRESS_REUSED',
    ]);
  });

  it('skips products that are no longer sold and flags the order for the owner', async () => {
    const h = makeHarness();
    const src = await deliveredOrder(h);
    h.repo.products.find((p) => p.id === 'p-hoi')!.is_active = false;
    const res = await createApp(h.deps).request('/api/liff/reorder', post({ sourceOrderId: src.id }));
    expect(res.status).toBe(201);
    const view = await jsonOf(res);
    expect(view.items).toHaveLength(1);
    expect(view.skippedItems).toHaveLength(1);
    expect(h.repo.orders.find((o) => o.id === view.id)!.needs_owner_review).toBe(true);

    h.repo.products.find((p) => p.id === 'p-kung')!.is_active = false;
    const list = await jsonOf(await createApp(h.deps).request('/api/liff/orders?scope=history', { headers: AUTH }));
    expect(list[0].reorderable).toBe(false);
  });

  it('refuses another customer\'s order, a non-delivered order, nothing left to copy, and a foreign address', async () => {
    const h = makeHarness();
    const src = await deliveredOrder(h);
    const app = createApp(h.deps);

    h.auth.liffUsers.set('other-token', 'Uother0000000000000000000000000000');
    let res = await app.request('/api/liff/reorder', { ...post({ sourceOrderId: src.id }), headers: { Authorization: 'Bearer other-token' } });
    expect(res.status).toBe(404);

    res = await app.request('/api/liff/reorder', post({ sourceOrderId: 'not-a-uuid' }));
    expect(res.status).toBe(400);

    src.status = 'CANCELLED';
    res = await app.request('/api/liff/reorder', post({ sourceOrderId: src.id }));
    expect(res.status).toBe(409);
    src.status = 'DELIVERED';

    for (const p of h.repo.products) p.is_active = false;
    res = await app.request('/api/liff/reorder', post({ sourceOrderId: src.id }));
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.code).toBe('NOTHING_TO_REORDER');
    for (const p of h.repo.products) p.is_active = true;

    // The other customer's address can't be attached to my order.
    const mine = await jsonOf(await app.request('/api/liff/reorder', post({ sourceOrderId: src.id })));
    const confirmed = await jsonOf(await app.request(`/api/liff/orders/${mine.id}/confirm`, post()));
    const foreign = await h.repo.insertAddress({ user_id: 'u-someone-else', recipient_name: 'x', recipient_phone: '0811111111', address_text: 'ที่อื่น', lat: 1, lng: 1, source: 'line_pin' });
    res = await app.request(`/api/liff/orders/${mine.id}/location`, post({ addressId: foreign.id }, confirmed.version));
    expect(res.status).toBe(404);
    expect(h.repo.orders.find((o) => o.id === mine.id)!.address_id).toBeNull();
  });

  it('holds the order for the recipient card when neither the address nor the profile has a recipient', async () => {
    const h = makeHarness();
    const src = await deliveredOrder(h);
    const app = createApp(h.deps);
    const user = h.repo.users[0]!;
    user.full_name = null;
    user.phone = null;
    h.repo.addresses.find((a) => a.id === src.address_id)!.recipient_name = null;
    h.notifier.alerts.length = 0;

    const mine = await jsonOf(await app.request('/api/liff/reorder', post({ sourceOrderId: src.id })));
    const confirmed = await jsonOf(await app.request(`/api/liff/orders/${mine.id}/confirm`, post()));
    const res = await app.request(`/api/liff/orders/${mine.id}/location`, post({ addressId: src.address_id }));
    const held = await jsonOf(res);
    expect(confirmed.status).toBe('AWAITING_LOCATION');
    expect(held).toMatchObject({ status: 'AWAITING_LOCATION', delivery: { hasLocation: true, needsRecipient: true } });
    expect(h.notifier.alerts).toHaveLength(0);
  });
});
