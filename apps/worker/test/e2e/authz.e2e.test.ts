/**
 * Worker authorization & IDOR, over every route the app actually registers (Hono `app.routes`),
 * so a route added later is covered automatically. Part of the security-rls-audit skill.
 *   - every /api/owner/* route: 401 without a token, with a garbage token, and with a valid
 *     customer (LIFF) token;
 *   - every /api/liff/* route: 401 without a token; a second customer gets 404 (not 403: no
 *     existence oracle) on someone else's order and never sees their address/phone/slip;
 *   - the slip `path` a customer submits must be inside their own order's slips/ folder.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { buildSlipQrForTest } from '../../src/services/slipQr';
import { findPostback, LIFF_TOKEN, makeHarness, OWNER_TOKEN } from '../harness';

const LIFF_TOKEN_B = 'test-liff-token-customer-b';
const CUSTOMER_B = 'Ucustomerb000000000000000000000000';
const ADDRESS = 'ซอยลับ 99 ตลาดสดธนบุรี';
/** ≥16 bytes so the mock slip reader treats it as a slip. */
const SLIP_BYTES = new Uint8Array(32).map((_, i) => (i === 0 ? 0xff : i === 1 ? 0xd8 : i));

async function setup() {
  const h = makeHarness();
  h.auth.liffUsers.set(LIFF_TOKEN_B, CUSTOMER_B);
  await h.customerText('หอยแครง 2 โล');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7234, 100.4761, ADDRESS);
  await h.ownerText('A1 100');
  const app = createApp(h.deps);
  const orderA = h.repo.orders[0]!;
  return { h, app, orderA };
}

function concrete(path: string, id: string) {
  return path.replace(/:[A-Za-z]+/g, id);
}
const bodyFor = (method: string) => (method === 'GET' ? {} : { body: '{}' });

describe('authorization over every registered route', () => {
  it('discovers the owner and LIFF routes from the app itself', async () => {
    const { app } = await setup();
    const owner = app.routes.filter((r) => r.path.startsWith('/api/owner/') && r.method !== 'ALL');
    const liff = app.routes.filter((r) => r.path.startsWith('/api/liff/') && r.method !== 'ALL');
    expect(owner.length).toBeGreaterThanOrEqual(15);
    expect(liff.length).toBeGreaterThanOrEqual(6);
  });

  it('every /api/owner/* route rejects no token, a garbage token and a customer token with 401', async () => {
    const { app, orderA } = await setup();
    const routes = app.routes.filter((r) => r.path.startsWith('/api/owner/') && r.method !== 'ALL');
    for (const r of routes) {
      const path = concrete(r.path, orderA.id);
      for (const auth of [null, 'garbage', LIFF_TOKEN]) {
        const res = await app.request(path, {
          method: r.method,
          headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
          ...bodyFor(r.method),
        });
        expect(res.status, `${r.method} ${r.path} with ${auth ?? 'no token'}`).toBe(401);
      }
    }
  });

  it('every /api/liff/* route rejects a request without a token (401)', async () => {
    const { app, orderA } = await setup();
    for (const r of app.routes.filter((x) => x.path.startsWith('/api/liff/') && x.method !== 'ALL')) {
      const res = await app.request(concrete(r.path, orderA.id), { method: r.method, headers: { 'Content-Type': 'application/json' }, ...bodyFor(r.method) });
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  });

  it("customer B gets 404 on every LIFF route for customer A's order and never sees A's data", async () => {
    const { h, app, orderA } = await setup();
    const before = JSON.stringify(h.repo.orders[0]);
    const routes = app.routes.filter((r) => r.path.startsWith('/api/liff/orders/:') && r.method !== 'ALL');
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const r of routes) {
      const res = await app.request(concrete(r.path, orderA.id), {
        method: r.method,
        headers: { Authorization: `Bearer ${LIFF_TOKEN_B}`, 'Content-Type': 'application/json', 'If-Match': String(orderA.version) },
        ...(r.method === 'GET' ? {} : { body: JSON.stringify({ amountSatang: 1, contentType: 'image/jpeg', path: `slips/${orderA.id}/x.jpeg` }) }),
      });
      const text = await res.text();
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
      expect(text).not.toContain(ADDRESS);
      expect(text).not.toContain(orderA.realtime_token);
    }
    expect(JSON.stringify(h.repo.orders[0])).toBe(before); // nothing changed, not even presence
  });

  it('customer A can read their own order (control)', async () => {
    const { app, orderA } = await setup();
    const res = await app.request(`/api/liff/orders/${orderA.id}`, { headers: { Authorization: `Bearer ${LIFF_TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it('the owner token is accepted on owner routes (control)', async () => {
    const { app } = await setup();
    expect((await app.request('/api/owner/orders', { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).status).toBe(200);
  });
});

describe('slip path ownership (LIFF POST /orders/:id/slip)', () => {
  async function inAwaitingPayment() {
    const s = await setup();
    await s.h.customerPostback(findPostback(s.h.line.pushes.at(-1)!.messages, 'accept'));
    await s.h.ownerText('A1 ship 0');
    expect(s.h.repo.orders[0]!.status).toBe('AWAITING_PAYMENT');
    return s;
  }
  const submit = (app: ReturnType<typeof createApp>, orderId: string, path: string) =>
    app.request(`/api/liff/orders/${orderId}/slip`, { method: 'POST', headers: { Authorization: `Bearer ${LIFF_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path, qrPayload: buildSlipQrForTest('004', 'AUTHZ00000000000001') }) });

  it.each([
    ['another order\'s slip', (id: string) => `slips/00000000-0000-4000-8000-000000000999/${id}.jpeg`],
    ['the supplier-bills bucket', () => 'supplier-bills/bill.jpeg'],
    ['path traversal', (id: string) => `slips/${id}/../00000000-0000-4000-8000-000000000999/s.jpeg`],
    ['the order folder itself', (id: string) => `slips/${id}/`],
  ])('rejects %s with 400 and never reads it', async (_name, mk) => {
    const { h, app, orderA } = await inAwaitingPayment();
    const path = mk(orderA.id);
    await h.deps.storage.upload(path.split('/')[0] as 'slips', path.split('/').slice(1).join('/') || 'x', SLIP_BYTES, 'image/jpeg');
    const res = await submit(app, orderA.id, path);
    expect(res.status).toBe(400);
    expect(h.repo.payments).toHaveLength(0);
    expect(h.repo.orders[0]!.status).toBe('AWAITING_PAYMENT');
  });

  it('accepts a path inside the order\'s own slips/ folder (control)', async () => {
    const { h, app, orderA } = await inAwaitingPayment();
    const key = `${orderA.id}/11111111-2222-4333-8444-555555555555.jpeg`;
    await h.deps.storage.upload('slips', key, SLIP_BYTES, 'image/jpeg');
    const res = await submit(app, orderA.id, `slips/${key}`);
    expect(res.status).toBe(200);
    expect(h.repo.payments).toHaveLength(1);
  });
});
