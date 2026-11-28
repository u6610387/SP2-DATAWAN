/**
 * Subrequest budget of one every-minute cron run under a backlog (Workers Free: 50 subrequests
 * per invocation; every fetch() counts). Real SupabaseRepo over PGlite, the real Realtime
 * broadcaster and the real Web Push notifier: every network call they make is counted, so the
 * number is what production would spend — not a repo-call estimate.
 *
 * Measured 2026-11-28 (2 owner devices): quiet minute 3; per order acted on: payment expiry 6,
 * owner reminder 6, abandonment 4–5. Before CRON_MAX_ACTIONS_PER_RUN a 15-order backlog cost 84
 * in one run, which in production fails mid-order (status changed but audit row / alert lost).
 */
import { createClient } from '@supabase/supabase-js';
import { createAi } from '@datawan/ai';
import type { OrderStatus } from '@datawan/shared';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deps } from '../../src/deps';
import { loadConfig } from '../../src/env';
import { CRONS, runScheduled } from '../../src/jobs';
import { createSupabaseBroadcaster } from '../../src/services/realtime';
import { SupabaseRepo } from '../../src/services/repo.supabase';
import { MemoryStorage } from '../../src/services/storage';
import { createWebPushNotifier } from '../../src/services/webpush';
import { FakeAuth, FakeLine, OWNER_AUTH } from '../harness';
import { createE2eDb, pgrestFetch } from './pgrest';

/** Workers Free: subrequests per invocation. */
const FREE_SUBREQUEST_LIMIT = 50;
/** Owner devices subscribed to Web Push (phone PWA + laptop). Each alert is one push per device. */
const OWNER_DEVICES = 2;

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

let db: PGlite;
let deps: Deps;
let calls = 0;
const counting = (f: typeof fetch): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls++;
  return f(input, init);
}) as typeof fetch;

beforeAll(async () => {
  db = await createE2eDb([OWNER_AUTH]);
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const cfg = loadConfig({
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_OWNER_USER_ID: 'U00000000000000000000000000000a11',
    LIFF_ID: '2000000000-abcdEFGH', OWNER_AUTH_USER_ID: OWNER_AUTH, PROMPTPAY_ID: '0812345678', PROMPTPAY_RECEIVER_NAME: 'x', USE_MOCK_AI: 'true',
    VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey))),
    VAPID_PRIVATE_KEY: ((await crypto.subtle.exportKey('jwk', vapid.privateKey)) as JsonWebKey).d!,
  });
  const supabase = createClient('http://supabase.e2e', 'service-role-e2e', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: counting(pgrestFetch(db)) },
  });
  const repo = new SupabaseRepo(supabase);
  const ok = (status: number) => counting((async () => new Response(null, { status })) as unknown as typeof fetch);
  deps = {
    cfg, repo, line: new FakeLine(), auth: new FakeAuth(), storage: new MemoryStorage(),
    realtime: createSupabaseBroadcaster('http://supabase.e2e', 'service-role-e2e', ok(202)),
    notifier: createWebPushNotifier(cfg, repo, ok(201)),
    ai: createAi(cfg, {}, () => new Date()),
    now: () => new Date(),
  };
  for (let i = 0; i < OWNER_DEVICES; i++) {
    const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    await repo.upsertPushSubscription({
      owner_id: OWNER_AUTH,
      endpoint: `https://push.example/owner-device-${i}`,
      p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', ecdh.publicKey))),
      auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
    });
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

/** `perTimer` orders due for EACH of the 3 timers at once (e.g. after a quiet night or an outage). */
async function backlog(perTimer: number) {
  await db.query(`update orders set status = 'CANCELLED', cancelled_at = now() where status not in ('DELIVERED', 'CANCELLED')`);
  const { id: userId } = (await db.query<{ id: string }>(`insert into users (line_user_id) values ($1) returning id`, [`Ubacklog${Date.now()}${perTimer}`.padEnd(33, '0')])).rows[0]!;
  // Backdated rows (as if the orders have waited 2 days). Triggers paused only for this seeding
  // update, so updated_at keeps the backdated value; the run itself goes through every trigger.
  const make = async (status: OrderStatus, extra = '') => {
    const o = await deps.repo.createOrder({ user_id: userId, raw_order_text: 'x', ai_parse: null, needs_owner_review: false, channel: 'chat' }, []);
    await db.exec(`set session_replication_role = replica`);
    await db.query(`update orders set status = $2, updated_at = now() - interval '2 days' ${extra} where id = $1`, [o.id, status]);
    await db.exec(`set session_replication_role = origin`);
    return o.id;
  };
  const ids: string[] = [];
  for (let i = 0; i < perTimer; i++) {
    ids.push(await make('AWAITING_PRICE')); // → owner reminder (Web Push)
    ids.push(await make('AWAITING_PAYMENT', `, payment_expires_at = now() - interval '1 hour'`)); // → PAYMENT_EXPIRED (Web Push)
    ids.push(await make('AWAITING_CONFIRMATION')); // → abandoned
  }
  await db.query(`update users set active_order_id = $2 where id = $1`, [userId, ids.at(-1)]);
  return ids;
}

/** One every-minute run now; returns subrequests spent + what each timer did. */
async function runOnce() {
  calls = 0;
  const out = await runScheduled(deps, CRONS.EVERY_MINUTE);
  return { spent: calls, out };
}

describe('cron EVERY_MINUTE subrequest budget (real fetch count)', () => {
  it('a quiet minute (nothing due) costs only the 3 list queries', async () => {
    await backlog(0);
    const { spent, out } = await runOnce();
    expect(out).toEqual({ ownerReminders: 0, paymentExpiry: 0, abandonment: 0 });
    expect(spent).toBe(3);
  });

  it('one order due per timer stays well under the limit', async () => {
    await backlog(1);
    const { spent, out } = await runOnce();
    expect(out).toEqual({ ownerReminders: 1, paymentExpiry: 1, abandonment: 1 });
    expect(spent).toBe(20); // 3 list queries + reminder 6 + expiry 6 + abandon 5 (see header)
    expect(spent).toBeLessThan(FREE_SUBREQUEST_LIMIT / 2);
  });

  it('a backlog never makes one run go over the Free limit, and later runs finish it', async () => {
    const ids = await backlog(5); // 15 orders due at once
    const runs: { spent: number; out: Record<string, number | string> }[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await runOnce();
      runs.push(r);
      if (Object.values(r.out).every((v) => v === 0)) break;
    }
    for (const r of runs) {
      expect(Object.values(r.out).filter((v) => typeof v === 'string'), JSON.stringify(r.out)).toEqual([]); // no "error: …"
      expect(r.spent, JSON.stringify(runs.map((x) => x.spent))).toBeLessThanOrEqual(FREE_SUBREQUEST_LIMIT);
    }
    // Cap 6 per run, payment expiry first: 15 due orders → 6 + 6 + 3 actions, then a quiet run.
    expect(runs.map((r) => r.out)).toEqual([
      { paymentExpiry: 5, ownerReminders: 1, abandonment: 0 },
      { paymentExpiry: 0, ownerReminders: 4, abandonment: 2 },
      { paymentExpiry: 0, ownerReminders: 0, abandonment: 3 },
      { paymentExpiry: 0, ownerReminders: 0, abandonment: 0 },
    ]);
    expect(Math.max(...runs.map((r) => r.spent))).toBeLessThanOrEqual(40); // headroom under 50 with 2 devices
    const left = await db.query<{ n: number }>(
      `select count(*)::int as n from orders where id = any($1) and (status in ('AWAITING_PAYMENT', 'AWAITING_CONFIRMATION') or (status = 'AWAITING_PRICE' and owner_reminded_at is null))`,
      [ids],
    );
    expect(left.rows[0]!.n).toBe(0);
  }, 60_000);
});
