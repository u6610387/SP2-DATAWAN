/** Customer LIFF REST API, route-level: real Hono app (createApp) + in-memory repo. */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { splitPath } from '../src/services/storage';
import { findPostback, LIFF_TOKEN, makeHarness } from './harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

function authed(token: string, body?: unknown) {
  return {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

async function toPriceQuoted(h: ReturnType<typeof makeHarness>) {
  await h.seedCosts();
  await h.customerText('เอากุ้งแม่น้ำเป็นๆ 2 โล กับหอยแครงโลนึง ส่งพรุ่งนี้เช้านะคะ');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7234, 100.4761, 'ตลาดสดธนบุรี');
  await h.ownerText('A1 1850');
  return h.repo.orders[0]!.id;
}

describe('LIFF REST API', () => {
  it('rejects without a valid LIFF token or dev header', async () => {
    const h = makeHarness();
    const res = await createApp(h.deps).request('/api/liff/orders/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });

  // The dev-bypass header's env gating lives in the real `createLiffVerifier` (auth/liff.ts).
  // This harness always uses FakeAuth (test/harness.ts), which honours the header
  // unconditionally for test convenience — so that gating is unit-tested directly against
  // the real implementation in test/liffAuth.test.ts instead of through this fake.

  it('a customer can view and negotiate their own order, but not another customer\'s', async () => {
    const h = makeHarness();
    const orderId = await toPriceQuoted(h);
    const app = createApp(h.deps);
    const auth = { Authorization: `Bearer ${LIFF_TOKEN}` };

    let res = await app.request(`/api/liff/orders/${orderId}`, { headers: auth });
    expect(res.status).toBe(200);
    const view = await jsonOf(res);
    expect(view).toMatchObject({ status: 'PRICE_QUOTED', productPriceSatang: 185000 });
    expect(view.marginColor).toBeUndefined(); // customer view never carries cost/margin

    res = await app.request(`/api/liff/orders/${orderId}/counter`, authed(LIFF_TOKEN, { amountSatang: 170000, message: 'ลดได้ไหมคะ' }));
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).status).toBe('NEGOTIATING');

    // counter at/above the current offer is rejected
    res = await app.request(`/api/liff/orders/${orderId}/counter`, authed(LIFF_TOKEN, { amountSatang: 999999 }));
    expect(res.status).toBe(400);

    await h.ownerText('A1 ok'); // -> AWAITING_SHIPPING_FEE
    res = await app.request(`/api/liff/orders/${orderId}/accept`, { method: 'POST', headers: auth });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.code).toBe('ORDER_STATE_INVALID');

    res = await app.request(`/api/liff/orders/${orderId}/heartbeat`, { method: 'POST', headers: auth });
    expect(res.status).toBe(204);
    expect(h.repo.orders[0]!.customer_last_seen_at).toBeTruthy();

    h.auth.liffUsers.set('other-token', 'Uother0000000000000000000000000000');
    res = await app.request(`/api/liff/orders/${orderId}`, { headers: { Authorization: 'Bearer other-token' } });
    expect(res.status).toBe(404);
  });

  it('slip-upload-url + slip submission runs the AI check and moves the order to PAYMENT_REVIEW', async () => {
    const h = makeHarness();
    const orderId = await toPriceQuoted(h);
    await h.customerText('ตกลงค่ะ');
    await h.ownerText('A1 ship 120');
    const app = createApp(h.deps);
    const auth = { Authorization: `Bearer ${LIFF_TOKEN}`, 'Content-Type': 'application/json' };

    let res = await app.request(`/api/liff/orders/${orderId}/slip-upload-url`, {
      method: 'POST', headers: auth, body: JSON.stringify({ contentType: 'image/jpeg' }),
    });
    expect(res.status).toBe(200);
    const { uploadUrl, path } = await jsonOf(res);
    expect(uploadUrl).toBeTruthy();
    expect(path.startsWith('slips/')).toBe(true);

    // Simulate the browser's direct PUT to the signed URL (never through the Worker).
    const { bucket, key } = splitPath(path);
    await h.deps.storage.upload(bucket, key, new Uint8Array(200).fill(9), 'image/jpeg');

    res = await app.request(`/api/liff/orders/${orderId}/slip`, { method: 'POST', headers: auth, body: JSON.stringify({ path }) });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).status).toBe('PAYMENT_REVIEW');
    expect(h.repo.payments[0]!.check_result).toBe('PASS');
  });

  // Regression (production A3): the heartbeat must not invalidate the version the order room
  // cached, otherwise Counter / Accept send a stale If-Match and get 409. The SQL trigger side
  // is covered by orderVersionTrigger.test.ts; this pins the HTTP sequence the LIFF performs.
  it('counter-offer with the version from GET still succeeds after heartbeats', async () => {
    const h = makeHarness();
    const orderId = await toPriceQuoted(h);
    const app = createApp(h.deps);
    const view = await jsonOf(await app.request(`/api/liff/orders/${orderId}`, authed(LIFF_TOKEN)));
    expect(view.status).toBe('PRICE_QUOTED');

    for (let i = 0; i < 3; i++) {
      const hb = await app.request(`/api/liff/orders/${orderId}/heartbeat`, authed(LIFF_TOKEN, {}));
      expect(hb.status).toBe(204);
    }
    expect(h.repo.orders[0]!.version).toBe(view.version);

    const res = await app.request(`/api/liff/orders/${orderId}/counter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LIFF_TOKEN}`, 'Content-Type': 'application/json', 'If-Match': String(view.version) },
      body: JSON.stringify({ amountSatang: 170000 }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).status).toBe('NEGOTIATING');
  });
});
