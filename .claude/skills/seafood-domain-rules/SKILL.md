---
name: seafood-domain-rules
description: Enforce Da Tawan Seafood's non-negotiable rules (human-in-the-loop money/stock, 0-THB free-tier architecture, LINE push Quota Guard, PII stripping before Gemini). Use before writing or reviewing any code that touches prices, payments, slips, stock, order status, LINE push, Gemini payloads, env vars or paid services.
---

# Seafood Domain Rules

Apply these checks to every change in this repo that touches money, stock, order status, LINE messaging, AI payloads or infrastructure. Source of truth: `CLAUDE.md §3` and `docs/PROJECT_SPEC.md`.

## 1. Human-in-the-loop gate

**Owner-only actions** (must come from an owner-authenticated request or a LINE message whose `source.userId` is one of `env.LINE_OWNER_USER_ID` — a comma-separated list of owner userIds, parsed to `string[]` in `env.ts`, checked with `isOwnerLineUser()`):
`OWNER_SET_PRICE`, `OWNER_ACCEPT`, `OWNER_COUNTER`, `OWNER_HOLD`, `OWNER_SET_SHIPPING`, `OWNER_CONFIRM_PAYMENT`, `OWNER_REJECT_SLIP`, `OWNER_DISPATCH`, `OWNER_DELIVERED`, stock writes, supplier-bill save.

Checklist when you write or review code:
- [ ] Status changes go through `transition(order, event, actor)`; no raw `UPDATE orders SET status`.
- [ ] Nothing with actor `ai` or `system` can reach `PAID`, `DELIVERING`, `DELIVERED`, or insert into `stock_logs`.
- [ ] AI output is stored as a draft (`ai_parse`, `ai_extract`) and shown for confirmation; it is never copied straight into `product_price_satang`, `payments.confirmed_*`, or stock.
- [ ] Slip checks return `PASS | WARN | FAIL` only. Even `PASS` waits for the owner tap. Confirming on WARN/FAIL requires `override_reason`.
- [ ] AI-extracted prices (owner notes) are accepted only if the number appears literally in the owner's text.
- [ ] Every owner decision inserts `order_events` with `actor='owner'`.
- [ ] Timers (cron) only move orders to waiting/locked/cancelled states (`PAYMENT_EXPIRED`, `CANCELLED` pre-payment), never forward past payment.

Required test (keep it green): enumerate the transition table and assert no `ai`/`system` event targets a protected state.

## 2. Money & numbers
- Integer **satang** everywhere (`_satang` suffix). Convert AI baht floats once: `Math.round(baht * 100)`.
- Margin: `offer − Σ cost_satang`; GREEN if ≥ 0, RED if < 0, GREY if any cost missing.
- Owner numeric commands (`1850`, `ship 120`) parsed by regex, never by AI.
- Totals use the DB generated column `total_satang`; do not recompute in the UI.

## 3. Zero-cost architecture
Reject or redesign anything that needs a paid plan after handover:
- ❌ LINE OA paid plan, Google Maps API, paid Gemini as a hard requirement, Supabase Pro features (e.g. PITR, larger compute), paid cron/queue services, SMS, payment gateways, bank slip-verification APIs.
- ✅ LINE OA Free + replyToken + LIFF, Gemini Free Tier (rate-limited), Supabase Free, Cloudflare Workers Free + Cron, Vercel Hobby / CF Pages, Longdo Map / OSM, VAPID Web Push.
- Paid keys only via `.env` switches (`GEMINI_TIER`, `GEMINI_SLIP_MODE`). Code must work with every value. No `if (APP_ENV === 'defence')` business logic.
- Mind free-tier limits: Supabase 500 MB DB / 1 GB storage / project pause on inactivity; images ≤ 300 KB; 60-day image cleanup.

## 4. LINE Quota Guard
- Only `sendPushGuarded()` may call the push API. Grep check: `pushMessage(` must appear only in `apps/worker/src/line/quota.ts`.
- Modes: `< 80%` NORMAL · `≥ 80%` WARNING (P1 only, yellow banner) · `≥ 95%` QUOTA_SAVER (no push until 00:00 Asia/Bangkok on the 1st).
- `used = max(LINE totalUsage, local_count)`.
- Skip push if `push_count ≥ MAX_PUSH_PER_ORDER`, if the push for that step was already sent, or if today's pacing budget is spent. The presence rule (`customer_last_seen_at` within `LIFF_PRESENCE_SECONDS`) still exists in the guard, but all 3 lifecycle pushes are exempt from it (`PUSH_EVEN_IF_PRESENT`).
- Only 3 push reasons exist (`LIFECYCLE_PUSHES`: `PRICE_READY` → `TOTAL_READY` → `TRACKING_LINK`), at most one push each per order. Counter, hold and owner notes never push. All three are P1 and are sent even while LIFF is open (`PUSH_EVEN_IF_PRESENT`), so they land in the chat history.
- Never push for: 15-min reassurance, expiry notices, generic status, marketing. Use LIFF + pull-on-message replies.
- Owner alerts → Web Push, never LINE push.

## 5. PII before Gemini
- Every Gemini call goes through `packages/ai` `callGemini()` → `stripPII()` → `assertNoPII()` → SDK → Zod → `restorePII()`.
- Never include: names, phones, addresses, LINE user IDs/display names, account numbers, internal UUIDs (use `p0…`, `item_0…` refs).
- Slip images obey `GEMINI_SLIP_MODE` (`paid | manual | redacted`). Do not send slips to a free-tier key.
- Do not log prompts or AI payloads containing user text in production; log `AiCallMeta` only.
- Eval datasets in git must be anonymized.

## 6. Review output format
When reviewing, list violations as:
```
[RULE §n] file:line — what breaks the rule — compliant alternative
```
If a user request itself would break a rule, explain which one and offer the compliant version instead of implementing the violation.
