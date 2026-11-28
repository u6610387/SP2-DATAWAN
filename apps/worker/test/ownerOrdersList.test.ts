/**
 * GET /api/owner/orders must use a constant number of DB calls, whatever the number of open
 * orders. Production 2026-11-28: ~10 Supabase calls per order went past the Workers Free limit of
 * 50 subrequests per request at 5 open orders → 500 "Too many subrequests", and the board kept
 * showing a stale list (new orders missing even though the NEW_ORDER push arrived).
 */
import { describe, expect, it } from 'vitest';
import type { UserRow } from '@datawan/shared';
import { createApp } from '../src/app';
import type { Deps } from '../src/deps';
import { applyB2b, approveB2b } from '../src/services/b2b';
import { findPostback, makeHarness, OWNER_AUTH, OWNER_TOKEN } from './harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
const AUTH = { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } };

function countingRepo(deps: Deps) {
  const counter = { calls: 0 };
  const repo = new Proxy(deps.repo as unknown as Record<string, unknown>, {
    get(t, k) {
      const v = t[k as string];
      return typeof v === 'function' ? (...a: unknown[]) => { counter.calls++; return (v as (...x: unknown[]) => unknown).apply(t, a); } : v;
    },
  });
  return { app: createApp({ ...deps, repo: repo as never }), counter };
}

/** n open orders in mixed states: priced, awaiting price, a slip under review, out for delivery; a verified B2B customer. */
async function scenario(n: number) {
  const h = makeHarness();
  await h.seedCosts();
  for (let i = 0; i < n; i++) {
    await h.customerText(i % 2 ? 'หอยแครง 3 โล' : 'เอากุ้งแม่น้ำเป็นๆ 2 โล กับหอยแครงโลนึง');
    try {
      await h.customerPostback(findPostback(h.line.lastReply(), 'new'));
    } catch {
      /* first order: no "new order?" question */
    }
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.72, 100.47, `ตลาด ${i}`);
    if (i % 3 === 0) await h.ownerText(`${h.repo.orders.at(-1)!.code} 1850`);
  }
  // Verified B2B with 30-day sell history → the B2B anchor is computed for this customer's orders.
  const user = (await h.repo.getUser('u-customer')) as UserRow;
  await applyB2b(h.deps, user, { businessName: 'Test Kitchen', businessType: 'restaurant', addressText: '99 Test Road', lat: 13.7, lng: 100.5, deliveryWindow: null, taxId: null, documentPaths: [] });
  await approveB2b(h.deps, user.id, OWNER_AUTH, (await h.repo.getBusinessProfile(user.id))!.updated_at);
  await h.repo.insertPriceHistory(
    ['p-kung', 'p-hoi'].map((product_id) => ({ product_id, kind: 'sell' as const, unit_price_satang: 70000, source: 'owner_price' as never, user_id: user.id, order_id: null })),
  );
  // One order with a slip under review, one out for delivery with a tracking link.
  const [a, b] = h.repo.orders;
  if (n >= 2) {
    a!.status = 'PAYMENT_REVIEW';
    await h.repo.insertPayment({ order_id: a!.id, slip_path: `slips/${a!.id}/s.jpeg`, ai_extract: null, amount_satang: 100, slip_time: null, receiver_text: null, reference_no: null, check_result: 'WARN', check_details: null });
    b!.status = 'DELIVERING';
    b!.tracking_url = 'https://share.lalamove.com/?TH1';
  }
  return h;
}

describe('GET /api/owner/orders (dashboard board)', () => {
  it('uses the same number of repo calls for 1 and for 12 open orders', async () => {
    const counts: number[] = [];
    for (const n of [1, 12]) {
      const h = await scenario(n);
      const { app, counter } = countingRepo(h.deps);
      counter.calls = 0;
      const res = await app.request('/api/owner/orders', AUTH);
      expect(res.status).toBe(200);
      expect(((await res.json()) as unknown[]).length).toBe(n);
      counts.push(counter.calls);
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThanOrEqual(20); // + owner auth: well under the Free plan's 50
  });

  it('each list entry equals the single-order view (except the slip image URL, signed only on the detail page)', async () => {
    const h = await scenario(6);
    const app = createApp(h.deps);
    const list = (await (await app.request('/api/owner/orders', AUTH)).json()) as any[];
    expect(list).toHaveLength(6);
    expect(list.some((o) => o.customer.b2b && o.b2bAnchorPriceSatang !== null)).toBe(true);
    expect(list.some((o) => o.trackingPush !== undefined && o.status === 'DELIVERING')).toBe(true);
    for (const o of list) {
      const one = (await (await app.request(`/api/owner/orders/${o.id}`, AUTH)).json()) as any;
      if (one.latestPayment) {
        expect(one.latestPayment.slipImageUrl).toBeTruthy();
        expect(o.latestPayment.slipImageUrl).toBeNull();
        one.latestPayment.slipImageUrl = null;
      }
      expect(o).toEqual(one);
    }
  });

  it('summary/today uses the same number of repo calls for 1 and for 10 delivered orders', async () => {
    const counts: number[] = [];
    for (const n of [1, 10]) {
      const h = await scenario(n);
      for (const o of h.repo.orders) {
        o.status = 'DELIVERED';
        o.delivered_at = h.clock.now().toISOString();
        o.product_price_satang = 100000;
      }
      const { app, counter } = countingRepo(h.deps);
      counter.calls = 0;
      const res = await app.request('/api/owner/summary/today', AUTH);
      expect(((await res.json()) as any).ordersDelivered).toBe(n);
      counts.push(counter.calls);
    }
    expect(counts[1]).toBe(counts[0]);
  });
});
