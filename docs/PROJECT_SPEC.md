# PROJECT_SPEC.md — Functional Specification

Da Tawan Seafood · Senior Project 2 · Team HighLow
Supersedes the workflow in `PROJECT_SUMMARY_V3.md` where they differ (V3 assumed a paid stack; this spec targets 0 THB/month).

---

## 1. Problem Statement

From interviews with the owner:

1. Every order is re-typed by hand into the Lalamove app.
2. No daily sales summary.
3. Stock is tracked on paper and drifts from reality.
4. The owner checks every payment slip by hand.

On top of this, prices change every morning and customers order in casual Thai ("เอากุ้งแม่น้ำตัวใหญ่ๆ โลนึง ส่งพรุ่งนี้เช้า"), so a fixed-menu e-commerce flow does not fit.

## 2. Goals & Non-Goals

**Goals**
- Cut owner typing per order (target: no re-typing for Lalamove, one number to quote a price).
- Give the owner a live Today's Sales Summary and stock view.
- Pre-check slips so the owner only confirms.
- Run at 0 THB/month after handover.

**Non-goals (out of scope for SP2)**
- Automatic Lalamove booking via API (needs a partner account).
- Tax invoices (fresh seafood is VAT-exempt; revisit later).
- Automatic payment confirmation (bank APIs are paid and the owner must decide).
- Multi-shop / multi-tenant support.

---

## 3. User Roles

### 3.1 B2C customer (retail)
| Feature | Channel |
|---|---|
| Register (LINE login, optional name/phone) | LIFF |
| Order in casual Thai | Chat |
| Confirm / edit parsed order | Chat card + LIFF |
| Share delivery location (pin, typed address, Maps link, saved address) + recipient name/phone | Chat or LIFF |
| See price, Accept or Negotiate | LIFF (chat buttons as fallback) |
| See total + PromptPay QR + countdown | LIFF |
| Upload slip | LIFF or chat image |
| Track delivery (Lalamove link) | LIFF |
| Order history | LIFF |

### 3.2 B2B customer (restaurant)
All B2C features, plus:
- Restaurant profile (shop name, contact person, default address, default delivery window).
- Repeat order: chat "สั่งเหมือนอาทิตย์ที่แล้ว" / "เหมือนเดิม" or one-tap **Reorder** in LIFF.
- Scheduled delivery date/time.
- Price suggestion anchored on their previous purchase price for the same product.
- Several open orders at once (see §6.2).

### 3.3 Shop owner
**Via LINE (owner's own LINE account(s), identified by `LINE_OWNER_USER_ID`, a comma-separated list)**: every owner message is answered with that message's free `replyToken`.

| Command | Meaning |
|---|---|
| `A12 1850` | Set product price of order A12 to ฿1,850 |
| `A12 1850 ปูได้ 1.2 กก.` | Same, with a weight-variance note shown to the customer |
| `1850` | Allowed only if exactly one order is `AWAITING_PRICE`; otherwise bot replies with the list of codes |
| `A12 ok` / `A12 hold` / `A12 1700` (while negotiating) | Accept counter / hold original / counter with ฿1,700 |
| `A12 ship 120` | Shipping fee ฿120 |
| `A12 track <url>` | Paste Lalamove tracking link → `DELIVERING` |
| `A12 note ปูหมด มีกุ้งแม่น้ำ 900` | AI drafts a polite substitute message; owner taps **Send** or **Edit** |
| `A12 paid` | Confirm payment (same as dashboard button) |
| `A12 done` | Mark delivered |
| `?` / `list` | List open orders and what each is waiting for |

Owner commands are parsed by **deterministic code** (regex grammar in `apps/worker/src/line/ownerCommands.ts`), never by AI.

**Via Web Dashboard (Supabase Auth login, PWA)**
- Home: **Today's Sales Summary** (revenue, orders, gross margin), live order board, LINE quota bar.
- Order board: kanban by status, margin badge, one-tap actions mirroring LINE commands.
- Inventory & costs: manual stock-in, or snap a supplier bill → AI draft → owner corrects highlighted rows → save.
- Products: name, aliases (Thai spellings/slang), unit, prep types, active flag.
- Price history per product (cost and sell, chart).
- Settings: PromptPay ID, expiry minutes, quota thresholds, Web Push subscription.

---

## 4. The 9-Step Order Workflow

Status names refer to the state machine in `ARCHITECTURE_AND_DB.md §4`.

| # | Step | Customer | Owner | System | Status after |
|---|---|---|---|---|---|
| 1 | Order placement | Types order in chat | – | Gemini parses → reply (replyToken) with confirmation card `Confirm / Edit` + LIFF link. Missing fields → bot asks back. | `AWAITING_CONFIRMATION` → `AWAITING_LOCATION` |
| 2 | Delivery location | Pin / address / Maps link / saved address; recipient name+phone if for someone else | – | Geocode typed address (Longdo/OSM); save `addresses` row | `AWAITING_PRICE` |
| 3 | Product pricing | Waits (LIFF shows "กำลังเช็กของและราคา") | Gets Web Push with cost-based suggested price; sends `A12 1850 [note]` | Price card in LIFF; push only if allowed (§7) | `PRICE_QUOTED` |
| 4 | Negotiation (optional) | Accept, or submit counter-offer | Sees Green/Red margin; `ok` / counter / `hold` | Records each round in `negotiations` | `NEGOTIATING` ↔ `PRICE_QUOTED` → `AWAITING_SHIPPING_FEE` |
| 5 | Shipping fee | Waits | Checks Lalamove app, sends `A12 ship 120` | Generates copy-ready Lalamove card (address, map link, recipient, phone) on dashboard | `AWAITING_PAYMENT` |
| 6 | Total + QR | Sees total + QR + countdown | – | `total = product + shipping`; exact-amount PromptPay QR; starts expiry timer | `AWAITING_PAYMENT` |
| 7 | Payment & slip | Transfers, uploads slip | Reviews check result, taps **Confirm Payment** | Gemini reads slip → code cross-checks → `PASS / WARN / FAIL` badge | `PAYMENT_REVIEW` → `PAID` |
| 8 | Dispatch | Gets tracking link | Books Lalamove with the copy card, pastes link | Shows link in LIFF (push if allowed) | `DELIVERING` |
| 9 | Delivered | – | Taps **Delivered** | Updates Today's Sales; deducts stock (`stock_logs`) | `DELIVERED` |

Out-of-stock substitution can happen at step 3: owner sends `note` → AI drafts → owner approves → customer sees substitute in LIFF and accepts (updates `order_items`) or cancels.

### 4.1 Suggested price (step 3, deterministic)
```
unit_cost      = latest stock-in cost per unit for the product (stock_logs, last 3 days), else last known
suggested_sell = round_up_to_10( unit_cost × qty × (1 + DEFAULT_MARKUP) )
B2B anchor     = if customer bought same product in last 30 days:
                 previous_unit_price × qty   (shown side by side; owner picks)
```
`DEFAULT_MARKUP` is a setting (default 0.25). The owner can always ignore the suggestion.

### 4.2 Margin indicator (step 4)
```
margin_satang = offered_price_satang − Σ(item cost_satang)
color = margin ≥ 0 ? GREEN : RED      margin_pct = margin / offered_price
```
Shown on both the dashboard and the owner's LINE reply. Cost unknown → grey "no cost data".

---

## 5. Slip Cross-Check Rules (step 7)

Gemini extracts `amount`, `date_time`, `receiver_name_or_id`, `reference_no`. Code then checks:

| Check | Rule | Fail → |
|---|---|---|
| Amount | `slip.amount_satang == order.total_satang` | FAIL |
| Time | `quoted_at ≤ slip.date_time ≤ now + 5 min` | WARN |
| Receiver | normalized receiver matches `PROMPTPAY_RECEIVER_NAME` or the last 4 digits of `PROMPTPAY_ID` | FAIL |
| Reference | `reference_no` not used by any other payment (unique index) | FAIL (possible reused slip) |
| AI confidence | any required field null | WARN, "อ่านไม่ออก" |

Badge = worst result. **Even PASS requires the owner's tap.** The owner can confirm on WARN/FAIL with a reason (e.g. customer paid in two transfers).

---

## 6. Edge Cases

### 6.1 Actual weight variance
Seafood is sold by weight, but the real weight is known only after weighing (e.g. ordered 1 kg crab, got 1.2 kg).
- Owner quotes a **lump-sum product price** plus an optional free-text note (`A12 1850 ปูได้ 1.2 กก.`).
- Optional `order_items.actual_qty` lets the owner record the weighed amount; stock deduction uses `actual_qty ?? qty`.
- If the weight changes *after* payment, the owner handles it outside the system (refund/extra transfer) and adds an `order_events` note. No automatic re-billing.

### 6.2 Multi-order state (B2B overlap)
- `users.active_order_id` = the order that new chat input is routed to (most recently created non-final order by default).
- LIFF always works per order (`/liff/orders/{orderId}`), so it is never ambiguous.
- Ambiguous chat input (e.g. slip image while 2 orders are `AWAITING_PAYMENT`): bot replies with Quick Reply buttons listing order codes + totals; customer taps one.
- Slip amount exactly matching one of the open totals → pre-select that order but still ask to confirm.
- New text that looks like an order while another order is open → ask "สั่งเพิ่มในออเดอร์ A12 หรือเปิดออเดอร์ใหม่?"

### 6.3 Timeouts
| Timer | Default | Action | Channel |
|---|---|---|---|
| Owner response | 15 min after `AWAITING_PRICE` | Customer LIFF shows reassurance; Web Push reminder to owner; reply-on-next-message includes reassurance | LIFF + Web Push (**no LINE push**) |
| Payment expiry | `PAYMENT_EXPIRY_MINUTES` (30–60) | Order → `PAYMENT_EXPIRED` (locked). Owner re-checks Lalamove fee → `ship N` reopens with new QR | LIFF + Web Push |
| Slip after expiry | – | Slip still accepted into `PAYMENT_REVIEW` with WARN "หลังหมดเวลา"; owner decides | – |
| Abandoned | 24 h with no customer action before payment | Auto `CANCELLED` (no money involved) | LIFF |

Timers run in a Cloudflare Cron Trigger every minute and only *move to waiting/locked* states; they never mark anything paid or delivered.

### 6.4 Other cases
- **Customer edits after price quoted:** order returns to `AWAITING_PRICE`; previous quote kept in the `negotiations` history (action `quote`).
- **Location outside delivery area / unknown address:** geocode fails → ask for a pin; owner can still set shipping manually.
- **Owner offline all day:** orders stay `AWAITING_PRICE`; nothing is auto-priced.
- **Duplicate webhook delivery:** deduped by `webhookEventId`.
- **Unreadable image** (not a slip): Gemini returns `is_slip=false` → bot asks again politely.
- **Customer blocks the OA:** `unfollow` event → mark user inactive; skip pushes.
- **Price list unknown product** ("ปลาอะไรก็ได้ที่สด"): Gemini returns `product_id=null` + `raw_text`; owner resolves when quoting.

---

## 7. LINE Push Quota Guard

**Facts:** LINE OA Free = 300 push messages/month; replies via `replyToken` are free; a reply token is single-use and must be used shortly after the event.

### 7.1 Monitoring
- Every 10 min (cron) + on dashboard load: `GET https://api.line.me/v2/bot/message/quota` (limit) and `GET https://api.line.me/v2/bot/message/quota/consumption` (`totalUsage`). Store snapshot in `quota_logs`.
- Dashboard home shows `X / 300` progress bar.

| Usage | Mode | Behaviour |
|---|---|---|
| < 80% (< 240) | NORMAL | Push allowed per priority rules |
| ≥ 80% (240) | WARNING | Yellow banner; only P1 pushes |
| ≥ 95% (285) | QUOTA_SAVER | **All outbound push halted** until 00:00 Asia/Bangkok on the 1st; replyToken + LIFF Realtime only |

The guard also keeps its own counter (`quota_logs.local_count`) because LINE's consumption number may lag; the higher of the two is used.

### 7.2 Push priority & budget
| Priority | Event | Rule |
|---|---|---|
| P1 | Price ready (step 3), Total + QR ready (step 6), Tracking link (step 8) | Sent **even if the customer's LIFF is open**, so all three stay in the LINE chat history (2026-11-29). Held back only by Quota Saver, the daily budget, or the once-per-step rule |
| Never | Owner counter / hold, owner notes (substitute offers), 15-min reassurance, payment expiry, status changes, marketing | LIFF / reply only (notes: LIFF card + once in the next chat reply) |

Additional rules:
- **3 push slots per order** (`MAX_PUSH_PER_ORDER=3`), one per lifecycle step: price quote → total → tracking. **At most one push per step**: a re-quote or a corrected shipping fee doesn't push again (the customer sees it in LIFF / pull-on-message).
- **Daily pacing:** `daily_budget = floor(remaining / days_left_in_month)`. Exceeding today's budget → defer to pull-on-message.
- **Pull-on-message:** whenever the customer sends *anything*, the reply (free) includes any pending update for their active order.
- The reply to step 1 tells the customer: "ราคาและสถานะจะอัปเดตในหน้านี้ กดลิงก์ได้ตลอด" so they learn to check LIFF.

> Risk D2 in `CLAUDE.md`: at ~450 orders/month the budget is below 1 push/order. Pilot data will show the real push-per-order rate; report it in the thesis.

---

## 8. Owner Notifications (zero LINE quota)
- PWA Web Push (VAPID) to every subscribed owner device on: new order, counter-offer, slip uploaded, owner-timeout reminder, payment expired, quota warning.
- Dashboard open → Supabase Realtime + sound + toast.
- iOS needs the PWA added to the Home Screen (iOS 16.4+) for Web Push; README covers setup on the owner's phone.

---

## 9. Non-Functional Requirements
| Area | Requirement |
|---|---|
| Latency | Order parse reply ≤ 5 s p95 (well inside reply-token validity) |
| Availability | Free-tier best effort; webhook must return 200 quickly and never crash on bad input |
| Security | Owner endpoints require Supabase Auth JWT; LIFF endpoints verify LIFF ID token; webhook verifies `x-line-signature` |
| Privacy | PDPA: consent text at registration; PII never in Gemini payloads; slip/bill images deleted after 60 days |
| Storage | Images compressed to ≤ 300 KB before upload; 60-day cleanup keeps us under 1 GB |
| Usability | Dashboard fully usable one-handed on a phone; big buttons; Thai UI |
| Auditability | Every status change and owner decision in `order_events` |

## 10. Acceptance Criteria (for Final Defence)
- [ ] A full order runs steps 1–9 with real LINE accounts, B2C and B2B.
- [ ] No code path lets AI or a timer set `PAID`, `DELIVERED` or change stock (show tests).
- [ ] Quota Saver Mode demonstrably halts pushes (simulated quota).
- [ ] A PII-leak test over the eval set shows 0 leaked phone numbers/names in Gemini payloads.
- [ ] Accuracy report for all 4 AI tasks (`AI_EVALUATION.md`).
- [ ] Switching from team keys to owner keys done by `.env` only (demo it).
