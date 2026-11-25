/**
 * Regression for the LIFF counter-offer 409 on production order A3:
 * "If-Match does not match the current order version".
 *
 * The `orders_bump_version` trigger bumped `version` on EVERY update, including the LIFF
 * presence heartbeat (`customer_last_seen_at`, every 30 s, no broadcast). The order room's
 * cached `order.version` was therefore stale within seconds of opening, so Accept / Counter
 * sent an out-of-date If-Match and got 409.
 *
 * The in-memory repo used by the other tests never ran the SQL trigger, so this test runs the
 * real trigger function (latest migration that defines it) in PGlite (Postgres in WASM).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '../../../supabase/migrations');

/** The newest `create or replace function bump_order_version()` across all migrations. */
function latestBumpFunctionSql(): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let found: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const m = /create or replace function bump_order_version\(\)[\s\S]*?end \$\$;/i.exec(sql);
    if (m) found = m[0];
  }
  if (!found) throw new Error('bump_order_version() not found in migrations');
  return found;
}

// Only the columns the trigger can see matter; mirror 0001_init.sql's types, incl. the
// generated column (NEW.total_satang is not yet computed inside a BEFORE trigger).
const TABLE = `
  create table orders (
    id int primary key,
    status text not null default 'AWAITING_PRICE',
    product_price_satang bigint,
    shipping_fee_satang bigint,
    total_satang bigint generated always as (product_price_satang + shipping_fee_satang) stored,
    push_count int not null default 0,
    owner_reminded_at timestamptz,
    customer_last_seen_at timestamptz,
    version int not null default 1,
    updated_at timestamptz not null default now()
  );
  create or replace function set_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;
  create trigger orders_updated_at before update on orders for each row execute function set_updated_at();
`;

let db: PGlite;

async function version(): Promise<number> {
  return (await db.query<{ version: number }>('select version from orders where id = 1')).rows[0]!.version;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(TABLE);
  await db.exec(latestBumpFunctionSql());
  await db.exec('create trigger orders_bump_version before update on orders for each row execute function bump_order_version();');
  await db.exec(`insert into orders (id, product_price_satang, shipping_fee_satang) values (1, 10000, 5000);`);
});

describe('orders_bump_version trigger', () => {
  it('does not bump version for a presence heartbeat (customer_last_seen_at only)', async () => {
    await db.exec(`update orders set customer_last_seen_at = now() where id = 1`);
    await db.exec(`update orders set customer_last_seen_at = now() + interval '30 seconds' where id = 1`);
    expect(await version()).toBe(1);
    // the heartbeat itself is still stored
    const seen = await db.query<{ s: string | null }>('select customer_last_seen_at as s from orders where id = 1');
    expect(seen.rows[0]!.s).not.toBeNull();
  });

  it('still bumps version for real order changes', async () => {
    await db.exec(`update orders set status = 'PRICE_QUOTED', product_price_satang = 10000 where id = 1`);
    expect(await version()).toBe(2);
    await db.exec(`update orders set push_count = push_count + 1 where id = 1`);
    expect(await version()).toBe(3);
    await db.exec(`update orders set owner_reminded_at = now() where id = 1`);
    expect(await version()).toBe(4);
  });

  it('bumps when a heartbeat is combined with a real change', async () => {
    await db.exec(`update orders set customer_last_seen_at = now(), shipping_fee_satang = 6000 where id = 1`);
    expect(await version()).toBe(2);
  });

  it('keeps optimistic concurrency working after heartbeats (the If-Match the LIFF sends)', async () => {
    const seenByLiff = await version(); // LIFF GET /orders/:id
    await db.exec(`update orders set customer_last_seen_at = now() where id = 1`); // heartbeat
    const res = await db.query(`update orders set status = 'NEGOTIATING' where id = 1 and version = $1 returning id`, [seenByLiff]);
    expect(res.rows).toHaveLength(1); // counter-offer applies instead of VERSION_CONFLICT
  });
});
