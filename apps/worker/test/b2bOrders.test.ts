/** Orders and pricing trust the verified B2B status only (never a stale user_type). */
import { describe, expect, it } from 'vitest';
import type { OrderRow, UserRow } from '@datawan/shared';
import { createApp } from '../src/app';
import { lalamoveCardText } from '../src/line/flex/owner';
import { applyB2b, approveB2b, revokeB2b } from '../src/services/b2b';
import { findPostback, makeHarness, OWNER_AUTH, OWNER_TOKEN } from './harness';

const UID = 'u-customer';
const SHOP = 'Test Kitchen';
/* eslint-disable @typescript-eslint/no-explicit-any */

async function setup() {
  const h = makeHarness();
  await h.seedCosts();
  const app = createApp(h.deps);
  await h.customerText('เอากุ้งแม่น้ำเป็นๆ 2 โล ส่งพรุ่งนี้เช้านะคะ');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  const order = h.repo.orders[0]!;
  // 30-day purchase history for every product on the order
  const items = await h.repo.getItems(order.id);
  await h.repo.insertPriceHistory(
    items.filter((i) => i.product_id).map((i) => ({ product_id: i.product_id!, kind: 'sell' as const, unit_price_satang: 70000, source: 'owner_price' as never, user_id: order.user_id, order_id: null })),
  );
  const user = (await h.repo.getUser(order.user_id)) as UserRow;
  const view = async () => {
    const res = await app.request(`/api/owner/orders/${order.id}`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  };
  const apply = () =>
    applyB2b(h.deps, user, {
      businessName: SHOP, businessType: 'restaurant', addressText: '99 Test Road, Bangkok', lat: 13.7, lng: 100.5,
      deliveryWindow: '06:00-08:00', taxId: null, documentPaths: [],
    });
  return { h, order, user, view, apply };
}

describe('B2B orders use verified status only', () => {
  it('pending applicant: no anchor, no b2b badge', async () => {
    const { apply, view } = await setup();
    await apply();
    const v = await view();
    expect(v.b2bAnchorPriceSatang).toBeNull();
    expect(v.customer.b2b).toBeNull();
  });

  it('after approval: anchor present and badge shows the shop name and window', async () => {
    const { h, apply, view, order } = await setup();
    await apply();
    await approveB2b(h.deps, order.user_id, OWNER_AUTH, (await h.repo.getBusinessProfile(order.user_id))!.updated_at);
    const v = await view();
    expect(v.b2bAnchorPriceSatang).not.toBeNull();
    expect(v.customer.b2b).toEqual({ businessName: SHOP, deliveryWindow: '06:00-08:00' });
  });

  it('after revoke: the same open order loses badge and anchor', async () => {
    const { h, apply, view, order } = await setup();
    await apply();
    await approveB2b(h.deps, order.user_id, OWNER_AUTH, (await h.repo.getBusinessProfile(order.user_id))!.updated_at);
    expect((await view()).customer.b2b).not.toBeNull();
    await revokeB2b(h.deps, order.user_id, OWNER_AUTH, 'test reason', (await h.repo.getBusinessProfile(order.user_id))!.updated_at);
    const v = await view();
    expect(v.customer.b2b).toBeNull();
    expect(v.b2bAnchorPriceSatang).toBeNull();
  });

  it('a stale user_type=B2B without a verified profile gets no anchor', async () => {
    const { h, view, order } = await setup();
    h.repo.users.find((x) => x.id === order.user_id)!.user_type = 'B2B';
    expect((await view()).b2bAnchorPriceSatang).toBeNull();
  });
});

describe('lalamoveCardText delivery window', () => {
  const base = { code: 'A1', recipient_name: 'Test', recipient_phone: '0800000000', requested_delivery_at: null } as unknown as OrderRow;
  const user = (over: Partial<UserRow>) => ({ user_type: 'B2C', full_name: null, phone: null, default_delivery_window: null, ...over }) as UserRow;

  it('verified shop without requested time gets the standing window', () => {
    const t = lalamoveCardText(base, null, user({ user_type: 'B2B', default_delivery_window: '06:00-08:00' }));
    expect(t).toContain('เวลาส่งประจำ: 06:00-08:00 น.');
  });
  it('B2C customer does not', () => {
    expect(lalamoveCardText(base, null, user({ default_delivery_window: '06:00-08:00' }))).not.toContain('เวลาส่งประจำ');
  });
  it('an explicit requested time wins', () => {
    const o = { ...base, requested_delivery_at: '2026-11-28T00:00:00.000Z' } as OrderRow;
    const t = lalamoveCardText(o, null, user({ user_type: 'B2B', default_delivery_window: '06:00-08:00' }));
    expect(t).toContain('เวลาส่ง: ');
    expect(t).not.toContain('เวลาส่งประจำ');
  });
});
