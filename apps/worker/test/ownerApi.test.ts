/**
 * Owner dashboard REST API, route-level: real Hono app (createApp) + in-memory repo, same
 * pattern test/harness.ts already uses for the LINE webhook. Drives the same 9-step order
 * lifecycle as happyPath.test.ts but through HTTP calls, proving the dashboard and LINE paths
 * produce identical state (shared services/orderActions.ts).
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { applyEvent } from '../src/services/orders';
import { findPostback, makeHarness, OWNER_AUTH, OWNER_TOKEN } from './harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

function authed(token: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

describe('owner REST API', () => {
  it('rejects requests without a valid owner token', async () => {
    const h = makeHarness();
    const res = await createApp(h.deps).request('/api/owner/orders');
    expect(res.status).toBe(401);
    expect((await jsonOf(res)).error.code).toBe('UNAUTHORIZED');
  });

  it('answers the CORS preflight for OPTIONS /api/owner/orders without an Authorization header', async () => {
    const h = makeHarness();
    const res = await createApp(h.deps).request('/api/owner/orders', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });

  it('does not grant CORS to unlisted origins, and the real request still needs auth', async () => {
    const h = makeHarness();
    const app = createApp(h.deps);
    const pre = await app.request('/api/owner/orders', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const res = await app.request('/api/owner/orders', { headers: { Origin: 'http://localhost:3000' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000'); // so the browser can read the 401
  });

  it('drives price → negotiation → shipping → payment → dispatch → delivered', async () => {
    const h = makeHarness();
    await h.seedCosts();
    const app = createApp(h.deps);

    await h.customerText('เอากุ้งแม่น้ำเป็นๆ 2 โล กับหอยแครงโลนึง ส่งพรุ่งนี้เช้านะคะ');
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7234, 100.4761, 'ตลาดสดธนบุรี');
    const orderId = h.repo.orders[0]!.id;

    let res = await app.request(`/api/owner/orders/${orderId}`, authed(OWNER_TOKEN));
    expect(res.status).toBe(200);
    let view = await jsonOf(res);
    expect(view.status).toBe('AWAITING_PRICE');
    expect(view.suggestedPriceSatang).toBe(169000);

    res = await app.request(`/api/owner/orders/${orderId}/price`, authed(OWNER_TOKEN, { amountSatang: 185000, note: 'กุ้งได้ 2.1 กก.' }));
    expect(res.status).toBe(200);
    view = await jsonOf(res);
    expect(view).toMatchObject({ status: 'PRICE_QUOTED', productPriceSatang: 185000, marginColor: 'GREEN', costSatang: 135000 });

    // stale If-Match → 409 VERSION_CONFLICT, no mutation applied
    res = await app.request(`/api/owner/orders/${orderId}/shipping`, authed(OWNER_TOKEN, { feeSatang: 100 }, { 'If-Match': '1' }));
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.code).toBe('VERSION_CONFLICT');
    expect(h.repo.orders[0]!.status).toBe('PRICE_QUOTED');

    await h.customerText('1700 ได้ไหมคะ');
    expect(h.repo.orders[0]!.status).toBe('NEGOTIATING');

    res = await app.request(`/api/owner/orders/${orderId}/negotiation`, authed(OWNER_TOKEN, { action: 'accept' }));
    expect(res.status).toBe(200);
    view = await jsonOf(res);
    expect(view).toMatchObject({ status: 'AWAITING_SHIPPING_FEE', productPriceSatang: 170000 });

    res = await app.request(`/api/owner/orders/${orderId}/shipping`, authed(OWNER_TOKEN, { feeSatang: 12000 }));
    expect(res.status).toBe(200);
    view = await jsonOf(res);
    expect(view.status).toBe('AWAITING_PAYMENT');
    expect(view.totalSatang).toBe(182000);
    expect(view.lalamoveCard.text).toContain('Lalamove');

    await h.customerImage('img-1', new Uint8Array(200).fill(9));
    expect(h.repo.orders[0]!.status).toBe('PAYMENT_REVIEW');
    const paymentId = h.repo.payments[0]!.id;

    // owner confirms via the dashboard — paid_confirmed_by is the REST-authenticated owner id,
    // not the LINE_OWNER_USER_ID config constant (CLAUDE.md §3.1).
    res = await app.request(`/api/owner/payments/${paymentId}/confirm`, authed(OWNER_TOKEN, {}));
    expect(res.status).toBe(200);
    view = await jsonOf(res);
    expect(view.status).toBe('PAID');
    expect(h.repo.orders[0]!.paid_confirmed_by).toBe(OWNER_AUTH);

    res = await app.request(`/api/owner/orders/${orderId}/dispatch`, authed(OWNER_TOKEN, { trackingUrl: 'https://share.lalamove.com/abc123' }));
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).status).toBe('DELIVERING');

    res = await app.request(`/api/owner/orders/${orderId}/delivered`, authed(OWNER_TOKEN, {}));
    expect(res.status).toBe(200);
    view = await jsonOf(res);
    expect(view.status).toBe('DELIVERED');
    expect(h.repo.stockLogs.filter((s) => s.order_id === orderId)).toHaveLength(2);
  });

  it('needs an overrideReason to confirm a FAIL slip, then succeeds once one is given', async () => {
    const h = makeHarness();
    await h.seedCosts();
    const app = createApp(h.deps);
    await h.customerText('เอากุ้งแม่น้ำเป็นๆ 2 โล กับหอยแครงโลนึง ส่งพรุ่งนี้เช้านะคะ');
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7234, 100.4761, 'ตลาดสดธนบุรี');
    await h.ownerText('A1 1850');
    await h.customerText('ตกลงค่ะ');
    await h.ownerText('A1 ship 120');
    // Wrong receiver name → RECEIVER check FAILs even though the amount matches.
    await h.repo.insertPayment({
      order_id: h.repo.orders[0]!.id, slip_path: 'slips/x.jpg', ai_extract: null,
      amount_satang: h.repo.orders[0]!.total_satang, slip_time: null, receiver_text: 'คนอื่น', reference_no: 'REF-1', check_result: 'FAIL',
      check_details: { checks: [{ rule: 'RECEIVER', result: 'FAIL', detail: 'mismatch' }] },
    });
    const paymentId = h.repo.payments[0]!.id;
    await applyEvent(h.deps, h.repo.orders[0]!, 'SLIP_UPLOADED', 'customer', {}, { payment_id: paymentId, result: 'FAIL' });
    expect(h.repo.orders[0]!.status).toBe('PAYMENT_REVIEW');

    let res = await app.request(`/api/owner/payments/${paymentId}/confirm`, authed(OWNER_TOKEN, {}));
    expect(res.status).toBe(422);
    expect((await jsonOf(res)).error.code).toBe('VALIDATION_FAILED');
    expect(h.repo.orders[0]!.status).toBe('PAYMENT_REVIEW');

    res = await app.request(`/api/owner/payments/${paymentId}/confirm`, authed(OWNER_TOKEN, { overrideReason: 'ลูกค้าโอนสองรอบ' }));
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).status).toBe('PAID');
    expect(h.repo.payments[0]!.override_reason).toBe('ลูกค้าโอนสองรอบ');
  });

  it('a payment id that does not exist is a 404', async () => {
    const h = makeHarness();
    const res = await createApp(h.deps).request('/api/owner/payments/doesnotexist/confirm', authed(OWNER_TOKEN, {}));
    expect(res.status).toBe(404);
  });

  it('quota, stock and summary endpoints', async () => {
    const h = makeHarness();
    const app = createApp(h.deps);

    let res = await app.request('/api/owner/quota', authed(OWNER_TOKEN));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ limit: 300, mode: 'NORMAL' });

    res = await app.request('/api/owner/stock', authed(OWNER_TOKEN, { productId: 'p-kung', reason: 'stock_in', qtyDelta: 10, unitCostSatang: 60000 }));
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).stockLogId).toBeTruthy();

    res = await app.request('/api/owner/stock', authed(OWNER_TOKEN));
    const stock = (await jsonOf(res)) as { productId: string; onHand: number }[];
    expect(stock.find((s) => s.productId === 'p-kung')?.onHand).toBe(10);

    res = await app.request('/api/owner/summary/today', authed(OWNER_TOKEN));
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).ordersDelivered).toBe(0);
  });
});
