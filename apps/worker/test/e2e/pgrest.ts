/**
 * E2E database: real Postgres (PGlite, WASM) loaded with every file in supabase/migrations plus
 * supabase/seed.sql, and a PostgREST-compatible `fetch` so the production SupabaseRepo
 * (supabase-js) runs unchanged against it. Triggers (version bump, order code), constraints,
 * generated columns and guards are therefore the real ones, not re-implemented in a fake.
 *
 * Only the PostgREST subset SupabaseRepo uses is implemented (see e2e-system-test skill):
 * select (column list or *), eq/neq/gt/gte/lt/lte/ilike/is/in/not.in, order, limit,
 * single/maybeSingle, insert, upsert (merge / ignore duplicates), update, delete, count=exact.
 * Anything else throws loudly so a new query shape can't silently pass.
 *
 * Not covered here (say so in reports): PostgREST itself, RLS for anon/authenticated users
 * (the worker uses the service role), Supabase Realtime and Storage.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ROOT = join(__dirname, '../../../..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const SEED = join(ROOT, 'supabase/seed.sql');

/** Minimal stand-ins for the Supabase platform schemas the migrations reference. */
const PLATFORM_STUBS = `
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
  create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
  create role anon; create role authenticated; create role service_role;
  create publication supabase_realtime;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
`;

export async function createE2eDb(authUserIds: string[]): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PLATFORM_STUBS);
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    } catch (e) {
      throw new Error(`migration ${f} failed in PGlite: ${(e as Error).message}`);
    }
  }
  await db.exec(readFileSync(SEED, 'utf8'));
  for (const id of authUserIds) await db.query('insert into auth.users (id) values ($1)', [id]);
  return db;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error(`pgrest shim: unsupported identifier ${JSON.stringify(s)}`);
  return `"${s}"`;
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const OPS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function parseList(v: string): string[] {
  const m = /^\((.*)\)$/.exec(v);
  if (!m) throw new Error(`pgrest shim: bad list ${v}`);
  return m[1]! === '' ? [] : m[1]!.split(',').map((x) => x.replace(/^"(.*)"$/, '$1'));
}

function buildWhere(params: URLSearchParams, args: unknown[]): string {
  const parts: string[] = [];
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    const col = ident(key);
    let neg = false;
    let v = raw;
    if (v.startsWith('not.')) { neg = true; v = v.slice(4); }
    const dot = v.indexOf('.');
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    let clause: string;
    if (op in OPS) {
      args.push(val);
      clause = `${col} ${OPS[op]} $${args.length}`;
    } else if (op === 'in') {
      args.push(parseList(val));
      clause = `${col}::text = any($${args.length}::text[])`;
    } else if (op === 'ilike') {
      args.push(val.replace(/\*/g, '%'));
      clause = `${col}::text ilike $${args.length}`;
    } else if (op === 'is') {
      if (!['null', 'true', 'false'].includes(val)) throw new Error(`pgrest shim: is.${val}`);
      clause = `${col} is ${val}`;
    } else {
      throw new Error(`pgrest shim: unsupported filter ${key}=${raw}`);
    }
    parts.push(neg ? `not (${clause})` : clause);
  }
  return parts.length ? ` where ${parts.join(' and ')}` : '';
}

function buildOrder(params: URLSearchParams): string {
  const o = params.get('order');
  if (!o) return '';
  return ' order by ' + o.split(',').map((term) => {
    const [col, dir, nulls] = term.split('.');
    const d = dir === 'desc' ? 'desc' : 'asc';
    const n = nulls === 'nullsfirst' ? ' nulls first' : nulls === 'nullslast' ? ' nulls last' : '';
    return `${ident(col!)} ${d}${n}`;
  }).join(', ');
}

function pick(rows: Record<string, unknown>[], select: string | null): Record<string, unknown>[] {
  if (!select || select === '*') return rows;
  const cols = select.split(',').map((c) => c.trim());
  for (const c of cols) ident(c); // rejects embeds like products(*) — not supported
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A `fetch` implementing the PostgREST subset over the given PGlite database. */
export function pgrestFetch(db: PGlite): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const m = /\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (!m) throw new Error(`pgrest shim: unsupported path ${url.pathname}`);
    const table = `public.${ident(m[1]!)}`;
    const params = url.searchParams;
    const prefer = req.headers.get('prefer') ?? '';
    const wantObject = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object');
    const args: unknown[] = [];
    let rows: Record<string, unknown>[];

    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const limit = params.get('limit');
        const sql = `select to_jsonb(t) as r from ${table} t${buildWhere(params, args)}${buildOrder(params)}${limit ? ` limit ${Number(limit)}` : ''}`;
        rows = (await db.query<{ r: Record<string, unknown> }>(sql, args)).rows.map((x) => x.r);
      } else if (req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown> | Record<string, unknown>[];
        const list = Array.isArray(body) ? body : [body];
        const onConflict = params.get('on_conflict');
        const upsert = prefer.includes('resolution=');
        rows = [];
        for (const row of list) {
          const keys = Object.keys(row).map((k) => (ident(k), k));
          const cols = keys.map(ident).join(', ');
          let conflict = '';
          if (upsert) {
            const target = onConflict ? `(${onConflict.split(',').map(ident).join(', ')})` : '';
            const updatable = keys.filter((k) => !onConflict?.split(',').includes(k));
            conflict = prefer.includes('ignore-duplicates') || !updatable.length
              ? ` on conflict ${target} do nothing`
              : ` on conflict ${target} do update set ${updatable.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(', ')}`;
          }
          const sql = `insert into ${table} as t (${cols}) select ${cols} from jsonb_populate_record(null::${table}, $1::jsonb)${conflict} returning to_jsonb(t) as r`;
          rows.push(...(await db.query<{ r: Record<string, unknown> }>(sql, [JSON.stringify(row)])).rows.map((x) => x.r));
        }
      } else if (req.method === 'PATCH') {
        const body = (await req.json()) as Record<string, unknown>;
        const keys = Object.keys(body);
        if (!keys.length) throw new Error('pgrest shim: empty PATCH');
        const cols = keys.map(ident).join(', ');
        args.push(JSON.stringify(body));
        const where = buildWhere(params, args);
        const sql = `update ${table} as t set (${cols}) = (select ${cols} from jsonb_populate_record(null::${table}, $1::jsonb))${where} returning to_jsonb(t) as r`;
        rows = (await db.query<{ r: Record<string, unknown> }>(sql, args)).rows.map((x) => x.r);
      } else if (req.method === 'DELETE') {
        const sql = `delete from ${table} as t${buildWhere(params, args)} returning to_jsonb(t) as r`;
        rows = (await db.query<{ r: Record<string, unknown> }>(sql, args)).rows.map((x) => x.r);
      } else {
        throw new Error(`pgrest shim: unsupported method ${req.method}`);
      }
    } catch (e) {
      const err = e as { message: string; code?: string };
      if (err.message.startsWith('pgrest shim:')) throw e;
      return json(400, { message: err.message, code: err.code ?? 'PGLITE' });
    }

    const out = pick(rows, params.get('select'));
    const headers: Record<string, string> = {};
    if (prefer.includes('count=exact')) headers['Content-Range'] = `${out.length ? `0-${out.length - 1}` : '*'}/${out.length}`;
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
    if (wantObject) {
      if (out.length !== 1) return json(406, { code: 'PGRST116', message: `JSON object requested, ${out.length} rows returned` });
      return json(200, out[0], headers);
    }
    return json(req.method === 'POST' ? 201 : 200, out, headers);
  }) as typeof fetch;
}
