/** SupabaseRepo B2B profile listing against real Postgres (PGlite), incl. the PostgREST `or=` filter. */
import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseRepo } from '../../src/services/repo.supabase';
import { createE2eDb, pgrestFetch } from './pgrest';

const U = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
let db: PGlite;
let repo: SupabaseRepo;

beforeAll(async () => {
  db = await createE2eDb([]);
  repo = new SupabaseRepo(
    createClient('http://supabase.e2e', 'service-role-e2e', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: pgrestFetch(db) } }),
  );
  for (const n of [1, 2, 3]) await db.query(`insert into users (id, line_user_id) values ($1, $2)`, [U(n), `Ub2b${n}`]);
  await db.exec(`
    insert into business_profiles (user_id, status, business_name, business_type, address_text, submitted_at)
      values ('${U(1)}', 'PENDING_VERIFICATION', 'Test A', 'restaurant', '1 Test Road', '2026-01-01');
    insert into business_profiles (user_id, status, business_name, business_type, address_text, needs_rereview, submitted_at)
      values ('${U(2)}', 'VERIFIED', 'Test B', 'hotel', '2 Test Road', true, '2026-01-02');
    insert into business_profiles (user_id, status, business_name, business_type, address_text, rejection_reason, submitted_at)
      values ('${U(3)}', 'REJECTED', 'Test C', 'other', '3 Test Road', 'test', '2026-01-03');
  `);
});
afterAll(async () => {
  await db.close();
});

describe('SupabaseRepo.listBusinessProfiles (PGlite)', () => {
  it("'pending' = PENDING_VERIFICATION or needs_rereview, newest first", async () => {
    expect((await repo.listBusinessProfiles('pending')).map((p: { user_id: string }) => p.user_id)).toEqual([U(2), U(1)]);
  });
  it("'b2b' returns only VERIFIED", async () => {
    expect((await repo.listBusinessProfiles('b2b')).map((p: { user_id: string }) => p.user_id)).toEqual([U(2)]);
  });
});
