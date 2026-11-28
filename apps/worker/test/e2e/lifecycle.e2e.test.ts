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
import { lineAmount, type CustomerOrderView, type OrderStatus, type OwnerOrderView } from '@datawan/shared';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import type { Deps } from '../../src/deps';
import { loadConfig } from '../../src/env';
import { CRONS, runScheduled } from '../../src/jobs';
import { signLineBody } from '../../src/line/signature';
import { RecordingNotifier } from '../../src/services/notifier';
import { RecordingBroadcaster } from '../../src/services/realtime';
import { SLIP_MANUAL_REVIEW_DETAIL } from '../../src/services/slipCheck';
import { buildSlipQrForTest } from '../../src/services/slipQr';
import { SupabaseRepo } from '../../src/services/repo.supabase';
import { MemoryStorage } from '../../src/services/storage';
import { CUSTOMER_LINE, CUSTOMER_NAME, CUSTOMER_PHONE, NEW_CUSTOMER_LINE, FakeAuth, FakeLine, findPostback, LIFF_TOKEN, OWNER_AUTH, OWNER_LINE, OWNER_TOKEN, SECRET } from '../harness';
import { createE2eDb, pgrestFetch } from './pgrest';

const API = 'http://worker.e2e';
type WebApi = typeof import('../../../web/src/lib/api');

let db: PGlite;
let app: ReturnType<typeof createApp>;
let web: WebApi;
let line: FakeLine;
let realtime: RecordingBroadcaster;
let auth: FakeAuth;
let notifier: RecordingNotifier;
let storage: MemoryStorage;
let deps: Deps;
const sent: { method: string; path: string; ifMatch: string | null }[] = [];
const liffAuth = { idToken: LIFF_TOKEN, devUser: null };

beforeAll(async () => {
  db = await createE2eDb([OWNER_AUTH]);
  // CUSTOMER_LINE is a returning customer with a saved recipient (fake data).
  await db.query(`insert into users (line_user_id, full_name, phone, pdpa_consent_at) values ($1, $2, $3, now())`, [CUSTOMER_LINE, CUSTOMER_NAME, CUSTOMER_PHONE]);
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
  auth = new FakeAuth();
  auth.owners.set(OWNER_TOKEN, OWNER_AUTH);
  auth.liffUsers.set(LIFF_TOKEN, CUSTOMER_LINE);
  line = new FakeLine();
  realtime = new RecordingBroadcaster();
  notifier = new RecordingNotifier();
  storage = new MemoryStorage();
  const now = () => new Date();
  deps = {
    cfg, repo: new SupabaseRepo(supabase), line, notifier, realtime, auth,
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
let slipSeq = 0;
/** A valid, unique bank slip Mini-QR text, as the customer's browser would decode it. */
const nextSlipQr = () => buildSlipQrForTest('004', `E2E${String(++slipSeq).padStart(17, '0')}`);
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

/** What an owner who checked a correct slip enters (manual slip mode). */
async function goodChecklist(orderId: string) {
  const o = await web.ownerFetch<OwnerOrderView>(`/api/owner/orders/${orderId}`, OWNER_TOKEN);
  return { amountSatang: o.totalSatang!, receiverIsShop: true, slipTime: new Date().toISOString() };
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
    await web.liffFetch(`/api/liff/orders/${id}/slip`, liffAuth, { method: 'POST', body: { path, qrPayload: nextSlipQr() } });
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

    // Nothing read the slip (manual mode): without the owner's checklist nothing changes.
    const payId = own.latestPayment!.id;
    const confirm = (body: Record<string, unknown>) => web.ownerFetch(`/api/owner/payments/${payId}/confirm`, OWNER_TOKEN, { method: 'POST', body, ifMatch: own.version });
    await expect(confirm({ overrideReason: 'looks fine' })).rejects.toMatchObject({ status: 422, code: 'SLIP_CHECKLIST_REQUIRED' });
    expect((await dbOrder(id)).status).toBe('PAYMENT_REVIEW');

    // Production A19: a 105 THB slip to another shop, timed before the order → 3 FAILs, no reason → refused.
    const created = (await db.query<{ created_at: Date }>('select created_at from orders where id = $1', [id])).rows[0]!.created_at;
    const before = new Date(created.getTime() - 3 * 60_000).toISOString();
    const err = await confirm({ overrideReason: null, slipChecklist: { amountSatang: 10500, receiverIsShop: false, slipTime: before } }).then(() => null, (e: unknown) => e as { status: number; message: string });
    expect(err).toMatchObject({ status: 422 });
    expect(err!.message).toContain('AMOUNT FAIL');
    expect(err!.message).toContain('RECEIVER FAIL');
    expect(err!.message).toContain('TIME FAIL');
    expect((await dbOrder(id)).status).toBe('PAYMENT_REVIEW');

    // The owner checked the image and everything matches → PASS, no override reason needed.
    await confirm({ overrideReason: null, slipChecklist: { amountSatang: own.totalSatang!, receiverIsShop: true, slipTime: new Date().toISOString() } });
    expect(await agreedVersion(id, 'PAID')).toBeGreaterThan(v);
    const confirmed = (await db.query<{ confirmed_by: string; override_reason: string | null; check_result: string; check_details: { checks: { rule: string; result: string }[]; owner_checklist: unknown } }>(
      'select confirmed_by, override_reason, check_result, check_details from payments where order_id = $1', [id])).rows[0]!;
    expect(confirmed).toMatchObject({ confirmed_by: OWNER_AUTH, override_reason: null, check_result: 'PASS' });
    expect(confirmed.check_details.checks.map((c) => `${c.rule}:${c.result}`)).toEqual(['READABLE:PASS', 'AMOUNT:PASS', 'RECEIVER:PASS', 'TIME:PASS']);
    expect(confirmed.check_details.owner_checklist).toMatchObject({ amount_satang: own.totalSatang, receiver_is_shop: true });
    const ev = (await db.query<{ actor: string; payload: { checks: string[] } }>(`select actor, payload from order_events where order_id = $1 and event = 'OWNER_CONFIRM_PAYMENT'`, [id])).rows;
    expect(ev).toEqual([expect.objectContaining({ actor: 'owner', payload: expect.objectContaining({ checks: ['READABLE:PASS', 'AMOUNT:PASS', 'RECEIVER:PASS', 'TIME:PASS'] }) })]);
  }, 60_000);

  /** Fresh order driven to PAYMENT_REVIEW with an uploaded slip, through the same calls as the apps. */
  async function orderInPaymentReview(text: string): Promise<{ id: string; code: string; paymentId: string }> {
    await customerText(text);
    // With another order still open the bot asks "add to it or start a new order?" — choose new.
    // This customer's draft only: other tests may leave another customer's draft open.
    const draftSql = `select o.id, o.code from orders o join users u on u.id = o.user_id
      where o.status = 'AWAITING_CONFIRMATION' and u.line_user_id = $1 order by o.created_at desc`;
    if (!(await db.query(draftSql, [CUSTOMER_LINE])).rows.length) {
      await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'new') } });
    }
    const { id, code } = (await db.query<{ id: string; code: string }>(draftSql, [CUSTOMER_LINE])).rows[0]!;
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
    await web.liffFetch(`/api/liff/orders/${id}/slip`, liffAuth, { method: 'POST', body: { path, qrPayload: nextSlipQr() } });
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
    await web.ownerFetch(`/api/owner/payments/${a.paymentId}/confirm`, OWNER_TOKEN, { method: 'POST', body: { overrideReason: 'checked image', slipChecklist: await goodChecklist(a.id) }, ifMatch: (await ownerGet(a.id)).version });
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

  // Production A5/A7: the Lalamove card showed "ผู้รับ: -" / "โทร: -" because nothing ever asked
  // the customer for a recipient. Now a first-time customer's order is held until they fill it.
  it('recipient: new customer is held until name + Thai phone are given; Lalamove card is clean; repeat order pre-filled', async () => {
    const NEW_TOKEN = 'liff-token-new-customer';
    auth.liffUsers.set(NEW_TOKEN, NEW_CUSTOMER_LINE);
    const newAuth = { idToken: NEW_TOKEN, devUser: null };
    const say = (text: string) => webhook(NEW_CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'text', quoteToken: 'q', text } });
    const pin = () => webhook(NEW_CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'location', latitude: 13.72, longitude: 100.47, address: '99/1 ถ.ทดสอบ' } });
    const confirm = () => webhook(NEW_CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'confirm') } });
    const userId = async () => (await db.query<{ id: string }>('select id from users where line_user_id = $1', [NEW_CUSTOMER_LINE])).rows[0]!.id;

    await say('หมึก 1 โล');
    await confirm();
    await pin();
    const id = (await db.query<{ id: string }>(`select id from orders where user_id = $1`, [await userId()])).rows[0]!.id;
    // Held: location saved, no recipient, not submitted to the shop, customer got the LIFF link.
    let row = (await db.query<{ status: string; address_id: string | null; recipient_name: string | null; recipient_phone: string | null }>(
      'select status, address_id, recipient_name, recipient_phone from orders where id = $1', [id])).rows[0]!;
    expect(row).toMatchObject({ status: 'AWAITING_LOCATION', recipient_name: null, recipient_phone: null });
    expect(row.address_id).not.toBeNull();
    expect(JSON.stringify(line.replies.at(-1)!.messages)).toContain('ขอชื่อผู้รับและเบอร์โทร');
    expect(JSON.stringify(line.replies.at(-1)!.messages)).toContain(`/orders/${id}`);
    expect(notifier.alerts.filter((a) => a.kind === 'NEW_ORDER' && a.orderId === id)).toHaveLength(0);

    let cust = await web.liffFetch<CustomerOrderView>(`/api/liff/orders/${id}`, newAuth);
    expect(cust.delivery).toMatchObject({ hasLocation: true, needsRecipient: true, recipientName: null, recipientPhone: null });

    // Validation: bad phone, no consent, stale version → rejected, nothing changes.
    const post = (body: unknown, ifMatch = cust.version) => web.liffFetch<CustomerOrderView>(`/api/liff/orders/${id}/recipient`, newAuth, { method: 'POST', body, ifMatch });
    await expect(post({ recipientName: 'คุณใหม่ ทดสอบ', recipientPhone: '12345', pdpaConsent: true })).rejects.toMatchObject({ status: 400 });
    await expect(post({ recipientName: 'คุณใหม่ ทดสอบ', recipientPhone: '0812345678', pdpaConsent: false })).rejects.toMatchObject({ status: 400 });
    await expect(post({ recipientName: '   ', recipientPhone: '0812345678', pdpaConsent: true })).rejects.toMatchObject({ status: 400 });
    await expect(post({ recipientName: 'คุณใหม่ ทดสอบ', recipientPhone: '0812345678', pdpaConsent: true }, cust.version - 1)).rejects.toMatchObject({ status: 409 });
    expect((await dbOrder(id)).status).toBe('AWAITING_LOCATION');

    // Valid → saved (normalised) to order, address and profile, and the order is submitted.
    cust = await post({ recipientName: 'คุณใหม่ ทดสอบ', recipientPhone: '081-234-5678', pdpaConsent: true });
    expect(cust.status).toBe('AWAITING_PRICE');
    expect(cust.delivery).toMatchObject({ recipientName: 'คุณใหม่ ทดสอบ', recipientPhone: '0812345678', needsRecipient: false });
    row = (await db.query('select status, address_id, recipient_name, recipient_phone from orders where id = $1', [id])).rows[0] as typeof row;
    expect(row).toMatchObject({ status: 'AWAITING_PRICE', recipient_name: 'คุณใหม่ ทดสอบ', recipient_phone: '0812345678' });
    const addr = (await db.query<{ recipient_name: string; recipient_phone: string }>('select recipient_name, recipient_phone from addresses where id = $1', [row.address_id])).rows[0]!;
    expect(addr).toEqual({ recipient_name: 'คุณใหม่ ทดสอบ', recipient_phone: '0812345678' });
    const prof = (await db.query<{ full_name: string; phone: string; pdpa: boolean }>('select full_name, phone, pdpa_consent_at is not null as pdpa from users where line_user_id = $1', [NEW_CUSTOMER_LINE])).rows[0]!;
    expect(prof).toEqual({ full_name: 'คุณใหม่ ทดสอบ', phone: '0812345678', pdpa: true });
    expect(notifier.alerts.filter((a) => a.kind === 'NEW_ORDER' && a.orderId === id)).toHaveLength(1);
    // Audit row has no PII.
    const ev = (await db.query<{ actor: string; payload: unknown }>(`select actor, payload from order_events where order_id = $1 and event = 'RECIPIENT_SET'`, [id])).rows;
    expect(ev).toEqual([{ actor: 'customer', payload: { submitted: true } }]);

    // Through to the Lalamove card: clean ผู้รับ / โทร lines, no "-" placeholder, no warning.
    let own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/price`, OWNER_TOKEN, { method: 'POST', body: { amountSatang: 100 }, ifMatch: own.version });
    cust = await web.liffFetch<CustomerOrderView>(`/api/liff/orders/${id}`, newAuth);
    await web.liffFetch(`/api/liff/orders/${id}/accept`, newAuth, { method: 'POST', ifMatch: cust.version });
    own = await ownerGet(id);
    own = await web.ownerFetch<OwnerOrderView>(`/api/owner/orders/${id}/shipping`, OWNER_TOKEN, { method: 'POST', body: { feeSatang: 0 }, ifMatch: own.version });
    const card = own.lalamoveCard!.text.split('\n');
    expect(card).toContain('ผู้รับ: คุณใหม่ ทดสอบ');
    expect(card).toContain('โทร: 0812345678');
    expect(card.some((l) => /:\s*-\s*$/.test(l))).toBe(false);
    expect(own.lalamoveCard!.text).not.toContain('⚠️');

    // Repeat order: pre-filled from the saved profile, submitted straight away, no form.
    await web.ownerFetch(`/api/owner/orders/${id}/cancel`, OWNER_TOKEN, { method: 'POST', body: { reason: 'e2e' }, ifMatch: own.version });
    await say('กั้ง 1 โล');
    await confirm();
    await pin();
    const id2 = (await db.query<{ id: string }>(`select id from orders where user_id = $1 and id <> $2`, [await userId(), id])).rows[0]!.id;
    const cust2 = await web.liffFetch<CustomerOrderView>(`/api/liff/orders/${id2}`, newAuth);
    expect(cust2.status).toBe('AWAITING_PRICE');
    expect(cust2.delivery).toMatchObject({ recipientName: 'คุณใหม่ ทดสอบ', recipientPhone: '0812345678', needsRecipient: false });
    expect(JSON.stringify(line.replies.at(-1)!.messages)).not.toContain('ขอชื่อผู้รับและเบอร์โทร');
  }, 60_000);

  // Phone test A8: at "ร้านกำลังเช็กค่าส่ง" the owner had no address/pin to quote Lalamove, and an
  // order without location + recipient must never reach (or leave) the shipping-fee step.
  it('shipping step: needs location + recipient to enter/leave it; Lalamove card shown before the fee is set', async () => {
    await customerText('หอยแครง 3 โล');
    if (!(await db.query(`select 1 from orders where status = 'AWAITING_CONFIRMATION'`)).rows.length) {
      await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'new') } });
    }
    const id = (await db.query<{ id: string }>(`select id from orders where status = 'AWAITING_CONFIRMATION'`)).rows[0]!.id;
    await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'confirm') } });
    await webhook(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'location', latitude: 13.7234, longitude: 100.4761, address: '1 ตลาดสดธนบุรี' } });
    let own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/price`, OWNER_TOKEN, { method: 'POST', body: { amountSatang: 30000 }, ifMatch: own.version });
    expect((await dbOrder(id)).status).toBe('PRICE_QUOTED');

    // Simulate an order from before the recipient step (no recipient on the order).
    await db.query('update orders set recipient_name = null, recipient_phone = null where id = $1', [id]);
    let cust = await liffGet(id);
    expect(cust.delivery).toMatchObject({ hasLocation: true, needsRecipient: true });

    // Customer accept is refused (LIFF and chat), order stays put.
    await expect(web.liffFetch(`/api/liff/orders/${id}/accept`, liffAuth, { method: 'POST', ifMatch: cust.version })).rejects.toMatchObject({ status: 422, code: 'DELIVERY_INCOMPLETE' });
    await customerText('ตกลง');
    expect(JSON.stringify(line.replies.at(-1)!.messages)).toContain('ขอชื่อผู้รับและเบอร์โทร');
    expect((await dbOrder(id)).status).toBe('PRICE_QUOTED');

    // Owner accepting a counter-offer is refused too.
    cust = await liffGet(id);
    await web.liffFetch(`/api/liff/orders/${id}/counter`, liffAuth, { method: 'POST', body: { amountSatang: 28000 }, ifMatch: cust.version });
    own = await ownerGet(id);
    await expect(web.ownerFetch(`/api/owner/orders/${id}/negotiation`, OWNER_TOKEN, { method: 'POST', body: { action: 'accept' }, ifMatch: own.version })).rejects.toMatchObject({ status: 422, code: 'DELIVERY_INCOMPLETE' });
    expect((await dbOrder(id)).status).toBe('NEGOTIATING');

    // Customer fills the recipient → owner can accept → AWAITING_SHIPPING_FEE.
    cust = await liffGet(id);
    await web.liffFetch(`/api/liff/orders/${id}/recipient`, liffAuth, { method: 'POST', body: { recipientName: CUSTOMER_NAME, recipientPhone: CUSTOMER_PHONE, pdpaConsent: true }, ifMatch: cust.version });
    expect((await dbOrder(id)).status).toBe('NEGOTIATING'); // updating the recipient never moves the order
    own = await ownerGet(id);
    own = await web.ownerFetch<OwnerOrderView>(`/api/owner/orders/${id}/negotiation`, OWNER_TOKEN, { method: 'POST', body: { action: 'accept' }, ifMatch: own.version });
    expect(own.status).toBe('AWAITING_SHIPPING_FEE');

    // Before any fee: the Lalamove card is there with recipient, phone, address and map pin.
    expect(own.shippingFeeSatang).toBeNull();
    expect(own.lalamoveCard).not.toBeNull();
    const card = own.lalamoveCard!.text.split('\n');
    expect(card).toEqual(expect.arrayContaining([`ผู้รับ: ${CUSTOMER_NAME}`, `โทร: ${CUSTOMER_PHONE}`, 'ที่อยู่: 1 ตลาดสดธนบุรี']));
    expect(card.some((l) => l.startsWith('แผนที่: '))).toBe(true);
    expect(own.lalamoveCard!.mapUrl).toContain('13.7234');

    // Owner can't set the fee if the recipient goes missing; nothing changes.
    await db.query('update orders set recipient_phone = null where id = $1', [id]);
    own = await ownerGet(id);
    await expect(web.ownerFetch(`/api/owner/orders/${id}/shipping`, OWNER_TOKEN, { method: 'POST', body: { feeSatang: 9000 }, ifMatch: own.version })).rejects.toMatchObject({ status: 422, code: 'DELIVERY_INCOMPLETE' });
    expect(await dbOrder(id)).toMatchObject({ status: 'AWAITING_SHIPPING_FEE' });
    await db.query('update orders set recipient_phone = $2 where id = $1', [id, CUSTOMER_PHONE]);
    own = await ownerGet(id);
    own = await web.ownerFetch<OwnerOrderView>(`/api/owner/orders/${id}/shipping`, OWNER_TOKEN, { method: 'POST', body: { feeSatang: 9000 }, ifMatch: own.version });
    expect(own.status).toBe('AWAITING_PAYMENT');
    expect(own.lalamoveCard).not.toBeNull();
    await web.ownerFetch(`/api/owner/orders/${id}/cancel`, OWNER_TOKEN, { method: 'POST', body: { reason: 'e2e' }, ifMatch: own.version });
  }, 60_000);

  // Phone test A7: the tracking link never reached the customer. The save never happened (A7 still
  // PAID, no tracking_url) — pasted share text / a link without https was rejected on both owner
  // paths — and a chat "ขอลิ้งค์ lalamove" answered for the newer active order instead.
  it('Lalamove tracking: share text accepted on both owner paths → DELIVERING; push outcome shown; chat + LIFF give the link', async () => {
    const paid = async (text: string) => {
      const o = await orderInPaymentReview(text);
      const v = (await ownerGet(o.id)).version;
      await web.ownerFetch(`/api/owner/payments/${o.paymentId}/confirm`, OWNER_TOKEN, { method: 'POST', body: { overrideReason: 'checked image', slipChecklist: await goodChecklist(o.id) }, ifMatch: v });
      expect((await dbOrder(o.id)).status).toBe('PAID');
      return o;
    };
    const x = await paid('หอยแครง 2 โล');
    // A newer open order becomes the active one (like A8 next to A7).
    await customerText('กั้ง 1 โล');
    if (!(await db.query(`select 1 from orders where status = 'AWAITING_CONFIRMATION'`)).rows.length) {
      await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'new') } });
    }

    // Before dispatch: the chat question answers for the PAID order with "no link yet".
    await customerText('ขอลิ้งค์ lalamove');
    expect(JSON.stringify(line.replies.at(-1)!.messages)).toContain(`ออเดอร์ ${x.code} ชำระแล้วค่ะ`);

    // Dashboard: owner pastes the app's share text (label + link). This order's 3 push slots are used up.
    await db.query('update orders set push_count = 3, customer_last_seen_at = null where id = $1', [x.id]);
    let own = await ownerGet(x.id);
    const share = 'ติดตามสถานะการจัดส่งได้ที่: https://share.lalamove.com/?TH2611260001&lang=th_TH&sign=e2e';
    own = await web.ownerFetch<OwnerOrderView>(`/api/owner/orders/${x.id}/dispatch`, OWNER_TOKEN, { method: 'POST', body: { trackingUrl: share }, ifMatch: own.version });
    const url = 'https://share.lalamove.com/?TH2611260001&lang=th_TH&sign=e2e';
    expect(own.status).toBe('DELIVERING');
    expect(own.trackingUrl).toBe(url);
    expect(own.trackingPush).toEqual({ sent: false, reason: 'ORDER_CAP' }); // owner is told the customer wasn't pushed
    const row = (await db.query<{ status: string; tracking_url: string; dispatched: boolean }>('select status, tracking_url, dispatched_at is not null as dispatched from orders where id = $1', [x.id])).rows[0]!;
    expect(row).toEqual({ status: 'DELIVERING', tracking_url: url, dispatched: true });

    // Customer asks in chat (several phrasings) → link text + status card with a tracking URI button,
    // for the DELIVERING order even though a newer order is the active one.
    for (const q of ['ขอลิ้งค์ lalamove', 'ลิงก์ส่งของ', 'ถึงไหนแล้วคะ']) {
      await customerText(q);
      const msgs = line.replies.at(-1)!.messages;
      const json = JSON.stringify(msgs);
      expect(msgs[0]).toEqual({ type: 'text', text: `🚚 ลิงก์ติดตามการจัดส่ง (Lalamove) ออเดอร์ ${x.code}\n${url}` });
      expect(json).toContain(`{"type":"uri","label":"ติดตามการจัดส่ง","uri":"${url}"}`);
    }
    // LIFF: the order view carries the link.
    expect((await liffGet(x.id)).trackingUrl).toBe(url);

    // LINE owner command: "<code> <share text with a link without https>" on a fresh order with push budget → pushed.
    const y = await paid('ปลากะพง 1 โล');
    await db.query('update orders set push_count = 0, customer_last_seen_at = null where id = $1', [y.id]);
    const pushesBefore = line.pushes.length;
    await webhook(OWNER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'text', quoteToken: 'q', text: `${y.code} ติดตามได้ที่ share.lalamove.com/?TH2611260002` } });
    const yRow = (await db.query<{ status: string; tracking_url: string }>('select status, tracking_url from orders where id = $1', [y.id])).rows[0]!;
    expect(yRow).toEqual({ status: 'DELIVERING', tracking_url: 'https://share.lalamove.com/?TH2611260002' });
    expect(line.pushes.length).toBe(pushesBefore + 1);
    expect(JSON.stringify(line.pushes.at(-1)!.messages)).toContain('https://share.lalamove.com/?TH2611260002');
    expect((await ownerGet(y.id)).trackingPush).toEqual({ sent: true, reason: null });
  }, 60_000);

  // Production A10: a chat screenshot was accepted as a WARN "slip". Gate uploads on a valid bank
  // Mini-QR decoded on the customer's device (re-validated here — no image decoding on Workers).
  it('slip gate: LIFF needs a valid bank Mini-QR; only AWAITING_PAYMENT/PAYMENT_EXPIRED accept slips; chat images kept + flagged', async () => {
    // Drive a fresh order to AWAITING_PAYMENT.
    await customerText('หมึก 2 โล');
    if (!(await db.query(`select 1 from orders where status = 'AWAITING_CONFIRMATION'`)).rows.length) {
      await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'new') } });
    }
    const id = (await db.query<{ id: string }>(`select id from orders where status = 'AWAITING_CONFIRMATION'`)).rows[0]!.id;
    await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'confirm') } });
    await webhook(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'location', latitude: 13.72, longitude: 100.47, address: '7 ถ.ทดสอบ' } });
    let own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/price`, OWNER_TOKEN, { method: 'POST', body: { amountSatang: 100 }, ifMatch: own.version });
    const c0 = await liffGet(id);
    await web.liffFetch(`/api/liff/orders/${id}/accept`, liffAuth, { method: 'POST', ifMatch: c0.version });
    own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/orders/${id}/shipping`, OWNER_TOKEN, { method: 'POST', body: { feeSatang: 0 }, ifMatch: own.version });
    expect((await dbOrder(id)).status).toBe('AWAITING_PAYMENT');
    const payments = async () => (await db.query<{ n: number }>('select count(*)::int as n from payments where order_id = $1', [id])).rows[0]!.n;
    const upload = async () => {
      const { path } = await web.liffFetch<{ uploadUrl: string; path: string }>(`/api/liff/orders/${id}/slip-upload-url`, liffAuth, { method: 'POST', body: { contentType: 'image/jpeg' } });
      const [b, ...k] = path.split('/');
      await storage.upload(b!, k.join('/'), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]), 'image/jpeg');
      return path;
    };
    const submit = (path: string, qrPayload?: string) =>
      web.liffFetch(`/api/liff/orders/${id}/slip`, liffAuth, { method: 'POST', body: qrPayload === undefined ? { path } : { path, qrPayload } });

    // No QR text, a non-slip QR (e.g. a chat screenshot with a PromptPay QR), a tampered QR → refused,
    // nothing recorded, still AWAITING_PAYMENT.
    const p1 = await upload();
    await expect(submit(p1)).rejects.toMatchObject({ status: 400 });
    await expect(submit(p1, '00020101021129370016A000000677010111011300668123456785802TH530376463041234')).rejects.toMatchObject({ status: 422, code: 'NOT_A_SLIP' });
    const good = nextSlipQr();
    await expect(submit(p1, good.slice(0, -4) + '0000')).rejects.toMatchObject({ status: 422, code: 'NOT_A_SLIP' });
    expect(await payments()).toBe(0);
    expect((await dbOrder(id)).status).toBe('AWAITING_PAYMENT');

    // Valid bank Mini-QR → accepted; the browser's decode is recorded (owner's device still re-reads the image).
    await submit(p1, good);
    expect((await dbOrder(id)).status).toBe('PAYMENT_REVIEW');
    const pay = (await db.query<{ check_details: { source: string; client_qr: { sending_bank: string } } }>('select check_details from payments where order_id = $1', [id])).rows[0]!;
    expect(pay.check_details.source).toBe('liff');
    expect(pay.check_details.client_qr).toEqual({ sending_bank: '004' });

    // In PAYMENT_REVIEW: no new upload URL and no new slip (the QR gate catches wrong images up front).
    await expect(web.liffFetch(`/api/liff/orders/${id}/slip-upload-url`, liffAuth, { method: 'POST', body: { contentType: 'image/jpeg' } })).rejects.toMatchObject({ status: 409 });
    await expect(submit(p1, nextSlipQr())).rejects.toMatchObject({ status: 409 });
    expect(await payments()).toBe(1);

    // Chat image while PAYMENT_REVIEW → not saved as another slip.
    const chat = (msgId: string) => {
      line.content.set(msgId, new Uint8Array(64).fill(7));
      return webhook(CUSTOMER_LINE, { type: 'message', message: { id: msgId, type: 'image', contentProvider: { type: 'line' }, quoteToken: 'q' } });
    };
    await chat('img-review');
    expect(await payments()).toBe(1);

    // Owner rejects → AWAITING_PAYMENT. A chat image is still kept (CLAUDE.md §3.5) but marked "via chat,
    // QR not checked" and the reply offers the LIFF payment screen.
    own = await ownerGet(id);
    await web.ownerFetch(`/api/owner/payments/${own.latestPayment!.id}/reject`, OWNER_TOKEN, { method: 'POST', body: { reason: 'e2e' }, ifMatch: own.version });
    expect((await dbOrder(id)).status).toBe('AWAITING_PAYMENT');
    await chat('img-chat');
    expect(await payments()).toBe(2);
    const chatPay = (await db.query<{ check_details: { source: string; checks: { rule: string; detail: string }[] }; check_result: string }>(
      'select check_details, check_result from payments where order_id = $1 order by created_at desc limit 1', [id])).rows[0]!;
    expect(chatPay.check_result).toBe('WARN');
    expect(chatPay.check_details.source).toBe('chat');
    expect(chatPay.check_details.checks[0]!.detail).toContain('ส่งรูปทางแชท');
    const reply = JSON.stringify(line.replies.at(-1)!.messages);
    expect(reply).toContain('ได้รับรูปแล้วค่ะ');
    expect(reply).toContain(`/orders/${id}`); // LIFF payment-screen button
    expect(reply).toContain('"type":"uri"');
  }, 60_000);

  // สต็อก tab: owner adds categories + products through owner routes; the order parser recognises
  // a new product on the next customer message (it reads the active catalog every time).
  it('catalog: add category + product (validation, duplicates, alias clash), stock shows it, parser recognises it', async () => {
    const post = <T,>(path: string, body: unknown) => web.ownerFetch<T>(path, OWNER_TOKEN, { method: 'POST', body });
    type Cat = { id: string; nameTh: string; sort: number };
    type Prod = { id: string; nameTh: string; unit: string; aliases: string[]; prepTypes: string[]; categoryId: string | null };

    expect(await web.ownerFetch<Cat[]>('/api/owner/categories', OWNER_TOKEN)).toEqual([]);
    const fish = await post<Cat>('/api/owner/categories', { nameTh: '  ปลา  ' });
    expect(fish.nameTh).toBe('ปลา');
    await expect(post('/api/owner/categories', { nameTh: 'ปลา' })).rejects.toMatchObject({ status: 409, code: 'DUPLICATE' });
    await expect(post('/api/owner/categories', { nameTh: '   ' })).rejects.toMatchObject({ status: 400 });
    const shell = await post<Cat>('/api/owner/categories', { nameTh: 'หอย' });
    expect((await web.ownerFetch<Cat[]>('/api/owner/categories', OWNER_TOKEN)).map((c) => c.nameTh)).toEqual(['ปลา', 'หอย']);
    expect(shell.sort).toBeGreaterThan(fish.sort);

    const tilapia = await post<Prod>('/api/owner/products', { nameTh: 'ปลาทับทิม', unit: 'kg', prepTypes: ['live', 'chilled'], aliases: ['ทับทิม', 'ป', ' ทับทิม '], categoryId: fish.id });
    expect(tilapia).toMatchObject({ nameTh: 'ปลาทับทิม', unit: 'kg', prepTypes: ['live', 'chilled'], categoryId: fish.id });
    expect(tilapia.aliases).toEqual(['ปลาทับทิม', 'ทับทิม']); // name always included; 1-char + duplicates dropped

    await expect(post('/api/owner/products', { nameTh: 'ปลาทับทิม', unit: 'kg' })).rejects.toMatchObject({ status: 409, code: 'DUPLICATE' });
    await expect(post('/api/owner/products', { nameTh: 'ปลาเก๋า', unit: 'kg', aliases: ['กะพง'] })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('ปลากะพง') });
    await expect(post('/api/owner/products', { nameTh: 'ปลาเก๋า', unit: 'kg', categoryId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ status: 404 });
    await expect(post('/api/owner/products', { nameTh: 'ปลาเก๋า', unit: 'bucket' })).rejects.toMatchObject({ status: 400 });
    const noCat = await post<Prod>('/api/owner/products', { nameTh: 'ปลาเก๋า', unit: 'kg' });
    expect(noCat).toMatchObject({ categoryId: null, prepTypes: ['any'], aliases: ['ปลาเก๋า'] });

    const stock = await web.ownerFetch<{ productId: string; categoryName: string | null }[]>('/api/owner/stock', OWNER_TOKEN);
    expect(stock.find((r) => r.productId === tilapia.id)).toMatchObject({ categoryName: 'ปลา' });
    expect(stock.find((r) => r.productId === noCat.id)).toMatchObject({ categoryName: null });

    // Customer orders the new product by its alias → the parser maps it to the new product.
    const before = (await db.query<{ n: number }>('select count(*)::int as n from orders')).rows[0]!.n;
    await customerText('ทับทิม 2 โล');
    if ((await db.query<{ n: number }>('select count(*)::int as n from orders')).rows[0]!.n === before) {
      await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'new') } });
    }
    const item = (await db.query<{ product_id: string; qty: string; unit: string }>(
      `select i.product_id, i.qty::text as qty, i.unit from order_items i join orders o on o.id = i.order_id order by o.created_at desc limit 1`)).rows[0]!;
    expect({ ...item, qty: Number(item.qty) }).toEqual({ product_id: tilapia.id, qty: 2, unit: 'kg' });
  }, 60_000);

  // Production 2026-11-26: ปลาทับทิม was created without a category (and without its "ทับทิม" alias);
  // re-adding it failed with "มีสินค้าชื่อนี้อยู่แล้ว" and nothing could move it into "ปลา".
  it('catalog edit: re-add assigns the category + merges aliases; PATCH moves/renames/deactivates; parser follows', async () => {
    const req = <T,>(method: 'POST' | 'PATCH', path: string, body: unknown) => web.ownerFetch<T>(path, OWNER_TOKEN, { method, body });
    type Prod = { id: string; nameTh: string; aliases: string[]; categoryId: string | null; isActive: boolean; merged?: boolean };
    type Cat = { id: string; nameTh: string };
    const crab = await req<Cat>('POST', '/api/owner/categories', { nameTh: 'ปู' });
    const shrimp = await req<Cat>('POST', '/api/owner/categories', { nameTh: 'กุ้ง' });

    // Created uncategorised and without the short alias (as on production).
    const p = await req<Prod>('POST', '/api/owner/products', { nameTh: 'ปูนิ่ม', unit: 'kg' });
    expect(p).toMatchObject({ categoryId: null, aliases: ['ปูนิ่ม'] });

    // Re-adding the same name WITHOUT a category is still a duplicate.
    await expect(req('POST', '/api/owner/products', { nameTh: 'ปูนิ่ม', unit: 'kg' })).rejects.toMatchObject({ status: 409, code: 'DUPLICATE' });
    // Re-adding WITH a category assigns it to the existing product and merges new aliases (no duplicate row).
    const merged = await req<Prod>('POST', '/api/owner/products', { nameTh: ' ปูนิ่ม ', unit: 'kg', aliases: ['ปูนิ่มทอด'], categoryId: crab.id });
    expect(merged).toMatchObject({ id: p.id, categoryId: crab.id, aliases: ['ปูนิ่ม', 'ปูนิ่มทอด'], merged: true });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from products where name_th = 'ปูนิ่ม'`)).rows[0]!.n).toBe(1);
    // Once it has a category, re-adding is a duplicate again (no silent re-categorising).
    await expect(req('POST', '/api/owner/products', { nameTh: 'ปูนิ่ม', unit: 'kg', categoryId: shrimp.id })).rejects.toMatchObject({ status: 409 });
    // Merge still refuses an alias owned by another product.
    const q = await req<Prod>('POST', '/api/owner/products', { nameTh: 'ปูไข่', unit: 'kg' });
    await expect(req('POST', '/api/owner/products', { nameTh: 'ปูไข่', unit: 'kg', aliases: ['ปูนิ่มทอด'], categoryId: crab.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('ปูนิ่ม') });

    // PATCH: move a seed product into a category, edit aliases, rename, deactivate/reactivate.
    const kung = (await db.query<{ id: string }>(`select id from products where name_th = 'กุ้งแม่น้ำ'`)).rows[0]!.id;
    let k = await req<Prod>('PATCH', `/api/owner/products/${kung}`, { categoryId: shrimp.id });
    expect(k).toMatchObject({ categoryId: shrimp.id, nameTh: 'กุ้งแม่น้ำ' });
    k = await req<Prod>('PATCH', `/api/owner/products/${kung}`, { categoryId: null });
    expect(k.categoryId).toBeNull();
    k = await req<Prod>('PATCH', `/api/owner/products/${q.id}`, { aliases: ['ไข่ปู'] });
    expect(k.aliases).toEqual(['ปูไข่', 'ไข่ปู']); // name always kept
    await expect(req('PATCH', `/api/owner/products/${q.id}`, { nameTh: 'ปูนิ่ม' })).rejects.toMatchObject({ status: 409 });
    await expect(req('PATCH', `/api/owner/products/${q.id}`, { aliases: ['กุ้งใหญ่'] })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('กุ้งแม่น้ำ') });
    await expect(req('PATCH', `/api/owner/products/${q.id}`, { categoryId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ status: 404 });
    await expect(req('PATCH', `/api/owner/products/00000000-0000-4000-8000-000000000000`, { categoryId: null })).rejects.toMatchObject({ status: 404 });
    await expect(req('PATCH', `/api/owner/products/${q.id}`, {})).rejects.toMatchObject({ status: 400 });
    k = await req<Prod>('PATCH', `/api/owner/products/${q.id}`, { nameTh: 'ปูไข่ดอง' });
    expect(k).toMatchObject({ nameTh: 'ปูไข่ดอง', aliases: ['ปูไข่ดอง', 'ไข่ปู'] }); // old name dropped, new name added

    // Stock list reports active state; a deactivated product disappears from the parser's catalog.
    k = await req<Prod>('PATCH', `/api/owner/products/${q.id}`, { isActive: false });
    expect(k.isActive).toBe(false);
    let stock = await web.ownerFetch<{ productId: string; isActive: boolean; categoryName: string | null }[]>('/api/owner/stock', OWNER_TOKEN);
    expect(stock.find((r) => r.productId === q.id)).toMatchObject({ isActive: false });
    expect(stock.find((r) => r.productId === p.id)).toMatchObject({ isActive: true, categoryName: 'ปู' });
    await req('PATCH', `/api/owner/products/${q.id}`, { isActive: true });
    stock = await web.ownerFetch('/api/owner/stock', OWNER_TOKEN);
    expect(stock.find((r) => r.productId === q.id)!.isActive).toBe(true);

    // The parser follows the edit: the alias added by the merge is recognised in chat (as a new order,
    // or as an edit of a draft the customer still has open — either way the line maps to ปูนิ่ม).
    await customerText('ปูนิ่มทอด 1 โล');
    const prompt = JSON.stringify(line.replies.at(-1)!.messages);
    if (prompt.includes('"data":"a=new')) await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'new') } });
    expect((await db.query<{ n: number }>('select count(*)::int as n from order_items where product_id = $1', [p.id])).rows[0]!.n).toBeGreaterThan(0);
  }, 60_000);

  // Production A12: "เอาปลาทับทิม" → "5" → "5 โล" kept needs_owner_review = true after the quantity was
  // filled in. The flag is now re-evaluated from the whole draft on every edit.
  it('review flag: multi-message quantity completion clears it; still-ambiguous drafts keep it (real Postgres)', async () => {
    await web.ownerFetch('/api/owner/products', OWNER_TOKEN, { method: 'POST', body: { nameTh: 'ปลาทับทิมแดง', unit: 'kg', aliases: ['ทับทิมแดง'] } });
    const say = (user: string, text: string) => webhook(user, { type: 'message', message: { id: `m${seq + 1}`, type: 'text', quoteToken: 'q', text } });
    const latest = async (user: string) =>
      (await db.query<{ id: string; needs_owner_review: boolean; status: string }>(
        `select o.id, o.needs_owner_review, o.status from orders o join users u on u.id = o.user_id where u.line_user_id = $1 order by o.created_at desc limit 1`, [user])).rows[0]!;

    // A12 shape: flagged while the quantity is missing, cleared once it's given.
    const A = 'Ureviewcomplete00000000000000000000';
    const flags: boolean[] = [];
    for (const m of ['เอาทับทิมแดง', '5', '5 โล']) { await say(A, m); flags.push((await latest(A)).needs_owner_review); }
    expect(flags).toEqual([true, true, false]);
    const a = await latest(A);
    const lines = (await db.query<{ qty: string; name_th: string }>(`select i.qty::text as qty, p.name_th from order_items i join products p on p.id = i.product_id where i.order_id = $1`, [a.id])).rows;
    expect(lines.map((l) => [l.name_th, Number(l.qty)])).toEqual([['ปลาทับทิมแดง', 5]]);
    const ev = (await db.query<{ event: string; actor: string; payload: { reasons: string[] } }>(`select event, actor, payload from order_events where order_id = $1 and event in ('REVIEW_CLEARED','REVIEW_FLAGGED') order by created_at`, [a.id])).rows;
    expect(ev).toEqual([{ event: 'REVIEW_CLEARED', actor: 'system', payload: { reasons: [] } }]);

    // Still ambiguous after the follow-up: no quantity yet → stays flagged; no product match → stays flagged.
    const B = 'Ureviewambiguous0000000000000000000';
    await say(B, 'เอาทับทิมแดง');
    await say(B, 'ขอตัวสวยๆ นะคะ');
    expect((await latest(B)).needs_owner_review).toBe(true);
    const C = 'Ureviewnoproduct0000000000000000000';
    await say(C, 'กุ้งมังกร 2 โล');
    await say(C, 'กุ้งมังกรตัวใหญ่ 2 โล');
    expect((await latest(C)).needs_owner_review).toBe(true);
  }, 60_000);

  // Owner-verified B2B customers (migration 0007), through the web's real api.ts functions.
  // Only the owner decides (approve / reject / acknowledge / revoke, actor owner); the badge and the
  // price anchor follow the VERIFIED profile; business data never reaches user_events.payload.
  it('b2b: apply → B2C order → approve → badge+anchor → rename → rereview kept → acknowledge → revoke; reject → reapply; purge', async () => {
    // Obviously fake business data.
    const SHOP = 'ร้านทดสอบ อีทูอี ซีฟู้ด';
    const SHOP_RENAMED = 'ร้านทดสอบ อีทูอี สาขาสอง';
    const SHOP_B = 'โรงแรมทดสอบ บีบี';
    const TAX_ID = '0105536000313';
    const ADDRESS = '99/9 ถนนทดสอบอีทูอี แขวงทดสอบ';
    const REJECT_REASON = 'เอกสารทดสอบไม่ชัด';
    const REVOKE_REASON = 'ทดสอบเพิกถอนสิทธิ์';
    const A = 'Ub2bshopa000000000000000000000000';
    const B = 'Ub2bshopb000000000000000000000000';
    const authA = { idToken: 'liff-token-b2b-a', devUser: null };
    const authB = { idToken: 'liff-token-b2b-b', devUser: null };
    auth.liffUsers.set(authA.idToken, A);
    auth.liffUsers.set(authB.idToken, B);
    const userIdOf = async (line: string) => (await db.query<{ id: string }>('select id from users where line_user_id = $1', [line])).rows[0]!.id;
    const profileRow = async (userId: string) =>
      (await db.query<{ status: string; needs_rereview: boolean; decided_by: string | null }>(
        'select status, needs_rereview, decided_by from business_profiles where user_id = $1', [userId])).rows[0]!;
    const userRow = async (userId: string) =>
      (await db.query<{ user_type: string; business_name: string | null }>('select user_type, business_name from users where id = $1', [userId])).rows[0]!;
    const docRows = async (userId: string) => (await db.query<{ path: string }>('select path from business_documents where user_id = $1', [userId])).rows;
    const eventCount = async () => (await db.query<{ n: number }>('select count(*)::int as n from user_events')).rows[0]!.n;
    /** What the LIFF does: ask for a signed upload URL, PUT the image, keep the path for the apply. */
    const uploadDoc = async (a: typeof authA) => {
      const { uploadUrl, path } = await web.getB2bDocUploadUrl(a, 'image/jpeg');
      expect(uploadUrl).toContain(path);
      const [bucket, ...key] = path.split('/');
      await storage.upload(bucket!, key.join('/'), new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg');
      return path;
    };
    const apply = (a: typeof authA, businessName: string, documentPaths: string[]) =>
      web.applyB2b(a, { businessName, businessType: 'restaurant', addressText: ADDRESS, lat: 13.72, lng: 100.47, deliveryWindow: '06:00-09:00', taxId: TAX_ID, documentPaths, pdpaConsent: true });

    // 1. A orders in chat as a plain B2C customer.
    await webhook(A, { type: 'message', message: { id: `m${seq + 1}`, type: 'text', quoteToken: 'q', text: 'หอยแครง 2 โล' } });
    const aId = await userIdOf(A);
    const orderId = (await db.query<{ id: string }>('select id from orders where user_id = $1', [aId])).rows[0]!.id;
    expect(await web.getAccount(authA)).toEqual({ type: 'B2C', b2b: null });
    // A past sell price for this customer: the anchor must still stay hidden until the owner verifies.
    const item = (await db.query<{ product_id: string; qty: string }>('select product_id, qty::text as qty from order_items where order_id = $1', [orderId])).rows[0]!;
    await db.query(`insert into price_history (product_id, kind, unit_price_satang, source, user_id) values ($1, 'sell', 15000, 'manual', $2)`, [item.product_id, aId]);

    // 2. A applies with one document → PENDING_VERIFICATION, still B2C; the owner gets a Web Push alert.
    const docA = await uploadDoc(authA);
    const applied = await apply(authA, SHOP, [docA]);
    expect(applied).toMatchObject({ type: 'B2C', b2b: { status: 'PENDING_VERIFICATION', businessName: SHOP, taxId: TAX_ID, needsRereview: false } });
    expect(applied.b2b!.documents).toHaveLength(1);
    expect(JSON.stringify(applied)).not.toContain(docA); // ids only, never Storage paths
    expect((await profileRow(aId)).status).toBe('PENDING_VERIFICATION');
    expect((await userRow(aId)).user_type).toBe('B2C');
    expect(notifier.alerts.some((x) => x.kind === 'B2B_APPLICATION' && x.userId === aId)).toBe(true);

    // 3. The order placed while pending has no badge and no anchor.
    let own = await ownerGet(orderId);
    expect(own.customer.b2b).toBeNull();
    expect(own.b2bAnchorPriceSatang).toBeNull();

    // 4. Owner reviews: pending list, detail with the Tax ID checksum flag and a signed doc URL.
    expect((await web.listB2bCustomers(OWNER_TOKEN, 'pending')).map((x) => x.userId)).toContain(aId);
    const detail = await web.getB2bCustomer(OWNER_TOKEN, aId);
    expect(detail).toMatchObject({ userId: aId, status: 'PENDING_VERIFICATION', businessName: SHOP, taxId: TAX_ID, taxIdValid: true });
    expect(detail.documents).toHaveLength(1);

    // 5. Owner approves (a minute later, so the document predates the decision).
    vi.setSystemTime(Date.now() + 60_000);
    try {
      const approved = await web.approveB2bCustomer(OWNER_TOKEN, aId, detail.updatedAt);
      expect(approved.status).toBe('VERIFIED');
      expect(await profileRow(aId)).toMatchObject({ status: 'VERIFIED', decided_by: OWNER_AUTH });
      expect(await userRow(aId)).toEqual({ user_type: 'B2B', business_name: SHOP });
      expect((await web.listB2bCustomers(OWNER_TOKEN, 'b2b')).map((x) => x.userId)).toContain(aId);

      // 6. The next owner order view shows the badge and the anchor from the customer's last price.
      own = await ownerGet(orderId);
      expect(own.customer.b2b).toEqual({ businessName: SHOP, deliveryWindow: '06:00-09:00' });
      expect(own.b2bAnchorPriceSatang).toBe(lineAmount(15000, Number(item.qty)));

      // 7. A renames the shop: re-review flagged, still B2B, the badge keeps the owner-approved name.
      const renamed = await apply(authA, SHOP_RENAMED, [docA]);
      expect(renamed).toMatchObject({ type: 'B2B', b2b: { status: 'VERIFIED', businessName: SHOP_RENAMED, needsRereview: true } });
      expect(await profileRow(aId)).toMatchObject({ status: 'VERIFIED', needs_rereview: true });
      expect(await userRow(aId)).toEqual({ user_type: 'B2B', business_name: SHOP });
      expect((await ownerGet(orderId)).customer.b2b!.businessName).toBe(SHOP);
      const rereview = await web.getB2bCustomer(OWNER_TOKEN, aId);
      expect(rereview.rereviewFields).toEqual(['business_name']);

      // 8. Owner acknowledges what they saw: the new name becomes the badge name.
      const acked = await web.acknowledgeB2bCustomer(OWNER_TOKEN, aId, rereview.updatedAt);
      expect(acked).toMatchObject({ status: 'VERIFIED', needsRereview: false });
      expect(await userRow(aId)).toEqual({ user_type: 'B2B', business_name: SHOP_RENAMED });
      expect((await ownerGet(orderId)).customer.b2b!.businessName).toBe(SHOP_RENAMED);

      // 9. Owner revokes: back to B2C, no badge, no anchor.
      const revoked = await web.revokeB2bCustomer(OWNER_TOKEN, aId, REVOKE_REASON, acked.updatedAt);
      expect(revoked).toMatchObject({ status: 'REJECTED', rejectionReason: REVOKE_REASON });
      expect((await userRow(aId)).user_type).toBe('B2C');
      own = await ownerGet(orderId);
      expect(own.customer.b2b).toBeNull();
      expect(own.b2bAnchorPriceSatang).toBeNull();

      // 10. B: reject → reapply. Re-applying deletes the rejected application's documents at once.
      const docB1 = await uploadDoc(authB);
      await apply(authB, SHOP_B, [docB1]);
      const bId = await userIdOf(B);
      await web.rejectB2bCustomer(OWNER_TOKEN, bId, REJECT_REASON, (await web.getB2bCustomer(OWNER_TOKEN, bId)).updatedAt);
      expect(await profileRow(bId)).toMatchObject({ status: 'REJECTED', decided_by: OWNER_AUTH });
      expect(await web.getAccount(authB)).toMatchObject({ type: 'B2C', b2b: { status: 'REJECTED', rejectionReason: REJECT_REASON } });
      const docB2 = await uploadDoc(authB);
      expect(await apply(authB, SHOP_B, [docB2])).toMatchObject({ type: 'B2C', b2b: { status: 'PENDING_VERIFICATION', rejectionReason: null } });
      expect((await profileRow(bId)).status).toBe('PENDING_VERIFICATION');
      expect((await docRows(bId)).map((d) => d.path)).toEqual([docB2]);
      expect(storage.objects.has(docB1)).toBe(false);

      // 10b. The owner opened B's application, then B edited it: approving what the owner saw is a
      //      409 on real Postgres (updated_at compared as stored), nothing is decided (§3.1).
      const seenB = (await web.getB2bCustomer(OWNER_TOKEN, bId)).updatedAt;
      vi.setSystemTime(Date.now() + 1_000); // the clock is frozen here; in production time passes between requests
      await apply(authB, SHOP_B, [docB2]);
      await expect(web.approveB2bCustomer(OWNER_TOKEN, bId, seenB)).rejects.toMatchObject({ status: 409, code: 'INVALID_FROM_STATE' });
      expect((await profileRow(bId)).status).toBe('PENDING_VERIFICATION');
      expect((await userRow(bId)).user_type).toBe('B2C');
      expect((await db.query(`select 1 from user_events where user_id = $1 and event = 'B2B_APPROVED'`, [bId])).rows).toEqual([]);

      // 11. An owner decision on an unknown customer is a 404 and writes nothing.
      const before = await eventCount();
      await expect(web.approveB2bCustomer(OWNER_TOKEN, crypto.randomUUID(), detail.updatedAt)).rejects.toMatchObject({ status: 404 });
      expect(await eventCount()).toBe(before);

      // 12. 31 days after the decision the daily cleanup purges A's pre-decision document (rows and
      //     object); B's pending application keeps its document.
      expect(await docRows(aId)).toHaveLength(1);
      vi.setSystemTime(Date.now() + 31 * 86_400_000);
      await runScheduled(deps, CRONS.CLEANUP);
      expect(await docRows(aId)).toEqual([]);
      expect(storage.objects.has(docA)).toBe(false);
      expect((await docRows(bId)).map((d) => d.path)).toEqual([docB2]);
    } finally {
      vi.useRealTimers();
    }

    // 13. Audit trail: owner decisions as owner, the purge as system; payloads hold no business data.
    //     (Steps run within the same millisecond, so created_at can tie: compare as a set; the order
    //     itself is proven by the state checks above.)
    const ev = (await db.query<{ actor: string; event: string; payload: unknown }>(
      `select actor, event, payload from user_events where user_id = $1`, [aId])).rows;
    expect(ev).toHaveLength(6);
    expect(ev).toEqual(expect.arrayContaining([
      { actor: 'customer', event: 'B2B_APPLIED', payload: {} },
      { actor: 'owner', event: 'B2B_APPROVED', payload: {} },
      { actor: 'customer', event: 'B2B_REREVIEW', payload: { fields: ['business_name'] } },
      { actor: 'owner', event: 'B2B_ACKNOWLEDGED', payload: { fields: ['business_name'] } },
      { actor: 'owner', event: 'B2B_REVOKED', payload: {} },
      { actor: 'system', event: 'B2B_DOCS_PURGED', payload: { count: 1 } },
    ]));
    const payloads = (await db.query<{ p: string | null }>(
      `select payload::text as p from user_events where user_id in ($1, $2)`, [aId, await userIdOf(B)])).rows.map((r) => r.p ?? '').join('\n');
    for (const secret of [SHOP, SHOP_RENAMED, SHOP_B, TAX_ID, ADDRESS, REJECT_REASON, REVOKE_REASON]) expect(payloads).not.toContain(secret);
  }, 60_000);

  // Retention counts from the last decision. A document a verified shop adds later is a sensitive
  // change (re-review): it is not "decided" until the owner acknowledges it, so it survives the purge
  // of the older one while the re-review is pending, and goes 30 days after the acknowledge.
  it('b2b purge: deletes only documents uploaded before the last decision (real Postgres)', async () => {
    const C = 'Ub2bshopc000000000000000000000000';
    const authC = { idToken: 'liff-token-b2b-c', devUser: null };
    auth.liffUsers.set(authC.idToken, C);
    const uploadDoc = async () => {
      const { path } = await web.getB2bDocUploadUrl(authC, 'image/jpeg');
      const [bucket, ...key] = path.split('/');
      await storage.upload(bucket!, key.join('/'), new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg');
      return path;
    };
    const apply = (deliveryWindow: string, documentPaths: string[]) =>
      web.applyB2b(authC, { businessName: 'ร้านทดสอบ ซีซี', businessType: 'reseller', addressText: '7/7 ถนนทดสอบซี', lat: null, lng: null, deliveryWindow, taxId: null, documentPaths, pdpaConsent: true });
    const docPaths = async (userId: string) =>
      (await db.query<{ path: string }>('select path from business_documents where user_id = $1', [userId])).rows.map((d) => d.path);
    const purges = async (userId: string) =>
      (await db.query<{ actor: string; payload: { count: number } }>(
        `select actor, payload from user_events where user_id = $1 and event = 'B2B_DOCS_PURGED'`, [userId])).rows;
    const MIN = 60_000;
    try {
      const c1 = await uploadDoc();
      await apply('06:00-09:00', [c1]);
      const cId = (await db.query<{ id: string }>('select id from users where line_user_id = $1', [C])).rows[0]!.id;

      vi.setSystemTime(Date.now() + MIN);
      await web.approveB2bCustomer(OWNER_TOKEN, cId, (await web.getB2bCustomer(OWNER_TOKEN, cId)).updatedAt);
      const approvedAt = Date.now();

      // A new document on a verified shop → re-review; the decision time does not move yet.
      vi.setSystemTime(Date.now() + MIN);
      const c2 = await uploadDoc();
      const edited = await apply('10:00-12:00', [c2]);
      expect(edited).toMatchObject({ type: 'B2B', b2b: { status: 'VERIFIED', needsRereview: true, deliveryWindow: '10:00-12:00' } });
      expect((await web.getB2bCustomer(OWNER_TOKEN, cId)).rereviewFields).toEqual(['documents']);
      const decided = (await db.query<{ decided_at: Date }>('select decided_at from business_profiles where user_id = $1', [cId])).rows[0]!;
      expect(new Date(decided.decided_at).getTime()).toBe(approvedAt);

      // 31 days after the approval, re-review still pending: C1 purged, C2 kept.
      vi.setSystemTime(approvedAt + 31 * 86_400_000);
      await runScheduled(deps, CRONS.CLEANUP);
      expect(await docPaths(cId)).toEqual([c2]);
      expect(storage.objects.has(c1)).toBe(false);
      expect(storage.objects.has(c2)).toBe(true);
      expect(await purges(cId)).toEqual([{ actor: 'system', payload: { count: 1 } }]);

      // The owner acknowledges (deciding on C2); 31 days later C2 is purged too.
      const acked = await web.acknowledgeB2bCustomer(OWNER_TOKEN, cId, (await web.getB2bCustomer(OWNER_TOKEN, cId)).updatedAt);
      expect(acked).toMatchObject({ status: 'VERIFIED', needsRereview: false });
      const ackedAt = Date.now();
      vi.setSystemTime(ackedAt + 29 * 86_400_000);
      await runScheduled(deps, CRONS.CLEANUP);
      expect(await docPaths(cId)).toEqual([c2]);
      vi.setSystemTime(ackedAt + 31 * 86_400_000);
      await runScheduled(deps, CRONS.CLEANUP);
      expect(await docPaths(cId)).toEqual([]);
      expect(storage.objects.has(c2)).toBe(false);
      expect(await purges(cId)).toEqual([{ actor: 'system', payload: { count: 1 } }, { actor: 'system', payload: { count: 1 } }]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
  it('LIFF history + one-tap reorder: delivered order listed, reorder copies items (no price), confirm + same address → AWAITING_PRICE', async () => {
    // A real delivered order: paid by the owner, dispatched, delivered.
    const o = await orderInPaymentReview('หอยแครง 3 โล');
    let own = await ownerGet(o.id);
    await web.ownerFetch(`/api/owner/payments/${o.paymentId}/confirm`, OWNER_TOKEN, { method: 'POST', body: { overrideReason: 'checked image', slipChecklist: await goodChecklist(o.id) }, ifMatch: own.version });
    own = await ownerGet(o.id);
    await web.ownerFetch(`/api/owner/orders/${o.id}/dispatch`, OWNER_TOKEN, { method: 'POST', body: { trackingUrl: 'https://share.lalamove.com/?TH-REORDER' }, ifMatch: own.version });
    own = await ownerGet(o.id);
    await web.ownerFetch(`/api/owner/orders/${o.id}/delivered`, OWNER_TOKEN, { method: 'POST', body: {}, ifMatch: own.version });
    expect((await dbOrder(o.id)).status).toBe('DELIVERED');

    const history = await web.listLiffOrders(liffAuth, 'history');
    const row = history.find((h) => h.id === o.id)!;
    expect(row).toMatchObject({ code: o.code, status: 'DELIVERED', reorderable: true, itemCount: 1 });
    expect(row.itemsPreview[0]).toMatchObject({ name: 'หอยแครง', qty: 3 });
    expect((await web.listLiffOrders(liffAuth, 'open')).every((x) => x.status !== 'DELIVERED' && x.status !== 'CANCELLED')).toBe(true);

    const pushesBefore = line.pushes.length;
    const re = await web.reorderFrom(liffAuth, o.id);
    expect(re).toMatchObject({ status: 'AWAITING_CONFIRMATION', sourceOrderId: o.id, productPriceSatang: null, totalSatang: null, skippedItems: [], deduped: false });
    expect(re.items.map((i) => [i.name, i.qty])).toEqual([['หอยแครง', 3]]);
    const dbRow = (await db.query<{ channel: string; source_order_id: string; ai_parse: unknown; product_price_satang: string | null }>(
      'select channel, source_order_id, ai_parse, product_price_satang from orders where id = $1', [re.id])).rows[0]!;
    expect(dbRow).toEqual({ channel: 'liff', source_order_id: o.id, ai_parse: null, product_price_satang: null });
    expect((await web.reorderFrom(liffAuth, o.id))).toMatchObject({ id: re.id, deduped: true });

    let v = await agreedVersion(re.id, 'AWAITING_CONFIRMATION');
    await expectConflict(web.liffFetch(`/api/liff/orders/${re.id}/confirm`, liffAuth, { method: 'POST', ifMatch: v + 1 }), 'VERSION_CONFLICT');
    expect((await dbOrder(re.id)).version).toBe(v);
    const confirmed = await web.liffFetch<CustomerOrderView>(`/api/liff/orders/${re.id}/confirm`, liffAuth, { method: 'POST', ifMatch: v });
    expect(lastIfMatch()).toBe(String(v));
    v = await agreedVersion(re.id, 'AWAITING_LOCATION');
    expect(confirmed.reuseAddress?.addressText).toBe('ตลาดสดธนบุรี');

    const located = await web.liffFetch<CustomerOrderView>(`/api/liff/orders/${re.id}/location`, liffAuth, { method: 'POST', body: { addressId: confirmed.reuseAddress!.id }, ifMatch: v });
    expect(located.delivery).toMatchObject({ hasLocation: true, needsRecipient: false, recipientName: CUSTOMER_NAME });
    await agreedVersion(re.id, 'AWAITING_PRICE');
    expect(line.pushes.length).toBe(pushesBefore); // no LINE push quota used
    expect(notifier.alerts.filter((a) => a.kind === 'NEW_ORDER' && a.orderId === re.id)).toHaveLength(1);

    const ev = await db.query<{ actor: string; event: string }>('select actor, event from order_events where order_id = $1 order by created_at, id', [re.id]);
    expect(ev.rows.map((r) => `${r.actor}:${r.event}`).sort()).toEqual(
      ['customer:ADDRESS_REUSED', 'customer:CUSTOMER_CONFIRM', 'customer:LOCATION_SET', 'customer:ORDER_CREATED'],
    );
  }, 60_000);
  it('owner board list (batch queries on real Postgres) equals the single-order view for every open order', async () => {
    // At least 6 more open orders (AWAITING_PRICE), and a known cost so cost/suggestion are compared too.
    await db.query(`insert into price_history (product_id, kind, unit_price_satang, source) select id, 'cost', 15000, 'manual' from products where name_th = 'หอยแครง'`);
    const draftSql = `select o.id from orders o join users u on u.id = o.user_id
      where o.status = 'AWAITING_CONFIRMATION' and u.line_user_id = $1 order by o.created_at desc`;
    for (let i = 0; i < 6; i++) {
      await customerText(`หอยแครง ${i + 1} โล`);
      if (!(await db.query(draftSql, [CUSTOMER_LINE])).rows.length) {
        await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'new') } });
      }
      await webhook(CUSTOMER_LINE, { type: 'postback', postback: { data: findPostback(line.replies.at(-1)!.messages, 'confirm') } });
      await webhook(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'location', latitude: 13.72, longitude: 100.47, address: `ตลาด ${i}` } });
    }
    const list = await web.ownerFetch<OwnerOrderView[]>('/api/owner/orders', OWNER_TOKEN);
    const open = (await db.query<{ n: number }>(`select count(*)::int as n from orders where status not in ('DELIVERED', 'CANCELLED')`)).rows[0]!.n;
    expect(list.length).toBe(open);
    expect(list.length).toBeGreaterThanOrEqual(5); // past the old 5-order failure point
    expect(list.filter((o) => o.status === 'AWAITING_PRICE').length).toBeGreaterThanOrEqual(6);
    expect(list.some((o) => o.costSatang !== null)).toBe(true);
    for (const o of list) {
      const one = await ownerGet(o.id);
      if (one.latestPayment) {
        expect(o.latestPayment?.slipImageUrl).toBeNull();
        one.latestPayment.slipImageUrl = null;
      }
      expect(o).toEqual(one);
    }
  }, 60_000);
});
