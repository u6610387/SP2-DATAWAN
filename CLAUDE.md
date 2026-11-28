# CLAUDE.md — Da Tawan Seafood (Senior Project 2, Team HighLow)

> Project constitution. Every Claude session and every team member reads this first.
> If any other doc disagrees with this file, **this file wins**; then `docs/PROJECT_SPEC.md`.

**Core philosophy:** *"AI reads, code calculates, the owner decides."*

AI-assisted LINE ordering, dynamic quotation and price negotiation system for **Da Tawan Seafood (ดาทะวันซีฟู้ด)**, a fresh seafood vendor at Thonburi Fresh Market, Bangkok. ~10–20 B2C/B2B delivery orders per day, prices change every morning, no fixed price list.

---

## 1. Team & Ownership

| Member | ID | Owns | Primary folders |
|---|---|---|---|
| Thanadon Ruangpakdee | 6610308 | LINE bot, webhook, backend, order state machine, timers, Quota Guard | `apps/worker/`, `packages/shared/src/state/` |
| Thanakrit Kodklangdon | 6610936 | Gemini pipelines, PII stripping, accuracy benchmark | `packages/ai/`, `eval/` |
| Kitirat Pisithaporn | 6610387 | Owner web dashboard (PWA), LINE LIFF order room, Web Push | `apps/web/` |

**Shared, reviewed by all three:** `packages/shared/src/contracts/` (types + Zod schemas), `supabase/migrations/`. A change to either requires a PR approved by at least one other member, because it can break someone else's work.

## 2. Key Dates

| Milestone | Date |
|---|---|
| Development | Nov 2026 – Jan 2027 |
| Real-shop pilot | Jan – early Feb 2027 |
| **Senior Project Exhibition** | **Fri 26 Feb 2027** |
| **Final Defence** | **Tue 16 – Fri 19 Mar 2027** |
| Handover to owner (0 THB/month) | After passing Final Defence |

---

## 3. Non-Negotiable Rules

### 3.1 Human-in-the-loop (financial & inventory safety)
- AI may only: **parse Thai text, draft polite messages, extract OCR fields** from bills and slips.
- AI output is always a *suggestion* stored in a `*_draft` / `ai_*` column. It never directly writes a final price, a payment status or a stock quantity.
- These transitions are **owner-only** (owner-authenticated endpoint or owner LINE command, never AI, never a timer):
  `price set` · `counter-offer accept/counter/hold` · `payment confirmed` · `dispatch` · `delivered` · `stock in/out` · `supplier bill saved`.
- Code may *reject* or *flag* (e.g. slip amount mismatch → `FAIL` badge), but may not *approve*.
- Every owner decision writes an audit row (`order_events`) with `actor = 'owner'`.

### 3.2 Zero-cost architecture (0 THB/month after handover)
- Everything must run on free tiers: LINE OA Free (300 push/month), Gemini API Free Tier, Supabase Free, Cloudflare Workers Free, Vercel Hobby (or Cloudflare Pages), Longdo Map / OpenStreetMap.
- No paid service may be required by code. Paid keys are allowed **only via `.env`** during dev / Exhibition / Defence.
- Switching dev → owner keys must be a **config-only change** (no code edits). If you need an `if (paid)` branch, it reads an env flag like `GEMINI_TIER`, never a hardcoded value.

### 3.3 PDPA & PII stripping
- Customer names, phone numbers, delivery addresses, LINE display names, LINE user IDs and bank account numbers **never leave our infrastructure** in a Gemini payload.
- All Gemini calls go through `packages/ai/src/pii/` (`stripPII()` before, `restorePII()` after). Calling the Gemini SDK anywhere else is a review-blocking bug.
- PII lives only in Supabase (`users`, `addresses`, `orders.recipient_*`).
- See `docs/API_AND_AI_CONTRACTS.md §5` for the stripping spec and the **open decision on slip images** (slips contain the payer's name — see §8 below).

### 3.4 LINE push quota (300/month on Free)
- Default channel to the customer is **`replyToken` (free) + LIFF realtime (free)**.
- Push messages go through **one function only**: `sendPushGuarded()` in `apps/worker/src/line/quota.ts`. Direct `client.pushMessage()` calls are forbidden.
- 80% (240) → yellow banner on dashboard. 95% (285) → **Quota Saver Mode**: no outbound push until the 1st of next month (Asia/Bangkok).
- Owner notifications use **PWA Web Push**, never LINE push.

### 3.5 Chat fallback
Customers may ignore LIFF and send slips, location pins or text in the chat. The webhook routes every inbound event by the **customer's current active order state** (`users.active_order_id`), never by assuming the customer used the LIFF.

---

## 4. Tech Stack & Conventions

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere (`strict: true`), Node 20+ |
| Monorepo | pnpm workspaces |
| Customer UI | LINE Messaging API + LINE LIFF (`@line/liff`) |
| Dashboard + LIFF frontend | Next.js App Router, Tailwind, shadcn/ui, mobile-first, PWA |
| Backend | Cloudflare Workers (Hono router) + Cron Triggers (every minute) |
| DB / Realtime / Auth / Storage | Supabase Free (Postgres, Realtime, Auth, Storage) |
| AI | Gemini Flash via `@google/genai`, JSON Structured Output |
| Validation | Zod (one schema per contract, shared front/back) |
| QR | `promptpay-qr` |
| Maps | LINE location message + Longdo Map API / OpenStreetMap (Leaflet) |
| Owner alerts | `web-push` style VAPID Web Push (Workers-compatible lib) + Realtime sound/visual alerts |

**Coding conventions**
- **Money is integer satang** (`bigint` in DB columns ending `_satang`, `number` in TS). Never use floats for money. Display with `formatTHB()` from `packages/shared/src/money.ts`.
- **Time:** store `timestamptz` (UTC); display and compute "today" / "month" in `Asia/Bangkok`.
- **Order status** changes only through `transition(order, event)` in `packages/shared/src/state/orderMachine.ts`. No raw `UPDATE orders SET status=`.
- **Idempotency:** LINE can redeliver webhooks; dedupe on `webhookEventId` (`line_events` table).
- Every AI result is validated by Zod after the SDK's own schema enforcement. Invalid → retry once → mark `needs_owner_review`.
- Thai strings shown to customers live in `packages/shared/src/i18n/th.ts`, not inline.
- Commits: Conventional Commits (`feat(worker): ...`). Branches: `feat/<member>-<topic>`.

---

## 5. Folder Structure

```
da-tawan-seafood/
├── CLAUDE.md                 ← this file
├── README.md                 ← onboarding + setup + milestones
├── .env.example
├── docs/
│   ├── PROJECT_SPEC.md
│   ├── ARCHITECTURE_AND_DB.md
│   ├── API_AND_AI_CONTRACTS.md
│   └── AI_EVALUATION.md
├── apps/
│   ├── worker/               ← Cloudflare Worker: LINE webhook, REST API, cron jobs
│   │   └── src/{routes,line,jobs,services}/
│   └── web/                  ← Next.js: /dashboard (owner) + /liff (customer)
│       └── src/app/{dashboard,liff,api}/
├── packages/
│   ├── shared/               ← types, Zod contracts, money, state machine, i18n
│   └── ai/                   ← Gemini client, prompts, PII strip/restore
├── supabase/
│   ├── migrations/           ← SQL, source of truth for schema
│   └── seed.sql
├── eval/
│   ├── datasets/{order_parse,owner_note,supplier_bill,payment_slip}/
│   ├── scripts/
│   └── results/
└── .claude/skills/
    ├── seafood-domain-rules/
    ├── line-liff-architect/
    ├── gemini-structured-pipeline/
    ├── ai-eval-benchmark/
    ├── e2e-system-test/      ← release gate: `pnpm verify` before PR/merge/deploy
    └── security-rls-audit/   ← RLS / authz / secret-leak audit: `pnpm audit:security`
```

---

## 6. Environment Variables (rules)

- All keys and limits live in `.env` (local), Wrangler secrets (worker), Vercel env (web). **Never commit real values.** `.env.example` documents every variable.
- `APP_ENV` ∈ `dev | exhibition | defence | production`. Each has its **own LINE channel and LIFF ID**.
- Supabase Free allows only **2 active projects** per org: use `dp-dev` (dev + exhibition) and `dp-prod` (defence + production). Defence data is wiped before handover.
- Limits are env-driven (`LINE_PUSH_MONTHLY_LIMIT`, `GEMINI_RPM_LIMIT`, `PAYMENT_EXPIRY_MINUTES`, …) so the owner's Free-Tier values are just different numbers.
- Variables prefixed `NEXT_PUBLIC_` are visible in the browser: **only** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `LIFF_ID`, `API_BASE_URL`, `VAPID_PUBLIC_KEY`, `LONGDO_MAP_API_KEY` may use that prefix.

---

## 7. How Claude Should Work in This Repo

1. Read this file, then the relevant `docs/*.md`, then load the matching skill in `.claude/skills/`.
2. Before writing code that touches money, payment, stock or order status → apply `seafood-domain-rules`.
3. LINE / LIFF / webhook work → `line-liff-architect`. Gemini work → `gemini-structured-pipeline`. Accuracy reports → `ai-eval-benchmark`.
   **Before opening any PR, merging to `main`, or deploying anything to production (worker, web or a Supabase migration) → `e2e-system-test`.** Run `pnpm verify` (typecheck + all tests + the E2E lifecycle and web↔worker contract suites) on the exact commit being shipped, and report its result. If it fails, nothing ships.
   **When changing migrations, RLS, Storage, worker routes, request-derived ids/paths or `NEXT_PUBLIC_*` vars, and before every release or Defence demo → `security-rls-audit`** (`pnpm audit:security`, plus read-only production probes; report Critical / Warning / Pass with evidence).
4. If a request would break a rule in §3, say so and propose a compliant alternative instead of implementing it.
5. When a contract in `packages/shared/src/contracts/` must change, update `docs/API_AND_AI_CONTRACTS.md` in the same PR.
6. **Skill priority:** our 6 project skills — `seafood-domain-rules`, `line-liff-architect`, `gemini-structured-pipeline`, `ai-eval-benchmark`, `e2e-system-test`, `security-rls-audit` — always take priority over general-purpose, UI, or vendor/infrastructure skills. This includes both general workflow skills (e.g. `impeccable`, `superpowers`) and the vendor infra skills added for the integration phase (e.g. `cf-cli`, `supabase`, `supabase-postgres-best-practices`, `gemini-api-dev`). A vendor skill is useful for its tool's mechanics (CLI flags, client SDK usage, generic Postgres/RLS technique) but has no knowledge of this project's rules; if its guidance ever conflicts with a domain skill or with CLAUDE.md §3 — e.g. a generic "simplify RLS" suggestion that would weaken `is_owner()` checks, or a Gemini pattern that skips `stripPII()` — the domain skill and §3 win, every time.

---

## 8. Open Decisions & Known Risks (keep this list current)

| # | Topic | Status / notes |
|---|---|---|
| D1 | **Slip images contain the payer's name and masked account.** Free-Tier Gemini content may be used by Google to improve products, so sending raw slips conflicts with §3.3. | Pipeline supports `GEMINI_SLIP_MODE = paid \| redacted \| manual`. Decide with advisor before pilot. `manual` = owner reads slip, code still checks ref uniqueness via QR decode (built: the dashboard decodes the slip's Mini-QR, the worker checks the CRC + transRef uniqueness via `POST /api/owner/payments/:id/qr`; amount, receiver and time still need the owner's eyes, since a bank slip API is ruled out by §3.2). |
| D2 | **Push budget vs. volume.** 15 orders/day ≈ 450 orders/month; even 1 push per order exceeds 300. | "Pull-on-message" replies, daily pacing. **Since 2026-11-28: 3 push slots per order, one each for price quote → total → Lalamove tracking (`MAX_PUSH_PER_ORDER=3`), never twice for a step; counter/hold/notes never push; since 2026-11-29 all three are P1 and ignore LIFF presence, so they land in chat history.** At 3/order the 300 free pushes cover ~95 orders/month, so pacing will defer pushes at real volume. Measure real usage during pilot; report in thesis. |
| D3 | Does owner's manual chat in LINE OA Manager count toward quota? | Verify on the real OA. If free, it becomes a zero-cost fallback for the tracking link. |
| D4 | Payment expiry: 30, 45 or 60 min? Who absorbs a Lalamove price change? | Ask owner. Default `PAYMENT_EXPIRY_MINUTES=45`. |
| D5 | Supabase Free pauses projects after ~7 days with no activity. | Daily orders keep it active; add a weekly cron ping as safety. |
| D6 | Gemini model name changes over time. | Never hardcode; read `GEMINI_MODEL`. Re-run benchmark when it changes. |
