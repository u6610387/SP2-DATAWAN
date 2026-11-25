---
name: e2e-system-test
description: Use when about to open a pull request, merge to main, or deploy datawan-worker-production / datawan-web-production or a Supabase migration in Da Tawan Seafood; when a change touches order status, If-Match / order.version, supabase/migrations, packages/shared/src/contracts, worker routes, or apps/web API calls; or when unit tests pass but production returns 409 VERSION_CONFLICT, 404 on a documented endpoint, or a payload validation error.
---

# E2E System Test (release gate)

**Core rule:** no PR, merge or production deploy until `pnpm verify` passes **on the exact commit you ship**, and you've reported its output. Unit tests on the in-memory repo are not enough. They passed while production was broken twice: the version-bump trigger fired on heartbeats, and a documented cancel endpoint had never been implemented.

## What `pnpm verify` runs

`pnpm typecheck && pnpm test && pnpm e2e`

| Suite | File | Proves |
|---|---|---|
| Typecheck | all packages | web and worker agree on the shared types |
| Unit/route | `apps/*/test`, `packages/*/test` | handlers, rules, state machine |
| **Lifecycle E2E** | `apps/worker/test/e2e/lifecycle.e2e.test.ts` | the full flow: order → confirm → location → quote → counter → owner counter → hold → accept → cancel. It uses the real Hono app, signed webhooks, the real `SupabaseRepo` over a PostgREST shim on **real Postgres (PGlite)** with every migration and `seed.sql`, and the web's real `liffFetch`/`ownerFetch`. At every step the DB version, the view's version and the broadcast version agree; real changes bump it; heartbeats don't; stale `If-Match` gets 409 with no change; the audit actors are correct |
| **Web↔worker contract** | `apps/worker/test/e2e/webContract.e2e.test.ts` | parses `apps/web/src` and checks three things: every `/api/...` call hits a real worker route; each literal body's keys match the shared Zod request schema (no unknown keys, no missing required ones); every order-changing POST sends `ifMatch: order.version` |
| Trigger SQL | `apps/worker/test/orderVersionTrigger.test.ts` | `bump_order_version()` from the newest migration |

## Gate procedure

1. Commit the change; `git status` must be clean. Verify the commit, not your working tree.
2. Run `pnpm verify` from the repo root.
3. Report the per-package `Tests N passed` lines in the PR body or the deploy message. If anything fails, stop and fix it; never deploy "to see if it works in prod".
4. After merging, run `pnpm verify` again on `main` before `wrangler deploy` / `pnpm --filter @datawan/web run deploy`. **Not** `pnpm deploy`: that's a built-in pnpm command, not the web's deploy script.
5. A migration ships separately: apply it in the Supabase SQL Editor or with `supabase db push`, then re-check the behaviour with a read-only query.

## Keep the suites honest when you change the system

| You change… | Also do |
|---|---|
| Add or rename a worker route the web calls | Contract test picks it up automatically; add the body schema to `BODY_SCHEMA` |
| Add an order-changing web call | Add it to `NEEDS_IF_MATCH`; send `ifMatch: order.version` |
| Add a status transition or owner/customer action | Add a step to the lifecycle test: assert the version bump and the audit actor |
| New PostgREST query shape in `SupabaseRepo` | Extend `test/e2e/pgrest.ts`; it throws `pgrest shim: unsupported …` on purpose |
| New migration | Nothing; the E2E DB loads every file in `supabase/migrations`. If PGlite rejects it, add a platform stub in `pgrest.ts`, don't skip the file |

## Red flags: stop

- "The unit tests pass, so the E2E is redundant." The in-memory repo doesn't run SQL triggers or constraints.
- "It's a docs/SQL-only change." Migrations and contracts are exactly what the E2E exists for.
- "I'll mock the version / If-Match in the E2E to make it pass." That removes the thing under test. Fix the code.
- "The user said deploy now." Run the gate anyway; it takes about 10 s. If it fails, report the failure instead of deploying.
- Weakening an assertion (`toBeGreaterThanOrEqual` instead of an exact version) to get green.

## Limits (state them in reports)

- PostgREST itself, RLS for anon/authenticated users, Supabase Realtime delivery and Storage are not exercised.
- LINE API, token verification and Web Push are faked.
- These still need a phone test on production after deploy.
