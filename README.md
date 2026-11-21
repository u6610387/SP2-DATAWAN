# Da Tawan Seafood 🦐 — Team HighLow

AI-assisted LINE ordering, dynamic quotation and price negotiation for **ดาทะวันซีฟู้ด**, Thonburi Fresh Market.
Senior Project 2 · Computer Science · Assumption University

> *"AI reads, code calculates, the owner decides."*

| Member | ID | Area |
|---|---|---|
| Thanadon Ruangpakdee | 6610308 | LINE Bot & Backend (`apps/worker`) |
| Thanakrit Kodklangdon | 6610936 | Gemini AI & Accuracy Testing (`packages/ai`, `eval`) |
| Kitirat Pisithaporn | 6610387 | Web Dashboard & LINE LIFF (`apps/web`) |

---

## 1. Read First

1. [`CLAUDE.md`](CLAUDE.md) — rules that every PR must follow (human-in-the-loop, 0 THB, PII, LINE quota).
2. [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) — what we build.
3. [`docs/ARCHITECTURE_AND_DB.md`](docs/ARCHITECTURE_AND_DB.md) — architecture, schema, state machine.
4. [`docs/API_AND_AI_CONTRACTS.md`](docs/API_AND_AI_CONTRACTS.md) — the interfaces between our three areas.
5. [`docs/AI_EVALUATION.md`](docs/AI_EVALUATION.md) — how we measure AI accuracy.

Claude Code users: skills in `.claude/skills/` load automatically; `CLAUDE.md` tells Claude which to use when.

---

## 2. Prerequisites

- Node.js 20+, pnpm 9+ (`corepack enable`)
- Supabase CLI (`brew install supabase/tap/supabase`) and Docker (for local Supabase) — or use the shared `dp-dev` cloud project
- Cloudflare account + Wrangler (`pnpm dlx wrangler login`)
- A tunnel: `cloudflared` (recommended, free) or ngrok
- LINE Developers account with access to the team provider
- Google AI Studio API key (Gemini)

## 3. Local Setup

```bash
git clone <repo> da-tawan-seafood && cd da-tawan-seafood
pnpm install
cp .env.example .env            # fill values — ask the team lead for dev keys
```

### 3.1 Supabase
```bash
# Option A: local (Docker)
supabase start                  # prints local URL + anon/service keys → put into .env
supabase db reset               # runs supabase/migrations + seed.sql

# Option B: shared cloud dev project
supabase link --project-ref <dp-dev-ref>
supabase db push
```
Create the owner login: Supabase Studio → Authentication → Add user → then set raw **app_metadata** to `{"role":"owner"}`.

### 3.2 LINE channels (per environment)
Create in LINE Developers, one set per `APP_ENV` (dev / exhibition / defence):
1. **Messaging API channel** → copy Channel secret + issue long-lived Channel access token. In LINE OA Manager: turn **auto-reply messages OFF**, **webhooks ON**, greeting off (we send our own).
2. **LINE Login channel** (same provider) → add a **LIFF app**: size `Full`, endpoint `https://<your-tunnel>/liff`, scopes `openid profile`. Copy LIFF ID.
3. Get the owner's LINE `userId`: send any message to the bot from the owner account and read it from the worker log → `LINE_OWNER_USER_ID`.

### 3.3 Run the Worker + tunnel
```bash
pnpm --filter worker dev                         # wrangler dev on :8787
cloudflared tunnel --url http://localhost:8787   # gives https://xxxx.trycloudflare.com
```
Set LINE webhook URL to `https://xxxx.trycloudflare.com/webhook` → **Verify** → enable **Use webhook**.
Quick-tunnel URLs change on restart; use a named tunnel for a stable URL.

### 3.4 Run the web app (dashboard + LIFF)
```bash
pnpm --filter web dev                            # Next.js on :3000
cloudflared tunnel --url http://localhost:3000   # LIFF endpoint must be HTTPS
```
- Dashboard: `http://localhost:3000/dashboard`
- LIFF: open `https://liff.line.me/<LIFF_ID>` inside LINE on your phone.

### 3.5 VAPID keys for owner Web Push
```bash
pnpm dlx web-push generate-vapid-keys
```
iPhone owner: open the dashboard in Safari → Share → **Add to Home Screen**, open from the icon, then allow notifications (iOS 16.4+).

### 3.6 Useful scripts
| Command | What |
|---|---|
| `pnpm dev` | worker + web together |
| `pnpm test` | unit tests (incl. state-machine safety test) |
| `pnpm typecheck` / `pnpm lint` | CI checks |
| `pnpm eval:run --task order_parse` | AI benchmark (see `AI_EVALUATION.md`) |
| `AI_MOCK=1 pnpm --filter worker dev` | worker without calling Gemini |

---

## 4. Deploy

| Part | Where | Command |
|---|---|---|
| Worker | Cloudflare Workers | `pnpm --filter worker deploy --env <exhibition\|defence\|production>` (secrets via `wrangler secret put`) |
| Web | Vercel Hobby / Cloudflare Pages | push to `main` (env vars set per environment) |
| DB | Supabase | `supabase db push` to the linked project |

### Handover to the owner (after Final Defence)
- [ ] Owner's own Google AI Studio key → `GEMINI_API_KEY`, `GEMINI_TIER=free`, real free-tier limits, `GEMINI_SLIP_MODE` per decision D1
- [ ] Owner's LINE OA channel (Free plan) → LINE secrets; LIFF endpoint updated
- [ ] Supabase project transferred to the owner's account (or new project + `db push`); wipe defence data
- [ ] Cloudflare/Vercel accounts transferred or re-deployed under the owner
- [ ] PromptPay ID + receiver name = owner's
- [ ] Owner phone: PWA installed, push enabled, password set
- [ ] One-page Thai user guide + 30-min training done
- [ ] Confirm monthly bill = 0 THB on every service dashboard

---

## 5. Working Agreement

- Branch `feat/<name>-<topic>`, PR to `main`, 1 review required. Contracts/migrations: review by an affected member.
- Never commit `.env`, real customer data, or unanonymized slips.
- Weekly sync: Monday evening; demo what works, update the checklist below.
- Bugs/tasks: GitHub Issues with labels `worker`, `web`, `ai`, `eval`, `docs`.

---

## 6. Milestone Checklist

### Phase 1 — Foundations (20 Nov – 6 Dec 2026)
- [ ] Monorepo scaffold, CI (typecheck, lint, test) — *all*
- [ ] `0001_init.sql` applied to `dp-dev`; seed products from owner's list — *Thanadon*
- [ ] Shared contracts package (Zod) from `API_AND_AI_CONTRACTS.md` — *all*
- [ ] LINE dev channel + webhook echo + signature verify + dedupe — *Thanadon*
- [ ] Next.js app shell, Supabase Auth login, PWA manifest — *Kitirat*
- [ ] Gemini client wrapper + PII strip/restore + unit tests — *Thanakrit*
- [ ] Ask owner for sample chats/bills/slips + permission; ask D4 questions — *all*

### Phase 2 — Core order flow (7 Dec 2026 – 3 Jan 2027)
- [ ] State machine + safety test (no AI/system path to PAID/DELIVERED/stock) — *Thanadon*
- [ ] Steps 1–2: parse → confirm card → location — *Thanadon + Thanakrit*
- [ ] Owner commands (`1850`, `ship`, `track`, `paid`, `done`) — *Thanadon*
- [ ] LIFF order room (status, price, accept/counter, QR, countdown, slip upload) — *Kitirat*
- [ ] Dashboard order board + margin badge + Lalamove copy card — *Kitirat*
- [ ] Quota Guard + `sendPushGuarded` + quota bar — *Thanadon + Kitirat*
- [ ] Labeling guide + 10 samples/task — *Thanakrit*

### Phase 3 — Complete features (4 – 17 Jan 2027)
- [ ] Slip pipeline + cross-check + owner confirm — *Thanakrit + Thanadon*
- [ ] Supplier bill OCR → highlighted rows → save to stock — *Thanakrit + Kitirat*
- [ ] Owner note → polite draft → send — *Thanakrit*
- [ ] B2B: profile, reorder, scheduled delivery, anchor price — *all*
- [ ] Timers (15-min, expiry, abandon), Web Push, 60-day cleanup — *Thanadon + Kitirat*
- [ ] Today's Sales Summary, stock view, price history — *Kitirat*
- [ ] 30 samples/task labeled, split frozen, baseline run — *Thanakrit*

### Phase 4 — Real-shop pilot (18 Jan – 7 Feb 2027)
- [ ] Deploy `exhibition` env; owner trained; run with real customers
- [ ] Log HER, pushes/order, owner time per order weekly
- [ ] Fix top issues from the owner; freeze features 7 Feb

### Phase 5 — Exhibition (8 – 26 Feb 2027)
- [ ] Final test-set benchmark (3 runs) by 12 Feb
- [ ] Poster, demo script, backup demo video (in case of venue Wi-Fi/LINE issues)
- [ ] Exhibition LINE channel + paid Gemini key active; quota simulated for Quota Saver demo
- [ ] **Fri 26 Feb 2027 — Senior Project Exhibition** 🎯

### Phase 6 — Final Defence (27 Feb – 19 Mar 2027)
- [ ] Thesis complete (evaluation chapter, pilot results, limitations: D1/D2)
- [ ] Defence slides + live demo on `defence` env; rehearse twice with timer
- [ ] Demo `.env` switch to free-tier keys (zero code change)
- [ ] **Tue 16 – Fri 19 Mar 2027 — Final Defence** 🎓
- [ ] Handover checklist (§4) completed
