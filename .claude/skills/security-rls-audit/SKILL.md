---
name: security-rls-audit
description: Use when adding or changing a Supabase migration, table, view, function, RLS policy or Storage bucket; a worker route under /api/owner or /api/liff; anything that reads a path, id or key from a request; NEXT_PUBLIC_ env vars or web build config; or before a release, a Final Defence demo, or when asked for a security, RLS, IDOR or secret-leak audit of Da Tawan Seafood.
---

# Security & RLS Audit

**Core rule:** a security claim is made only from evidence produced in this run (a passing test, a probe result, a scan output). Never from reading code alone. Report every item as **Critical / Warning / Pass**, each with its evidence.

Customers never talk to Postgres directly: the worker uses the service role (which bypasses RLS) after verifying the LIFF ID token. So the two walls are **RLS against the public key** and **the worker's own authorization checks**. Audit both.

## 1. Run the automated suites

```bash
pnpm audit:security     # rls + authz E2E, web build, bundle secret scan
pnpm verify             # e2e-system-test gate (includes the same suites)
```

| Suite | Proves |
|---|---|
| `apps/worker/test/e2e/rls.e2e.test.ts` | Real Postgres (PGlite) with every migration and Supabase-default grants. Catalog checks: RLS on every public table; every table has a policy (except `line_events`, service role only); every policy gates on `is_owner()` / `auth.uid()`; views are `security_invoker`; buckets are private; functions pin `search_path`. Behaviour: anon and a signed-up non-owner (even with `user_metadata.role=owner`) read 0 rows and can't write; the owner reads; `order_events` stays append-only |
| `apps/worker/test/e2e/authz.e2e.test.ts` | Enumerates **`app.routes`**: every `/api/owner/*` returns 401 with no token, a garbage token, and a customer token; every `/api/liff/*` returns 401 without a token; customer B gets **404** on every route for A's order and never sees A's address or realtime token; the slip `path` must be `slips/<own order>/<uuid>.<ext>` |
| `scripts/scan-bundle.mjs <dirs> [--url <site>]` | No JWT with a non-anon role, no `sb_secret_` value, private key, Google key or LINE secret in client files. Exit 1 on a leak |

## 2. Probe production (read-only)

Only GET / list / sign calls, with the **public** key from `apps/web/.env.production.local`:
- `GET /rest/v1/<table>?select=*&limit=1` for every table and view: expect `200 []`.
- `GET /storage/v1/bucket` and `POST /storage/v1/object/list/slips`: expect `[]`.
- A real slip at `/storage/v1/object/public/<path>`: expect 400 or 404.
- `GET /auth/v1/settings`: is `disable_signup` true? (An owner-only app shouldn't allow open signup.)
- `curl -sI` the dashboard: `x-frame-options: DENY`, `frame-ancestors 'none'`, `nosniff`.
- Worker CORS preflight from `https://evil.example`: no `Access-Control-Allow-Origin`.
- `scan-bundle.mjs --url https://datawan-web-production…` (Cloudflare 403s Python's default user agent; the script sends a browser one).

Never print key values, tokens, `transRef`s or customer fields in output. Print prefixes, counts and statuses only.

## 3. Manual review checklist

- [ ] New table: `enable row level security` plus an `is_owner()` policy in the same migration (the catalog test fails otherwise).
- [ ] New function: `set search_path = ''` (or `public` if it queries tables unqualified). No `security definer` without a written reason.
- [ ] New route: owner routes sit under `requireOwner`; LIFF routes load the order through `getOwnOrder()` (404, not 403).
- [ ] **Any id, path or key taken from a request body must be scoped to the caller** (bug found 2026-11-25: a slip `path` could point at another order's slip or a supplier bill).
- [ ] `SUPABASE_SERVICE_ROLE_KEY` appears only in `apps/worker/src` (`grep -rn SERVICE_ROLE apps/web` must find nothing).
- [ ] `NEXT_PUBLIC_*`: only the `CLAUDE.md` §6 list, plus the two boolean flags `USE_MOCKS` / `LIFF_DEV_BYPASS`, both `false` in `.env.production.local`.
- [ ] Logs: no prompts, chat text, names, phone numbers, addresses, LINE user IDs or tokens. Order codes, amounts and statuses are fine.

## Red flags: stop and fix before shipping

- A policy `using (true)`, or a policy without `is_owner()` / `auth.uid()`.
- `role = 'owner'` read from `user_metadata` (users can edit it); it must come from `app_metadata`.
- A 403 that tells an attacker an order exists (use 404).
- "It's only reachable with a UUID": unguessable is not the same as authorized.
- Weakening a security test to get green.

## Report format

```
## Security audit <date> — <commit>
### Critical
- <finding> — evidence: <test/probe/scan output> — fix: <file / migration / setting>
### Warning
- …
### Pass
- <check> — evidence: …
```
