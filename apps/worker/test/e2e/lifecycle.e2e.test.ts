/**
 * Full order lifecycle, end to end, with nothing in the order path faked:
 *   - real Hono app (createApp) and real route/LINE handlers, signed webhooks over HTTP;
 *   - real state machine and services;
 *   - real SupabaseRepo (supabase-js) talking PostgREST to real Postgres (PGlite) loaded with
 *     every supabase/migrations file + seed.sql, so version/code triggers, constraints and
 *     generated columns are the production ones (see ./pgrest.ts);
 *   - REST calls go through apps/web's real `liffFetch` / `ownerFetch`, so the If-Match
 *     header is exactly what the browser sends; every request's raw headers are recorded.
 * Faked only at the edge: the LINE Messaging API, LINE/Supabase token verification, Web Push,
 * Realtime delivery and Storage (all external services).
 *
 * Customer orders → confirm → location → owner quotes → customer counters → owner counters →
 * customer counters → owner holds (rejects) → customer counters → owner accepts → owner cancels.
 * At every step: the version in Postgres, the version in the API view and the broadcast version
 * agree; real changes bump it; heartbeats don't; stale If-Match is refused without changes.
 */
import { createClient } from '@supabase/supabase-js';
import { createAi } from '@datawan/ai';
import type { CustomerOrderView, OrderStatus, OwnerOrderView } from '@datawan/shared';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import type { Deps } from '../../src/deps';
import { loadConfig } from '../../src/env';
import { signLineBody } from '../../src/line/signature';
import { RecordingNotifier } from '../../src/services/notifier';
import { RecordingBroadcaster } from '../../src/services/realtime';
import { SLIP_MANUAL_REVIEW_DETAIL } from '../../src/services/slipCheck';
import { buildSlipQrForTest } from '../../src/services/slipQr';
import { SupabaseRepo } from '../../src/services/repo.supabase';
import { MemoryStorage } from '../../src/services/storage';
import { CUSTOMER_LINE, FakeAuth, FakeLine, findPostback, LIFF_TOKEN, OWNER_AUTH, OWNER_LINE, OWNER_TOKEN, SECRET } from '../harness';
import { createE2eDb, pgrestFetch } from './pgrest';

const API = 'http://worker.e2e';
type WebApi = typeof import('../../../web/src/lib/api');

let db: PGlite;
let app: ReturnType<typeof createApp>;
let web: WebApi;
let line: FakeLine;
let realtime: RecordingBroadcaster;
let storage: MemoryStorage;
const sent: { method: string; path: string; ifMatch: string | null }[] = [];
const liffAuth = { idToken: LIFF_TOKEN, devUser: null };

beforeAll(async () => {
  db = await createE2eDb([OWNER_AUTH]);
  const cfg = loadConfig({
    LINE_CHANNEL_SECRET: SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    LINE_OWNER_USER_ID: OWNER_LINE,
    LIFF_ID: '2000000000-abcdEFGH',
    OWNER_AUTH_USER_ID: OWNER_AUTH,
    PROMPTPAY_ID: '0812345678',
    PROMPTPAY_RECEIVER_NAME: 'ดา ทะวัน',
    USE_MOCK_AI: 'true',
    GEMINI_SLIP_MODE: 'manual', // same as [env.production.vars]
  });
  const supabase = createClient('http://supabase.e2e', 'service-role-e2e', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: pgrestFetch(db) },
  });
  const auth = new FakeAuth();
  auth.owners.set(OWNER_TOKEN, OWNER_AUTH);
  auth.liffUsers.set(LIFF_TOKEN, CUSTOMER_LINE);
  line = new FakeLine();
  realtime = new RecordingBroadcaster();
  storage = new MemoryStorage();
  const now = () => new Date();
  const deps: Deps = {
    cfg, repo: new SupabaseRepo(supabase), line, notifier: new RecordingNotifier(), realtime, auth,
    ai: createAi(cfg, {}, now), storage, now,
  };
  app = createApp(deps);

  // The web client's fetch goes to the worker app; record the raw headers it puts on the wire.
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', API);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!req.url.startsWith(API)) throw new Error(`unexpected network call ${req.url}`);
    const u = new URL(req.url);
    sent.push({ method: req.method, path: u.pathname, ifMatch: req.headers.get('if-match') });
    return app.request(u.pathname + u.search, { method: req.method, headers: req.headers, body: init?.body });
  });
  web = await import('../../../web/src/lib/api');
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db?.close();
});

let seq = 0;
async function webhook(userId: string, event: Record<string, unknown>) {
  const body = JSON.stringify({
    destination: 'Ubot',
    events: [{ mode: 'active', timestamp: Date.now(), webhookEventId: `e2e-${++seq}`, deliveryContext: { isRedelivery: false }, source: { type: 'user', userId }, replyToken: `rt-${seq}`, ...event }],
  });
  const res = await app.request('/webhook', { method: 'POST', headers: { 'x-line-signature': await signLineBody(SECRET, body), 'Content-Type': 'application/json' }, body });
  expect(res.status).toBe(200);
}
const customerText = (text: string) => webhook(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'text', quoteToken: 'q', text } });

async function dbOrder(id: string) {
  const r = await db.query<{ status: OrderStatus; version: number; product_price_satang: string | null; cancel_reason: string | null }>(
    'select status, version, product_price_satang, cancel_reason from orders where id = $1', [id]);
  return r.rows[0]!;
}

const liffGet = (id: string) => web.liffFetch<CustomerOrderView>(`/api/liff/orders/${id}`, liffAuth);
const ownerGet = (id: string) => web.ownerFetch<OwnerOrderView>(`/api/owner/orders/${id}`, OWNER_TOKEN);

/** View, DB and the last broadcast agree on the version; returns it. */
async function agreedVersion(id: string, expectStatus: OrderStatus): Promise<number> {
  const [row, cust, own] = await Promise.all([dbOrder(id), liffGet(id), ownerGet(id)]);
  expect(row.status).toBe(expectStatus);
  expect(cust.status).toBe(expectStatus);
  expect(own.status).toBe(expectStatus);
  expect(typeof cust.version).toBe('number');
  expect(cust.version).toBe(row.version);
  expect(own.version).toBe(row.version);
  const last = realtime.sent.filter((s) => s.channel === cust.realtime.channel).at(-1);
  if (last) expect(last.version).toBe(row.version); // LIFF refetches on a broadcast with a higher version
  return row.version;
}

/** The request's If-Match on the wire is the bare integer the worker parses. */
function lastIfMatch(): string | null {
  return sent.at(-1)!.ifMatch;
}

async function expectConflict(p: Promise<unknown>, code: 'VERSION_CONFLICT' | 'ORDER_STATE_INVALID') {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(web.ApiRequestError);
  expect((err as InstanceType<WebApi['ApiRequestError']>).status).toBe(409);
  expect((err as InstanceType<WebApi['ApiRequestError']>).code).toBe(code);
}

describe('E2E order lifecycle (real handlers + real Postgres + web client)', () => {
  it('order → quote → counter → owner counter → hold → accept → cancel, versions checked at every step', async () => {
    // 1. Customer orders in chat (real seed catalog), confirms, sends location.
    await customerText('หอยแครง 2 โล');
    const created = (await db.query<{ id: string; code: string; version: number }>('select id, code, version from orders')).rows;
    expect(created).toHaveLength(1);
    const id = created[0]!.id;
    expect(created[0]!.code).toMatch(/^[A-Z]\d+$/); // assign_order_code trigger ran
    let v = await agreedVersion(id, 'AWAITING_CONFIRMATION');

    await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'confirm') } });
    let next = await agreedVersion(id, 'AWAITING_LOCATION');
    expect(next).toBeGreaterThan(v); v = next;

    await webhook(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'location', latitude: 13.7234, longitude: 100.4761, address: 'ตลาดสดธนบุรี' } });
    next = await agreedVersion(id, 'AWAITING_PRICE');
    expect(next).toBeGreaterThan(v); v = next;

    // 2. LIFF presence heartbeats: no version change, no broadcast.
    const broadcastsBefore = realtime.sent.length;
    for (let i = 0; i < 3; i++) await web.liffFetch(`/api/liff/orders/${id}/heartbeat`, liffAuth, { method: 'POST' });
    expect((await dbOrder(id)).version).toBe(v);
    expect(realtime.sent.length).toBe(broadcastsBefore);

    // 3. Owner quotes ฿100 with the version the dashboard holds.
    let own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/price`, OWNER_TOKEN, { method: 'POST', body: { amountSatang: 10000, note: null }, ifMatch: own.version });
    expect(lastIfMatch()).toBe(String(own.version));
    next = await agreedVersion(id, 'PRICE_QUOTED');
    expect(next).toBeGreaterThan(v); v = next;
    // a stale If-Match (the pre-quote version) is refused and changes nothing
    await expectConflict(web.ownerFetch(`/api/owner/orders/${id}/price`, OWNER_TOKEN, { method: 'POST', body: { amountSatang: 9000 }, ifMatch: own.version }), 'VERSION_CONFLICT');
    expect(await dbOrder(id)).toMatchObject({ version: v, status: 'PRICE_QUOTED' });

    // 4. Customer opens the LIFF room, heartbeats run, then counters at ฿80 (production A3 bug).
    let cust = await liffGet(id);
    await web.liffFetch(`/api/liff/orders/${id}/heartbeat`, liffAuth, { method: 'POST' });
    await web.liffFetch(`/api/liff/orders/${id}/heartbeat`, liffAuth, { method: 'POST' });
    await web.liffFetch(`/api/liff/orders/${id}/counter`, liffAuth, { method: 'POST', body: { amountSatang: 8000 }, ifMatch: cust.version });
    expect(lastIfMatch()).toBe(String(cust.version));
    expect(lastIfMatch()).toMatch(/^\d+$/); // bare integer, not a quoted ETag
    next = await agreedVersion(id, 'NEGOTIATING');
    expect(next).toBeGreaterThan(v); v = next;

    // 5. Owner counters at ฿90 → back to PRICE_QUOTED.
    own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/negotiation`, OWNER_TOKEN, { method: 'POST', body: { action: 'counter', amountSatang: 9000 }, ifMatch: own.version });
    next = await agreedVersion(id, 'PRICE_QUOTED');
    expect(next).toBeGreaterThan(v); v = next;

    // 6. Customer counters ฿85; owner holds (rejects the counter) → PRICE_QUOTED again.
    cust = await liffGet(id);
    await web.liffFetch(`/api/liff/orders/${id}/counter`, liffAuth, { method: 'POST', body: { amountSatang: 8500 }, ifMatch: cust.version });
    next = await agreedVersion(id, 'NEGOTIATING');
    expect(next).toBeGreaterThan(v); v = next;
    const priceBeforeHold = (await dbOrder(id)).product_price_satang;
    own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/negotiation`, OWNER_TOKEN, { method: 'POST', body: { action: 'hold' }, ifMatch: own.version });
    next = await agreedVersion(id, 'PRICE_QUOTED');
    expect(next).toBeGreaterThan(v); v = next;
    expect((await dbOrder(id)).product_price_satang).toBe(priceBeforeHold);

    // 7. Customer counters ฿88; owner accepts → AWAITING_SHIPPING_FEE at ฿88.
    cust = await liffGet(id);
    await web.liffFetch(`/api/liff/orders/${id}/counter`, liffAuth, { method: 'POST', body: { amountSatang: 8800 }, ifMatch: cust.version });
    next = await agreedVersion(id, 'NEGOTIATING');
    expect(next).toBeGreaterThan(v); v = next;
    own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/negotiation`, OWNER_TOKEN, { method: 'POST', body: { action: 'accept' }, ifMatch: own.version });
    next = await agreedVersion(id, 'AWAITING_SHIPPING_FEE');
    expect(next).toBeGreaterThan(v); v = next;
    expect(Number((await dbOrder(id)).product_price_satang)).toBe(8800);

    // 8. A stale customer action after the owner moved on is refused.
    await expectConflict(web.liffFetch(`/api/liff/orders/${id}/counter`, liffAuth, { method: 'POST', body: { amountSatang: 8000 }, ifMatch: cust.version }), 'VERSION_CONFLICT');
    expect((await dbOrder(id)).version).toBe(v);

    // 9. Owner cancels: stale version refused, current version applies, audit row as owner.
    own = await ownerGet(id);
    await expectConflict(web.ownerFetch(`/api/owner/orders/${id}/cancel`, OWNER_TOKEN, { method: 'POST', body: { reason: 'e2e' }, ifMatch: own.version - 1 }), 'VERSION_CONFLICT');
    await web.ownerFetch(`/api/owner/orders/${id}/cancel`, OWNER_TOKEN, { method: 'POST', body: { reason: 'e2e test' }, ifMatch: own.version });
    next = await agreedVersion(id, 'CANCELLED');
    expect(next).toBe(v + 1); v = next;
    expect((await dbOrder(id)).cancel_reason).toBe('owner: e2e test');
    const user = (await db.query<{ active_order_id: string | null }>('select active_order_id from users')).rows[0]!;
    expect(user.active_order_id).toBeNull();

    // After the final state, actions are refused by the state machine, not by the version.
    cust = await liffGet(id);
    await expectConflict(web.liffFetch(`/api/liff/orders/${id}/accept`, liffAuth, { method: 'POST', ifMatch: cust.version }), 'ORDER_STATE_INVALID');

    // 10. Audit trail: every status change has exactly one event row with the right actor.
    const ev = (await db.query<{ event: string; actor: string; from_status: string; to_status: string }>(
      `select event, actor, from_status, to_status from order_events where order_id = $1 and to_status is not null order by created_at, id`, [id])).rows;
    expect(ev.map((e) => `${e.actor}:${e.event}:${e.to_status}`)).toEqual([
      'customer:CUSTOMER_CONFIRM:AWAITING_LOCATION',
      'customer:LOCATION_SET:AWAITING_PRICE',
      'owner:OWNER_SET_PRICE:PRICE_QUOTED',
      'customer:CUSTOMER_COUNTER:NEGOTIATING',
      'owner:OWNER_COUNTER:PRICE_QUOTED',
      'customer:CUSTOMER_COUNTER:NEGOTIATING',
      'owner:OWNER_HOLD:PRICE_QUOTED',
      'customer:CUSTOMER_COUNTER:NEGOTIATING',
      'owner:OWNER_ACCEPT:AWAITING_SHIPPING_FEE',
      'owner:OWNER_CANCEL:CANCELLED',
    ]);

    // Every order-changing request the web sent carried If-Match as a bare integer.
    const changing = sent.filter((s) => s.method === 'POST' && !s.path.endsWith('/heartbeat'));
    expect(changing.length).toBeGreaterThan(10);
    for (const s of changing) expect(s.ifMatch, `${s.method} ${s.path}`).toMatch(/^\d+$/);
  }, 60_000);

  // Regression (production A5): in GEMINI_SLIP_MODE=manual the slip is never read by AI, the
  // check is WARN, and the owner must be able to see the uploaded image to decide.
  it('slip upload in manual mode: WARN "check it yourself", image URL in the owner view, owner confirms with a reason', async () => {
    await customerText('ปูม้า 1 โล');
    const id = (await db.query<{ id: string }>(`select id from orders where status = 'AWAITING_CONFIRMATION'`)).rows[0]!.id;
    await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'confirm') } });
    await webhook(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'location', latitude: 13.72, longitude: 100.47, address: 'ตลาดสดธนบุรี' } });
    let own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/price`, OWNER_TOKEN, { method: 'POST', body: { amountSatang: 100 }, ifMatch: own.version });
    let cust = await liffGet(id);
    await web.liffFetch(`/api/liff/orders/${id}/accept`, liffAuth, { method: 'POST', ifMatch: cust.version });
    own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/shipping`, OWNER_TOKEN, { method: 'POST', body: { feeSatang: 0 }, ifMatch: own.version });
    let v = await agreedVersion(id, 'AWAITING_PAYMENT');

    // LIFF: ask for an upload URL, the browser PUTs the file there (MemoryStorage stands in for
    // Supabase Storage), then submits the path — same calls as the order room.
    const { path } = await web.liffFetch<{ uploadUrl: string; path: string }>(`/api/liff/orders/${id}/slip-upload-url`, liffAuth, { method: 'POST', body: { contentType: 'image/jpeg' } });
    expect(path).toMatch(new RegExp(`^slips/${id}/[0-9a-f-]+\\.jpeg$`));
    const [bucket, ...rest] = path.split('/');
    await storage.upload(bucket!, rest.join('/'), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg');
    await web.liffFetch(`/api/liff/orders/${id}/slip`, liffAuth, { method: 'POST', body: { path } });
    const next = await agreedVersion(id, 'PAYMENT_REVIEW');
    expect(next).toBeGreaterThan(v); v = next;

    const pay = (await db.query<{ slip_path: string; check_result: string; check_details: { ai: string; checks: { rule: string; detail: string }[] } }>(
      'select slip_path, check_result, check_details from payments where order_id = $1', [id])).rows;
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ slip_path: path, check_result: 'WARN' });
    expect(pay[0]!.check_details.ai).toBe('MANUAL');
    expect(pay[0]!.check_details.checks).toEqual([{ rule: 'READABLE', result: 'WARN', detail: SLIP_MANUAL_REVIEW_DETAIL }]);

    own = await ownerGet(id);
    expect(own.latestPayment).not.toBeNull();
    expect(own.latestPayment!.result).toBe('WARN');
    expect(own.latestPayment!.slipImageUrl).toBe(`memory://signed/${path}`); // signed URL for the stored object
    expect(own.latestPayment!.checks[0]!.detail).toBe(SLIP_MANUAL_REVIEW_DETAIL);

    // WARN needs the owner's override reason; without it nothing changes.
    await expect(web.ownerFetch(`/api/owner/payments/${own.latestPayment!.id}/confirm`, OWNER_TOKEN, { method: 'POST', body: { overrideReason: null }, ifMatch: own.version })).rejects.toBeInstanceOf(web.ApiRequestError);
    expect((await dbOrder(id)).status).toBe('PAYMENT_REVIEW');
    await web.ownerFetch(`/api/owner/payments/${own.latestPayment!.id}/confirm`, OWNER_TOKEN, { method: 'POST', body: { overrideReason: 'checked slip image' }, ifMatch: own.version });
    expect(await agreedVersion(id, 'PAID')).toBeGreaterThan(v);
    const confirmed = (await db.query<{ confirmed_by: string; override_reason: string }>('select confirmed_by, override_reason from payments where order_id = $1', [id])).rows[0]!;
    expect(confirmed).toEqual({ confirmed_by: OWNER_AUTH, override_reason: 'checked slip image' });
  }, 60_000);

  /** Fresh order driven to PAYMENT_REVIEW with an uploaded slip, through the same calls as the apps. */
  async function orderInPaymentReview(text: string): Promise<{ id: string; code: string; paymentId: string }> {
    await customerText(text);
    // With another order still open the bot asks "add to it or start a new order?" — choose new.
    if (!(await db.query(`select 1 from orders where status = 'AWAITING_CONFIRMATION'`)).rows.length) {
      await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'new') } });
    }
    const { id, code } = (await db.query<{ id: string; code: string }>(`select id, code from orders where status = 'AWAITING_CONFIRMATION'`)).rows[0]!;
    await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'confirm') } });
    await webhook(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'location', latitude: 13.72, longitude: 100.47, address: 'ตลาดสดธนบุรี' } });
    let own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/price`, OWNER_TOKEN, { method: 'POST', body: { amountSatang: 100 }, ifMatch: own.version });
    const cust = await liffGet(id);
    await web.liffFetch(`/api/liff/orders/${id}/accept`, liffAuth, { method: 'POST', ifMatch: cust.version });
    own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/shipping`, OWNER_TOKEN, { method: 'POST', body: { feeSatang: 0 }, ifMatch: own.version });
    const { path } = await web.liffFetch<{ uploadUrl: string; path: string }>(`/api/liff/orders/${id}/slip-upload-url`, liffAuth, { method: 'POST', body: { contentType: 'image/jpeg' } });
    const [bucket, ...rest] = path.split('/');
    await storage.upload(bucket!, rest.join('/'), new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
    await web.liffFetch(`/api/liff/orders/${id}/slip`, liffAuth, { method: 'POST', body: { path } });
    own = await ownerGet(id);
    expect(own.status).toBe('PAYMENT_REVIEW');
    return { id, code, paymentId: own.latestPayment!.id };
  }

  const qrCheck = (paymentId: string, payload: string | null) =>
    web.ownerFetch<OwnerOrderView>(`/api/owner/payments/${paymentId}/qr`, OWNER_TOKEN, { method: 'POST', body: { payload } });
  const refCheck = (v: OwnerOrderView) => v.latestPayment!.checks.find((c) => c.rule === 'REFERENCE');

  it('slip Mini-QR check: missing / tampered / valid / duplicate, flags only, owner still decides', async () => {
    const a = await orderInPaymentReview('หอยแครง 1 โล');
    const vBefore = (await dbOrder(a.id)).version;
    const transRef = '016330112233ABCDEFGH';
    const qr = buildSlipQrForTest('004', transRef);

    // No QR found on the image → WARN, owner checks the reference on the image.
    let view = await qrCheck(a.paymentId, null);
    expect(refCheck(view)).toMatchObject({ result: 'WARN' });
    expect(view.latestPayment!.result).toBe('WARN');

    // Tampered QR (CRC mismatch) → FAIL with the reason; overall FAIL.
    view = await qrCheck(a.paymentId, qr.slice(0, -4) + '0000');
    expect(refCheck(view)).toMatchObject({ result: 'FAIL', detail: expect.stringContaining('QR บนสลิปไม่ถูกต้อง') });
    expect(view.latestPayment!.result).toBe('FAIL');

    // Valid bank QR → REFERENCE PASS with bank + ref; the check replaces the earlier one (one row).
    view = await qrCheck(a.paymentId, qr);
    expect(view.latestPayment!.checks.filter((c) => c.rule === 'REFERENCE')).toHaveLength(1);
    expect(refCheck(view)).toEqual({ rule: 'REFERENCE', result: 'PASS', detail: `QR ธนาคารถูกต้อง: ธ.กสิกรไทย เลขอ้างอิง ${transRef} ยังไม่เคยใช้` });
    // Amount / receiver / time are not verified without a bank API → overall stays WARN.
    expect(view.latestPayment!.result).toBe('WARN');
    const row = (await db.query<{ reference_no: string; check_result: string }>('select reference_no, check_result from payments where id = $1', [a.paymentId])).rows[0]!;
    expect(row).toEqual({ reference_no: transRef, check_result: 'WARN' });
    // Re-running the same QR is idempotent.
    expect(refCheck(await qrCheck(a.paymentId, qr))).toMatchObject({ result: 'PASS' });

    // Code never moves the order: status and version are unchanged, audit row says owner.
    expect(await dbOrder(a.id)).toMatchObject({ status: 'PAYMENT_REVIEW', version: vBefore });
    const ev = (await db.query<{ actor: string; n: number }>(`select actor, count(*)::int as n from order_events where order_id = $1 and event = 'SLIP_QR_CHECKED' group by actor`, [a.id])).rows;
    expect(ev).toEqual([{ actor: 'owner', n: 4 }]);

    // The same slip sent for another order → FAIL "duplicate", naming the first order.
    await web.ownerFetch(`/api/owner/payments/${a.paymentId}/confirm`, OWNER_TOKEN, { method: 'POST', body: { overrideReason: 'checked image' }, ifMatch: (await ownerGet(a.id)).version });
    const b = await orderInPaymentReview('กั้ง 1 โล');
    view = await qrCheck(b.paymentId, qr);
    expect(refCheck(view)).toEqual({ rule: 'REFERENCE', result: 'FAIL', detail: `สลิปซ้ำ: เลขอ้างอิง ${transRef} เคยใช้กับออเดอร์ ${a.code} แล้ว` });
    expect(view.latestPayment!.result).toBe('FAIL');
    expect((await db.query<{ reference_no: string | null }>('select reference_no from payments where id = $1', [b.paymentId])).rows[0]!.reference_no).toBeNull();
    // FAIL still lets the owner decide (reject here); it is never auto-rejected or auto-approved.
    expect((await dbOrder(b.id)).status).toBe('PAYMENT_REVIEW');

    // After confirmation the QR result is frozen.
    await expect(qrCheck(a.paymentId, qr)).rejects.toMatchObject({ status: 409 });
  }, 60_000);
});
