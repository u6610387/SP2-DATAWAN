/**
 * RLS & Storage least-privilege, against real Postgres (PGlite) with every migration loaded and
 * Supabase's default grants (so, as in production, RLS is the only thing between the public
 * anon/publishable key and the data). Part of the security-rls-audit skill.
 *
 * Catalog guards also catch FUTURE migrations: a new table without RLS, a policy that doesn't
 * gate on is_owner()/auth.uid(), or a public bucket fails here.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_AUTH } from '../harness';
import { createE2eDb } from './pgrest';

const OTHER_AUTH = '22222222-2222-4222-8222-222222222222';
/** Tables that intentionally have RLS on and NO policy (service role only). */
const SERVICE_ROLE_ONLY = new Set(['line_events']);

let db: PGlite;
let tables: string[];

/** Run `fn` as a Supabase API role with the given JWT claims, then go back to superuser. */
async function as<T>(role: 'anon' | 'authenticated', claims: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
const ANON = {};
const STRANGER = { role: 'authenticated', sub: OTHER_AUTH, app_metadata: {}, user_metadata: { role: 'owner' } }; // user_metadata is user-editable
const OWNER = { role: 'authenticated', sub: OWNER_AUTH, app_metadata: { role: 'owner' } };

async function count(table: string): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
}
async function fails(sql: string): Promise<string> {
  return db.exec(sql).then(() => 'NO ERROR', (e: Error) => e.message);
}

beforeAll(async () => {
  db = await createE2eDb([OWNER_AUTH, OTHER_AUTH]);
  tables = (await db.query<{ t: string }>(`select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`)).rows.map((r) => r.t);
  // One row in every table that holds customer data, as the worker (superuser here) would write it.
  await db.exec(`
    insert into users (id, line_user_id, display_name, phone) values ('aaaaaaaa-0000-4000-8000-000000000001', 'Ucustomer1', 'ลูกค้า', '0800000000');
    insert into addresses (id, user_id, address_text, lat, lng, source) values ('aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'บ้านเลขที่ 1', 13.7, 100.5, 'typed');
    insert into orders (id, user_id, address_id, recipient_name, recipient_phone, status) values ('aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'ผู้รับ', '0811111111', 'PAYMENT_REVIEW');
    insert into payments (order_id, slip_path, reference_no) values ('aaaaaaaa-0000-4000-8000-000000000003', 'slips/aaaaaaaa-0000-4000-8000-000000000003/s.jpeg', 'REF0001');
    insert into order_events (order_id, actor, event) values ('aaaaaaaa-0000-4000-8000-000000000003', 'customer', 'ORDER_CREATED');
    insert into user_events (user_id, actor, event) values ('aaaaaaaa-0000-4000-8000-000000000001', 'customer', 'B2B_APPLIED');
    insert into push_subscriptions (owner_id, endpoint, p256dh, auth) values ('${OWNER_AUTH}', 'https://push.example/1', 'k', 'a'), ('${OTHER_AUTH}', 'https://push.example/2', 'k', 'a');
    insert into storage.objects (bucket_id, name) values ('slips', 'aaaaaaaa-0000-4000-8000-000000000003/s.jpeg');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('RLS catalog guards (every migration, including future ones)', () => {
  it('finds the schema', () => {
    expect(tables).toEqual(expect.arrayContaining(['users', 'addresses', 'orders', 'payments', 'order_events', 'line_events']));
  });

  it('every public table has row level security enabled', async () => {
    const off = (await db.query<{ t: string }>(`select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).rows;
    expect(off.map((r) => r.t)).toEqual([]);
  });

  it('every table has a policy, except the documented service-role-only ones', async () => {
    const withPolicy = new Set((await db.query<{ t: string }>(`select distinct tablename as t from pg_policies where schemaname = 'public'`)).rows.map((r) => r.t));
    expect(tables.filter((t) => !withPolicy.has(t) && !SERVICE_ROLE_ONLY.has(t))).toEqual([]);
  });

  it('every policy gates on is_owner() or auth.uid() (no open "true" policies)', async () => {
    const rows = (await db.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null; roles: string }>(
      `select tablename, policyname, qual, with_check, roles::text from pg_policies where schemaname in ('public', 'storage')`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    const open = rows.filter((r) => ![r.qual, r.with_check].filter(Boolean).every((e) => /is_owner\(\)|auth\.uid\(\)/.test(e!)));
    expect(open).toEqual([]);
  });

  it('views run with the caller\'s rights (security_invoker)', async () => {
    const views = (await db.query<{ v: string; opts: string[] | null }>(`select c.relname as v, c.reloptions as opts from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v'`)).rows;
    expect(views.filter((v) => !(v.opts ?? []).includes('security_invoker=true')).map((v) => v.v)).toEqual([]);
  });

  it('all buckets are private', async () => {
    const b = (await db.query<{ id: string; public: boolean }>(`select id, public from storage.buckets order by id`)).rows;
    expect(b).toEqual([{ id: 'business-docs', public: false }, { id: 'slips', public: false }, { id: 'supplier-bills', public: false }]);
  });

  it('functions pin search_path (Supabase linter: function_search_path_mutable)', async () => {
    const mutable = (await db.query<{ f: string }>(`
      select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') -- skip extension functions (pgcrypto)
      order by 1`)).rows;
    expect(mutable.map((r) => r.f)).toEqual([]);
  });
});

describe('RLS behaviour as the Supabase API roles', () => {
  it('anon (public key) reads nothing from any table, view or the slips bucket', async () => {
    await as('anon', ANON, async () => {
      for (const t of [...tables, 'product_stock']) expect(await count(t), t).toBe(0);
      expect(await count('storage.objects')).toBe(0);
    });
  });

  it('anon cannot write customer data or slips', async () => {
    await as('anon', ANON, async () => {
      expect(await fails(`insert into users (line_user_id) values ('Uattacker')`)).toMatch(/row-level security/);
      expect(await fails(`insert into storage.objects (bucket_id, name) values ('slips', 'x/evil.jpeg')`)).toMatch(/row-level security/);
      const upd = await db.query(`update orders set status = 'PAID' returning id`);
      expect(upd.rows).toHaveLength(0);
    });
    expect((await db.query<{ status: string }>(`select status from orders`)).rows[0]!.status).toBe('PAYMENT_REVIEW');
  });

  it('a signed-up non-owner (even claiming role=owner in user_metadata) reads nothing', async () => {
    await as('authenticated', STRANGER, async () => {
      for (const t of ['users', 'addresses', 'orders', 'payments', 'order_events', 'user_events']) expect(await count(t), t).toBe(0);
      expect(await count('storage.objects')).toBe(0);
      // can only see their own push subscription, never the owner's
      expect((await db.query<{ endpoint: string }>(`select endpoint from push_subscriptions`)).rows).toEqual([{ endpoint: 'https://push.example/2' }]);
    });
  });

  it('the owner (app_metadata.role=owner) sees the data, but the audit log stays append-only', async () => {
    await as('authenticated', OWNER, async () => {
      for (const t of ['users', 'addresses', 'orders', 'payments', 'order_events']) expect(await count(t), t).toBe(1);
      expect(await count('storage.objects')).toBe(1);
      expect(await fails(`update order_events set event = 'X'`)).toMatch(/permission denied/);
      expect(await fails(`delete from order_events`)).toMatch(/permission denied/);
      expect(await count('user_events')).toBe(1);
      expect(await fails(`update user_events set event = 'B2B_REVOKED'`)).toMatch(/permission denied/);
      expect(await fails(`delete from user_events`)).toMatch(/permission denied/);
      expect((await db.query<{ endpoint: string }>(`select endpoint from push_subscriptions`)).rows).toEqual([{ endpoint: 'https://push.example/1' }]);
    });
  });
});
