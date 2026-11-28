# API_AND_AI_CONTRACTS.md — Interfaces Between Team Members

Purpose: let Thanadon (Worker), Thanakrit (AI) and Kitirat (Web/LIFF) build in parallel. Everything here becomes code in `packages/shared/src/contracts/` (Zod schemas + inferred TS types). Mock any side you depend on using the examples in this doc.

**Ownership:** contracts are shared. Change = PR touching both this doc and `packages/shared/src/contracts/`, approved by one other member.

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Base URL | Worker: `https://<worker>.workers.dev` (env `NEXT_PUBLIC_API_BASE_URL` in web) |
| Content type | `application/json; charset=utf-8` (multipart only for image upload) |
| Money | `*_satang` integers. ฿1,850 = `185000` |
| Time | ISO 8601 with offset. Server returns UTC (`Z`); UI converts to Asia/Bangkok |
| IDs | UUID strings. Short order code (`A12`) is for humans/LINE only |
| Errors | `{ "error": { "code": "ORDER_STATE_INVALID", "message": "..." } }` + HTTP 4xx/5xx |
| Concurrency | Mutating calls accept `If-Match: <order.version>`; mismatch → `409 VERSION_CONFLICT` |
| Auth: LIFF | `Authorization: Bearer <LIFF ID token>` (from `liff.getIDToken()`); Worker verifies via `POST https://api.line.me/oauth2/v2.1/verify` with `client_id` = LINE Login channel ID |
| Auth: owner | `Authorization: Bearer <Supabase access token>`; Worker verifies and requires `app_metadata.role = 'owner'` |

### 1.1 Error codes
`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `ORDER_STATE_INVALID`, `VERSION_CONFLICT`, `QUOTA_SAVER_ACTIVE` (informational), `AI_UNAVAILABLE`, `AI_OUTPUT_INVALID`, `SLIP_REFERENCE_REUSED`, `INVALID_FROM_STATE` and `TOO_MANY_DOCUMENTS` (B2B account, 409), `INTERNAL`.

---

## 2. REST API (Cloudflare Worker, Hono)

### 2.1 Shared view models

```ts
// packages/shared/src/contracts/views.ts
export type OrderStatus =
  | 'AWAITING_CONFIRMATION' | 'AWAITING_LOCATION' | 'AWAITING_PRICE'
  | 'PRICE_QUOTED' | 'NEGOTIATING' | 'AWAITING_SHIPPING_FEE'
  | 'AWAITING_PAYMENT' | 'PAYMENT_EXPIRED' | 'PAYMENT_REVIEW'
  | 'PAID' | 'DELIVERING' | 'DELIVERED' | 'CANCELLED';

export type PrepType = 'live' | 'chilled' | 'frozen' | 'cooked' | 'any';
export type Unit = 'kg' | 'piece' | 'box' | 'tray' | 'set';

export interface OrderItemView {
  id: string;
  productId: string | null;
  name: string;              // product name or raw text if unknown
  qty: number;
  unit: Unit;
  prepType: PrepType;
  actualQty: number | null;
}

/** What the customer's LIFF sees. Never contains cost or margin. */
export interface CustomerOrderView {
  id: string;
  code: string;
  status: OrderStatus;
  version: number;
  items: OrderItemView[];
  productPriceSatang: number | null;
  priceNote: string | null;
  shippingFeeSatang: number | null;
  totalSatang: number | null;
  paymentExpiresAt: string | null;
  promptpayPayload: string | null;   // EMVCo string; LIFF renders the QR client-side
  trackingUrl: string | null;
  negotiation: { round: number; actor: 'owner' | 'customer'; action: string; amountSatang: number | null; message: string | null }[];
  delivery: { recipientName: string | null; addressText: string | null; lat: number | null; lng: number | null; requestedDeliveryAt: string | null };
  realtime: { channel: string };     // 'order:{id}:{token}'
  ownerDelayed: boolean;             // true after 15-min owner timeout → show reassurance
  shopNote?: { text: string; at: string } | null; // LIFF only: latest owner-approved note (notes are never pushed)
}

/** What the owner dashboard sees. */
export interface OwnerOrderView extends Omit<CustomerOrderView, 'realtime'> {
  customer: { id: string; type: 'B2C' | 'B2B'; name: string | null; businessName: string | null; phone: string | null;
    b2b: { businessName: string; deliveryWindow: string | null } | null };  // non-null only while the business profile is VERIFIED (badge)
  rawOrderText: string | null;
  costSatang: number | null;            // Σ item costs, null if unknown
  suggestedPriceSatang: number | null;  // cost-plus
  b2bAnchorPriceSatang: number | null;  // previous purchase basis
  marginSatang: number | null;          // vs current offer
  marginColor: 'GREEN' | 'RED' | 'GREY';
  latestPayment: PaymentCheckView | null;
  lalamoveCard: { text: string; mapUrl: string | null } | null;  // copy-ready
  needsOwnerReview: boolean;            // AI failed / low confidence
  pushCount: number;
}

export interface PaymentCheckView {
  id: string;
  result: 'PENDING' | 'PASS' | 'WARN' | 'FAIL';
  checks: { rule: 'AMOUNT' | 'TIME' | 'RECEIVER' | 'REFERENCE' | 'READABLE'; result: 'PASS' | 'WARN' | 'FAIL'; detail: string }[];
  extracted: SlipReadResult | null;
  slipImageUrl: string | null;          // signed URL, 10 min
}
```

### 2.2 Customer (LIFF) endpoints — owner: Thanadon, consumer: Kitirat

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/liff/me` | – | `{ user, addresses[] , registered: boolean }` | Creates user row on first call |
| POST | `/api/liff/register` | `{ fullName?, phone?, userType, businessName?, defaultDeliveryWindow?, pdpaConsent: true }` | `{ user }` | `pdpaConsent` must be `true` |
| GET | `/api/liff/orders?scope=open\|history` | – | `CustomerOrderSummary[]` (`{ id, code, status, createdAt, deliveredAt, itemsPreview[≤3], itemCount, totalSatang, reorderable }`) | Own orders only (user from the LIFF token), newest first, max 20. `history` = `DELIVERED` + `CANCELLED`, `open` = the rest. `reorderable` = `DELIVERED` with ≥ 1 item whose product is still active. Never cost/margin. Default scope `history`; anything else → 400 |
| GET | `/api/liff/orders/:id` | – | `CustomerOrderView` | 404 if not this user's |
| PATCH | `/api/liff/orders/:id/items` | `{ items: {id?, productId?, name, qty, unit, prepType}[] }` | `CustomerOrderView` | Allowed ≤ `PRICE_QUOTED`; returns to `AWAITING_PRICE` if already quoted |
| POST | `/api/liff/orders/:id/confirm` | – | `CustomerOrderView` | `If-Match`. `AWAITING_CONFIRMATION → AWAITING_LOCATION` (`CUSTOMER_CONFIRM`, actor customer). 422 if the order has no items or the AI draft still has `missing_fields` |
| POST | `/api/liff/orders/:id/location` | `OrderAddressRequest { addressId }` (built). The `{ lat, lng, … }` form is **not built**: new pins come through the chat location message | `CustomerOrderView` | `If-Match`. Only in `AWAITING_LOCATION`. `addressId` must be one of the caller's own addresses (else 404). With a recipient (address, else profile) → `LOCATION_SET` → `AWAITING_PRICE` + owner `NEW_ORDER` Web Push; without one the order is held for the recipient card. Audit `ADDRESS_REUSED` |
| POST | `/api/liff/geocode` | `{ query: string }` | `{ candidates: {label, lat, lng}[] }` | Longdo → OSM fallback |
| POST | `/api/liff/orders/:id/accept` | – | `CustomerOrderView` | |
| POST | `/api/liff/orders/:id/counter` | `{ amountSatang, message? }` | `CustomerOrderView` | `amountSatang` < current offer |
| POST | `/api/liff/orders/:id/recipient` | `{ recipientName, recipientPhone, pdpaConsent: true }` (`RecipientContactRequest`; phone normalised by `normalizeThaiPhone`: 9–10 digits starting with 0, `+66`, dashes and Thai digits accepted) | `CustomerOrderView` | `If-Match`. Saves to the order, its address and the user profile (`full_name`, `phone`, `pdpa_consent_at` on first consent). If the order is held in `AWAITING_LOCATION` with a location, fires `LOCATION_SET` (owner alerted). Allowed until `DELIVERING`. Audit `RECIPIENT_SET` with no PII in the payload |
| POST | `/api/liff/orders/:id/slip-upload-url` | `{ contentType }` | `{ uploadUrl, path }` | Signed Storage upload URL, 5 min |
| POST | `/api/liff/orders/:id/slip` | `{ path }` | `CustomerOrderView` | Body `{ path, qrPayload }`. `qrPayload` is the bank Mini-QR text the customer's browser decoded **before** uploading; the Worker re-validates it with `parseSlipQr` (format + CRC; no image decoding on Workers) → **422 `NOT_A_SLIP`** if invalid. Only in `AWAITING_PAYMENT` / `PAYMENT_EXPIRED` (else 409; `slip-upload-url` too). `path` must be `slips/<this order id>/<uuid>.<jpeg\|png\|webp>` (as issued by `slip-upload-url`), else 400 before Storage is read. Payment `check_details.source = 'liff'`, `client_qr = { sending_bank }` |
| POST | `/api/liff/orders/:id/cancel` | `{ reason? }` | `CustomerOrderView` | Only before `PAYMENT_REVIEW` |
| POST | `/api/liff/orders/:id/heartbeat` | – | `204` | Every 30 s while visible |
| POST | `/api/liff/reorder` | `ReorderRequest { sourceOrderId, requestedDeliveryAt? }` | `ReorderResponse` = `CustomerOrderView` + `{ skippedItems: string[], deduped: boolean }` (201 new, 200 deduped) | **B2C and B2B.** Source must be the caller's (else 404) and `DELIVERED` (else 409 `INVALID_FROM_STATE`). Copies product/qty/unit/prep/note of items whose product is still active; **no Gemini call, no prices** (owner quotes as usual, §3.1); no LINE push. Skipped items → `needs_owner_review=true`; none left → 409 `NOTHING_TO_REORDER`. An unconfirmed reorder of the same source is returned instead of a duplicate. New order: `channel='liff'`, `source_order_id` set, becomes `users.active_order_id`. The view's `reuseAddress` offers the source order's address while `AWAITING_LOCATION` |
| GET | `/api/liff/account` | – | `CustomerAccountView` | B2B account; see §2.3a |
| POST | `/api/liff/account/b2b/doc-upload-url` | `B2bDocUploadUrlRequest { contentType }` | `{ uploadUrl, path }` | §2.3a; 409 `TOO_MANY_DOCUMENTS` at 3 un-purged documents |
| POST | `/api/liff/account/b2b` | `B2bApplyRequest` (incl. `pdpaConsent: true`) | `CustomerAccountView` | §2.3a; 409 `TOO_MANY_DOCUMENTS` / `INVALID_FROM_STATE` |

### 2.3 Owner endpoints — owner: Thanadon, consumer: Kitirat

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/owner/summary/today` | – | `{ ordersDelivered, productRevenueSatang, shippingCollectedSatang, grossMarginSatang, openByStatus: Record<OrderStatus, number> }` |
| GET | `/api/owner/orders?status=...` | – | `OwnerOrderView[]`: every open order. Built from a fixed number of batch queries (~11, whatever the order count; Workers Free allows 50 subrequests per request). Same values as `/orders/:id`, except `latestPayment.slipImageUrl` is always `null` here: the slip is signed on the detail page |
| GET | `/api/owner/orders/:id` | – | `OwnerOrderView` |
| POST | `/api/owner/orders/:id/price` | `{ amountSatang, note? }` | `OwnerOrderView` |
| POST | `/api/owner/orders/:id/negotiation` | `{ action: 'accept' \| 'counter' \| 'hold', amountSatang? }` | `OwnerOrderView` |
| POST | `/api/owner/orders/:id/shipping` | `{ feeSatang }` | `OwnerOrderView` (incl. `lalamoveCard`) |
| POST | `/api/owner/orders/:id/note-draft` | `{ note }` | `{ draftId, result: OwnerNoteResult }` |
| POST | `/api/owner/orders/:id/note-send` | `{ draftId, messageTh, substitutes }` (owner-edited) | `OwnerOrderView` |
| POST | `/api/owner/payments/:id/confirm` | `{ overrideReason? }` (required if result ≠ PASS) | `OwnerOrderView` |
| POST | `/api/owner/payments/:id/reject` | `{ reason }` | `OwnerOrderView` |
| POST | `/api/owner/payments/:id/qr` | `{ payload: string \| null }` (`SlipQrRequest`: Mini-QR text the owner's dashboard decoded from the stored slip; `null` = no QR found) | `OwnerOrderView`. Parses `00{00 000001, 01 bank, 02 transRef} 51 TH 91 CRC-16/CCITT-FALSE`; sets the `REFERENCE` check: PASS = valid CRC and unused transRef (stored in `payments.reference_no`), FAIL = bad CRC, a transRef already used by another order, or one that differs from the AI-read reference, WARN = no QR / not a slip QR. `check_result` = the worst check. Never changes order status; 409 once the payment is confirmed. Audit event `SLIP_QR_CHECKED` (actor owner) |
| POST | `/api/owner/orders/:id/dispatch` | `{ trackingUrl }`: the link or the courier app's pasted share text; `extractTrackingUrl` keeps the first link, adds/forces `https://`, and stores only that (400 if there's no link) | `OwnerOrderView` (`PAID → DELIVERING`; P1 `TRACKING_LINK` push via `sendPushGuarded`, outcome in `trackingPush: { sent, reason }`) |
| POST | `/api/owner/orders/:id/delivered` | `{ actualQty?: {itemId, actualQty}[] }` | `OwnerOrderView` |
| POST | `/api/owner/orders/:id/cancel` | `{ reason }` (`CancelOrderRequest`, 1–200 chars) | `OwnerOrderView`. `OWNER_CANCEL`: any state before `PAID` (incl. `PAYMENT_EXPIRED`, `PAYMENT_REVIEW`), else 409. Sets `cancel_reason = 'owner: <reason>'`, clears `users.active_order_id` if it pointed at this order, no LINE push |
| POST | `/api/owner/supplier-bills` | multipart `image` | `{ billId, result: SupplierBillResult, flags: BillFlag[] }` |
| POST | `/api/owner/supplier-bills/:id/save` | `{ supplierName?, billDate?, lines: {productId, qty, unitCostSatang}[] }` | `{ stockLogIds[] }` |
| GET | `/api/owner/products` | – | `{ id, nameTh, unit, isActive, aliases, prepTypes, categoryId }[]` (active) |
| POST | `/api/owner/products` | `ProductCreateRequest { nameTh, unit, prepTypes = ['any'], aliases = [], categoryId = null }` | 201 product. **Same name as an existing active product that has no category, and a category given → 200 `{ …product, merged: true }`**: the category is assigned and the new aliases merged (no new row). The name is always added as an alias (aliases < 2 chars dropped, de-duplicated), so the order parser, which reads the active catalog on every message, recognises it at once. **409 `DUPLICATE`** for an existing active name or an alias already used by another active product; 404 for an unknown category |
| GET / POST | `/api/owner/categories` | POST `CategoryCreateRequest { nameTh }` | `{ id, nameTh, sort }[]` / 201 category; 409 `DUPLICATE` for a name already active (migration `0006`: `categories` + `products.category_id`) |
| PATCH | `/api/owner/products/:id` | `ProductUpdateRequest` (any of `nameTh, unit, prepTypes, aliases, categoryId, isActive`; at least one) | product. The name stays an alias (a rename drops the old name and adds the new one); name and alias conflicts are checked against the *other* active products → 409; unknown product or category → 404; `isActive: false` removes it from the parser's catalog |
| GET | `/api/owner/stock` | – | `{ productId, nameTh, unit, onHand, categoryId, categoryName, isActive, aliases }[]` (`product_stock` view; `aliases` for active products) |
| POST | `/api/owner/stock` | `{ productId, reason, qtyDelta, unitCostSatang?, note? }` | `{ stockLogId }` |
| GET | `/api/owner/price-history?productId=` | – | `{ points: {kind, unitPriceSatang, recordedAt}[] }` |
| GET | `/api/owner/quota` | – | `QuotaStatus` |
| POST | `/api/owner/push-subscriptions` | `PushSubscriptionJSON` | `204` |
| GET | `/api/owner/customers?filter=pending\|b2b\|all` | – | `OwnerB2bSummaryView[]` (§2.3a) |
| GET | `/api/owner/customers/:userId` | – | `OwnerB2bDetailView` (§2.3a) |
| POST | `/api/owner/customers/:userId/approve` · `/acknowledge` | `OwnerB2bDecisionRequest { expectedUpdatedAt }` | `OwnerB2bDetailView`; 409 `INVALID_FROM_STATE` (wrong state or changed since the view), 404 unknown user (§2.3a) |
| POST | `/api/owner/customers/:userId/reject` · `/revoke` | `OwnerB2bReasonRequest { reason, expectedUpdatedAt }` | `OwnerB2bDetailView`; 409 `INVALID_FROM_STATE` (wrong state or changed since the view), 404 unknown user (§2.3a) |

```ts
export interface QuotaStatus {
  month: string;            // '2027-01'
  limit: number;            // 300
  used: number;             // max(LINE totalUsage, local_count)
  mode: 'NORMAL' | 'WARNING' | 'QUOTA_SAVER';
  dailyBudgetRemaining: number;
  resetsAt: string;         // 1st of next month 00:00 Asia/Bangkok
}
export interface BillFlag { lineIndex: number | null; kind: 'LINE_MATH' | 'TOTAL_MATH' | 'UNREADABLE' | 'NO_PRODUCT_MATCH'; detail: string }
```

### 2.3a B2B account (owner-verified B2B customers)

Owner-only decisions (CLAUDE.md §3.1): approve / reject / acknowledge / revoke each write a `user_events` row with `actor = 'owner'`. Business data is never sent to Gemini. Documents live in the private bucket `business-docs`; paths must match `business-docs/<userId>/<uuid>.(jpeg|png|webp)`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/liff/account` | – | `CustomerAccountView` |
| POST | `/api/liff/account/b2b/doc-upload-url` | `B2bDocUploadUrlRequest` | `{ path, uploadUrl }` |
| POST | `/api/liff/account/b2b` | `B2bApplyRequest` | `CustomerAccountView` |
| GET | `/api/owner/customers?filter=pending\|b2b\|all` | – | `OwnerB2bSummaryView[]` |
| GET | `/api/owner/customers/:userId` | – | `OwnerB2bDetailView` (signed doc URLs, 300 s) |
| POST | `/api/owner/customers/:userId/approve` | `OwnerB2bDecisionRequest` | `OwnerB2bDetailView` |
| POST | `/api/owner/customers/:userId/reject` | `OwnerB2bReasonRequest` | `OwnerB2bDetailView` |
| POST | `/api/owner/customers/:userId/acknowledge` | `OwnerB2bDecisionRequest` | `OwnerB2bDetailView` (clears `needsRereview`) |
| POST | `/api/owner/customers/:userId/revoke` | `OwnerB2bReasonRequest` | `OwnerB2bDetailView` |

**The owner decides on the data they saw.** `OwnerB2bDetailView.updatedAt` is the profile's `updated_at`. Every decision body carries it back as `expectedUpdatedAt` (`OwnerB2bDecisionRequest { expectedUpdatedAt }`; `OwnerB2bReasonRequest { reason, expectedUpdatedAt }`, reason trimmed 1–200). The worker matches it exactly, as stored, inside the guarded update. If the customer changed the application after the owner's view, the answer is 409 `INVALID_FROM_STATE`, nothing is decided and no audit row is written. The dashboard then refetches the detail. A missing `expectedUpdatedAt` is 400 `VALIDATION_FAILED`.

**Re-review on a verified shop.** A change to `business_name` or `tax_id`, or **at least one new document** (a path not already on file), sets `needs_rereview` and adds the field (`business_name`, `tax_id`, `documents`) to `rereview_fields`. It writes `B2B_REREVIEW { fields }` and sends one `B2B_REREVIEW` Web Push, only when the flag goes from false to true. Acknowledging moves `decided_at`, so documents added during the re-review are covered by the 30-day purge from then on.

`isValidThaiTaxId()` (`packages/shared/src/taxId.ts`) is a checksum flag (`taxIdValid`) only; it never approves. `OwnerOrderView.customer.b2b` is `{ businessName, deliveryWindow } | null`.

### 2.4 Scheduled jobs (Worker `scheduled()` handler; not HTTP)

| Cron | Job |
|---|---|
| `* * * * *` | Owner 15-min reminder; payment expiry; 24 h abandonment |
| `*/10 * * * *` | Refresh LINE quota → `quota_logs`; set mode |
| `0 20 * * *` (03:00 BKK) | Delete slip / bill images older than `STORAGE_RETENTION_DAYS`. Purge `business-docs` documents (object + row, `B2B_DOCS_PURGED { count }`) uploaded on or before the profile's `decided_at`, once that decision is older than 30 days (`B2B_DOC_RETENTION_DAYS`). Delete `business-docs` objects older than 1 day that have no `business_documents` row (abandoned uploads; counts only, nothing logged). |
| `0 1 * * 1` | Supabase keep-alive query (risk D5) |

---

> **Recipient rule (2026-11-25):** a LINE location only completes `LOCATION_SET` when the customer's profile has `full_name` + `phone` (copied to `orders.recipient_*`). Otherwise the address is saved, the order stays in `AWAITING_LOCATION` (`CustomerOrderView.delivery.needsRecipient = true`), the bot replies with the LIFF link, and the order is submitted by `POST /api/liff/orders/:id/recipient`. The LINE display name is never used as the recipient. `delivery` also carries `recipientPhone` and `hasLocation`.
> **Slip gate (2026-11-26):** `SLIP_UPLOADED` fires only from `AWAITING_PAYMENT` and `PAYMENT_EXPIRED` (no re-uploads during `PAYMENT_REVIEW`). The LIFF rejects an image on the device when it has no valid Thai bank Mini-QR ("รูปนี้ไม่ใช่สลิปโอนเงิน (ไม่พบ QR Code ธนาคาร) …"). **Chat images are still kept** (CLAUDE.md §3.5) with `check_details.source = 'chat'` and a "sent via chat, QR not checked" READABLE row. The reply offers the LIFF payment screen, and the owner's dashboard QR check flags non-slips. The owner-device decode of the stored image (`POST /api/owner/payments/:id/qr`) stays the trusted check; the customer's `qrPayload` is a gate, not proof.
> **Tracking link (2026-11-26):** owner LINE `A12 track <text with link>` or just a pasted text containing a `lalamove.com` link dispatches the order. When the Quota Guard defers the push (e.g. `ORDER_CAP`), the customer still gets the link from the LIFF "ติดตามการจัดส่ง (Lalamove)" button and from a **chat reply**. Customer messages matching `TRACKING_RE` (ลิงก์/ลิ้งค์/link/lalamove/ติดตาม/ถึงไหน/ส่งถึงยัง/ไรเดอร์/track) get the link + status card for their `DELIVERING` (or `PAID`) order, even when a newer order is the active one. Deterministic: no AI call.

> **Info keywords (2026-11-27):** five exact-match chat commands are answered from the database by code, with no AI call, no push and no order change (`apps/worker/src/handlers/infoCommands.ts`, copy in `th.info`).
> - **Matching:** the *whole* message must match, optionally followed by a polite particle (ค่ะ/คะ/ครับ/จ้า). A sentence that only contains a keyword goes to the normal order flow.
> - **Order of checks:** they run before `TRACKING_RE` and the B2B keyword.
>
> | Message | Reply |
> |---|---|
> | `ดูรายการสินค้า` | Active products grouped by active category (uncategorised under "อื่นๆ"), with unit, plus an example order line. No prices, since they change daily. |
> | `เช็คสถานะจัดส่ง` / `เช็กสถานะจัดส่ง` / `ขอลิงก์ lalamove` | If an order is PAID or DELIVERING, the same link + status card as `TRACKING_RE` (an order with a tracking link first, even when a newer draft is active). Otherwise a summary of the newest open order, else the last delivered one: code, status, total (or the product price before shipping, or "not priced yet"), and a note that delivery isn't booked yet. |
> | `ขอลิงก์ออเดอร์` | The active order's LIFF room `https://liff.line.me/<LIFF_ID>/orders/<orderId>`, or a no-open-order note. |
> | `วิธีสั่งซื้อ` | A step-by-step ordering guide. |
> | `ช่องทางชำระเงิน` | How to pay: PromptPay or transfer in the order room after the quote, then the slip, which the shop checks before confirming. The account details are not shown in chat. |
> **Shipping-fee step (2026-11-26):** entering it (`CUSTOMER_ACCEPT`, `OWNER_ACCEPT`) and setting the fee (`OWNER_SET_SHIPPING`) require a location **and** the recipient name + phone (`deliveryReady`). Otherwise the call fails with **422 `DELIVERY_INCOMPLETE`**: the LIFF shows the recipient form, chat gets a reply with the LIFF link, and the owner's LINE command gets a "waiting for the customer" reply. `delivery.needsRecipient` is true for any open order (until `DELIVERING`) that has a location but no recipient. `OwnerOrderView.lalamoveCard` is present from `AWAITING_SHIPPING_FEE` (before any fee) through `DELIVERING` whenever an address exists, so the owner can quote Lalamove first.

## 3. Supabase Realtime Channels

| Channel | Type | Subscriber | Payload | Trigger |
|---|---|---|---|---|
| `owner-orders` | `postgres_changes` on `orders` (`*`) | Dashboard | row | any order change |
| `owner-negotiations` | `postgres_changes` on `negotiations` (`INSERT`) | Dashboard | row | counter-offer → sound alert |
| `owner-payments` | `postgres_changes` on `payments` (`INSERT`, `UPDATE`) | Dashboard | row | slip uploaded/checked |
| `owner-quota` | `postgres_changes` on `quota_logs` (`INSERT`) | Dashboard | row | quota bar refresh |
| `order:{orderId}:{realtimeToken}` | **Broadcast**, event `order_updated` | Customer LIFF | `{ type: 'order_updated', version: number }` | Worker after every order mutation |

LIFF rule: on `order_updated` with `version > local.version`, refetch `GET /api/liff/orders/:id`. Never put prices, names or addresses in a broadcast payload.

---

## 4. LINE Webhook Event Handlers — owner: Thanadon

Entry: `POST /webhook`
1. Verify `x-line-signature` (HMAC-SHA256 of raw body with `LINE_CHANNEL_SECRET`). Fail → 401.
2. For each event: skip if `webhookEventId` already in `line_events`; insert it.
3. Return `200` fast; do heavy work in `ctx.waitUntil()` but **use the replyToken within the same request lifetime** (parse first, reply, then persist extras).

### 4.1 Routing

```
if event.source.userId in LINE_OWNER_USER_ID  → ownerCommandHandler (text only)  # comma-separated list, parsed to string[] in env.ts
else → customerRouter(event, user, activeOrder)
```

| Event | Customer's active order state | Handler |
|---|---|---|
| `follow` | – | Welcome + LIFF register button (reply) |
| `unfollow` | any | `users.is_active=false` |
| `message.text` | none / final | `orderParse` → new order (`AWAITING_CONFIRMATION`) |
| `message.text` | `AWAITING_CONFIRMATION` | treat as edit → re-parse with previous draft |
| `message.text` | `AWAITING_LOCATION` | try address / Maps link parse → geocode |
| `message.text` | `PRICE_QUOTED` | number-only (e.g. `1700`) → counter-offer; "ok/ตกลง" → accept; else pull-on-message status |
| `message.text` | other | pull-on-message status reply; if it looks like a new order → ask "new or add?" |
| `message.text` matching reorder phrases ("เหมือนเดิม", "สั่งเหมือนอาทิตย์ที่แล้ว") | none / final, B2B | `orderParse` with `previous_order` |
| `message.location` | `AWAITING_LOCATION` (or any pre-price) | save pin → `AWAITING_PRICE` |
| `message.image` | `AWAITING_PAYMENT` / `PAYMENT_EXPIRED` (1 order) | slip pipeline |
| `message.image` | ≥ 2 orders awaiting payment | Quick Reply: choose order |
| `message.image` | other | "ได้รับรูปแล้ว" + store for owner (no AI) |
| `message.sticker` | any | pull-on-message status |
| `postback` | per `data` | see below |

Postback `data` format (URL query string, ≤ 300 chars): `a=<action>&o=<orderId>[&v=<version>]`
Actions: `confirm`, `edit`, `accept`, `counter`, `cancel`, `choose_order`, `reorder`.
Stale `v` → reply with current status instead of applying.

### 4.2 Owner command grammar (deterministic)

```
cmd      := [code SP] body
code     := /[A-Z]\d{1,3}/i
body     := price | ship | track | neg | note | paid | done | list
price    := INT [SP note_text]            e.g. "1850", "A12 1850 ปูได้ 1.2 กก."
ship     := "ship" SP INT                 e.g. "A12 ship 120"
track    := "track" SP URL
neg      := "ok" | "hold" | INT           (only when order is NEGOTIATING)
note     := "note" SP text                → AI draft (OwnerNote), owner must tap Send
paid     := "paid"                        → confirm latest payment (needs PASS or "paid! <reason>")
done     := "done"                        → DELIVERED
list     := "list" | "?"
```
Ambiguity (no code, >1 candidate order) → reply with candidates. Bot always echoes what it did: `✅ A12 ราคา ฿1,850 | ต้นทุน ฿1,420 | กำไร +฿430 (23%) 🟢`.

### 4.3 Flex messages (all sent via reply unless noted)
| Template | When | Buttons |
|---|---|---|
| `OrderConfirmCard` | after parse | Confirm (postback) · Edit (LIFF) |
| `AskMissingCard` | `missing_fields` not empty | Quick Reply options |
| `LocationAskCard` | after confirm | Share location (Quick Reply `location` action) · Saved addresses (LIFF) |
| `PriceCard` | price set (push-guarded or pull) | Accept (postback) · Negotiate (LIFF) |
| `TotalCard` | shipping set | Open payment page (LIFF; QR rendered there) |
| `StatusCard` | pull-on-message | Open order room (LIFF) |
| `ChooseOrderQuickReply` | ambiguous input | one per order code |

QR image in chat: LIFF renders the QR from `promptpayPayload`. If chat-only customers need an image, the Worker may serve `GET /qr/:orderId/:realtimeToken.png` (Workers-compatible PNG encoder required); this is optional.

### 4.4 Quota-guarded push

```ts
// apps/worker/src/line/quota.ts — the ONLY place that calls pushMessage
export const LIFECYCLE_PUSHES = ['PRICE_READY', 'TOTAL_READY', 'TRACKING_LINK'] as const; // the only push reasons
export const PUSH_PRIORITY = { PRICE_READY: 'P2', TOTAL_READY: 'P1', TRACKING_LINK: 'P1' } as const;
export async function sendPushGuarded(deps, args: {
  order: OrderRow; messages: LineMessage[]; reason: (typeof LIFECYCLE_PUSHES)[number];
}): Promise<{ sent: boolean; deferredReason?: 'INACTIVE_USER' | 'ALREADY_SENT' | 'PRESENT' | 'QUOTA_SAVER' | 'WARNING_P2' | 'ORDER_CAP' | 'DAILY_BUDGET' | 'DAILY_RESERVE'; order: OrderRow }>;
```
**Push slots (2026-11-28):** an order gets at most 3 pushes, one per lifecycle reason: price quote → total + PromptPay/slip → Lalamove dispatched + tracking (`MAX_PUSH_PER_ORDER=3`). A re-quote or fee correction never pushes again (`ALREADY_SENT`). Owner counter, hold and notes never push: the customer sees them in LIFF (realtime; notes as `shopNote`) and in the next free chat reply (a note is shown once, event `NOTE_SHOWN_IN_CHAT`).

Decision order: inactive user → already sent for this reason → present in LIFF → mode (QUOTA_SAVER: none; WARNING: P1 only) → per-order cap → daily budget → **P1 reserve** (a P2 push, i.e. the price quote, needs more than `PUSH_DAILY_RESERVE_P1` (3) pushes left today, so total + tracking win when quota is tight) → send (increment `orders.push_count` via `patchOrder`, so the version bump is broadcast to LIFF, and `quota_logs.local_count`). Every decision writes `order_events` (`PUSH_SENT` / `PUSH_DEFERRED`).

---

## 5. PII Stripping Spec — owner: Thanakrit

All Gemini calls: `callGemini(task, input)` → `stripPII(input, ctx)` → SDK → validate → `restorePII(output, map)`.

### 5.1 Text payloads (order chat, owner notes)

| Category | Detection | Token |
|---|---|---|
| Thai mobile / landline | `/(?:\+66\|0)[\s-]?[2-9](?:[\s-]?\d){7,8}/g` | `[PHONE_n]` |
| Email | standard regex | `[EMAIL_n]` |
| URLs (incl. Maps links) | `/https?:\/\/\S+/g` | `[URL_n]` |
| Known names | exact/fuzzy match against this customer's `full_name`, `display_name`, `business_name`, saved `recipient_name`s | `[NAME_n]` |
| Honorific + name | `/(คุณ\|พี่\|น้อง\|ป้า\|ลุง\|เจ๊\|เฮีย)\s?[ก-๙A-Za-z]{2,}/` (skip if word is a product alias) | `[NAME_n]` |
| Address fragments | segments starting at `เลขที่ \| \d+/\d+ \| ซ\.\|ซอย \| ถ\.\|ถนน \| แขวง \| เขต \| ต\. \| อ\. \| จ\. \| หมู่บ้าน \| คอนโด \| อาคาร` up to the next line break, plus 5-digit postcodes | `[ADDR_n]` |
| Account numbers | `/\b\d{3}-?\d-?\d{5}-?\d\b/` and 10–12 digit runs | `[ACCT_n]` |

Never sent: LINE user ID, display name, our internal user/order UUIDs (use `item_0..n` indexes instead).
Product catalog, quantities, prices and the owner's numbers are **not** PII and are sent as-is.

```ts
export interface PiiMap { [token: string]: string }   // kept in memory only, never logged
export function stripPII(text: string, ctx: { knownNames: string[]; productAliases: string[] }): { text: string; map: PiiMap };
export function restorePII<T>(value: T, map: PiiMap): T;   // deep-replaces tokens in strings
export function assertNoPII(payload: unknown, ctx): void;  // throws in dev/test; logs metric in prod
```
`assertNoPII` runs on every outgoing payload; the eval reports **PII leak rate** (`AI_EVALUATION.md §3.5`).

### 5.2 Image payloads

| Task | Contains | Handling |
|---|---|---|
| Supplier bill | Supplier business name, maybe supplier phone | Business document; accepted with owner consent. Strip EXIF. |
| Payment slip | **Payer's name, masked accounts** | Controlled by `GEMINI_SLIP_MODE` (open decision D1) |

`GEMINI_SLIP_MODE`:
- `paid`: send slip to a paid-tier key (`GEMINI_SLIP_API_KEY`). Used during dev/Exhibition/Defence.
- `manual`: no AI. Worker decodes the slip's mini-QR (jsQR + jpeg-js) for `reference_no` duplicate checks; owner reads amount from the image. Zero cost, zero PII exposure.
- `redacted` (research option): blur the payer block before sending. Only enable if the eval shows the redaction never misses the name on all sample bank layouts.

All images: strip EXIF, resize to max 1600 px long side, JPEG q≈80 before upload/AI.

---

## 6. Gemini Structured Output Contracts — owner: Thanakrit

### 6.1 Shared call wrapper

```ts
// packages/ai/src/client.ts
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

export type AiTask = 'ORDER_PARSE' | 'OWNER_NOTE' | 'SUPPLIER_BILL' | 'PAYMENT_SLIP';

export interface AiCallMeta {
  task: AiTask;
  model: string;            // from env GEMINI_MODEL
  promptVersion: string;    // e.g. 'order_parse@v3' — logged for eval
  latencyMs: number;
  attempts: number;
  piiTokens: number;        // how many tokens were stripped
}

export type AiResult<T> =
  | { ok: true; data: T; meta: AiCallMeta }
  | { ok: false; error: 'RATE_LIMITED' | 'INVALID_OUTPUT' | 'BLOCKED' | 'UNAVAILABLE'; meta: AiCallMeta };
```

- Request config: `responseMimeType: 'application/json'` + `responseJsonSchema` = `z.toJSONSchema(Schema)` (Zod 4). If the installed SDK only supports `responseSchema` (OpenAPI subset), convert with the helper in `packages/ai/src/schema.ts`.
- `temperature: 0` for all extraction tasks; `0.4` for `OWNER_NOTE.message_th`.
- Retries: 429/5xx → backoff 1 s, 3 s (+ jitter), honour `Retry-After`; max 2 retries. Invalid JSON/Zod fail → 1 repair retry with the validation error appended. Then return `ok:false`.
- Fallback on `ok:false`: never block the flow. Order parse → reply "รับออเดอร์แล้ว ร้านกำลังตรวจสอบ" and set `needs_owner_review`. Bill/slip → owner enters manually.
- **`needs_owner_review` for chat drafts is re-evaluated on creation and on every customer edit**, not kept forever (`reviewNeeded()` in `apps/worker/src/services/review.ts`).
  - It is true while any of these holds: no items; an item with no product match or no positive quantity; any `missing_fields`; a `clarification_question_th`; any post-check warning.
  - So a follow-up that fills in the missing quantity clears it.
  - Every flip writes `REVIEW_FLAGGED` / `REVIEW_CLEARED` (actor `system`, reason codes only).
  - The unrecognised-product owner alert still fires once per order (`UNRECOGNISED_ALERTED`).
- **Draft edits and the `raw_text` check:** an item may keep a `raw_text` that appears **exactly** in the previous draft (`checkOrderParse` `draftRawTexts`, PII-stripped). Any other span must appear in the new message.
- Every call logs `AiCallMeta` (no payload content) for the eval and for free-tier rate monitoring.

### 6.2 Task 1 — ORDER_PARSE (NLP)

**Input (after PII strip)**
```ts
export interface OrderParseInput {
  message: string;                         // stripped chat text
  previousDraft?: OrderParseResult;        // when customer edits
  previousOrder?: { items: { productRef: string; qty: number; unit: Unit; prepType: PrepType }[] };  // B2B reorder
  catalog: { productRef: string; nameTh: string; aliases: string[]; unit: Unit; prepTypes: PrepType[] }[]; // productRef = 'p0','p1'… mapped by code
  nowBangkok: string;                      // '2027-01-14T09:20:00+07:00' for "พรุ่งนี้เช้า"
}
```

**Output schema**
```ts
export const OrderParseResult = z.object({
  intent: z.enum(['new_order', 'reorder', 'modify', 'question', 'not_order']),
  items: z.array(z.object({
    product_ref: z.string().nullable(),          // 'p3' or null if not in catalog
    raw_text: z.string(),                        // span copied from the message
    qty: z.number().positive().nullable(),
    unit: z.enum(['kg', 'piece', 'box', 'tray', 'set']).nullable(),
    prep_type: z.enum(['live', 'chilled', 'frozen', 'cooked', 'any']),
    note: z.string().nullable(),                 // 'ตัวใหญ่', 'ไม่เอาหัว'
  })),
  delivery_time: z.object({
    iso: z.string().nullable(),                  // resolved with nowBangkok
    raw_text: z.string().nullable(),             // 'พรุ่งนี้เช้า'
  }),
  missing_fields: z.array(z.enum(['product', 'qty', 'unit', 'prep_type', 'delivery_time'])),
  clarification_question_th: z.string().nullable(),
});
```

**Code checks after AI:** `product_ref` exists in the catalog sent; unit allowed for that product; `qty` within sane range (0 < qty ≤ 50 kg / 200 pieces) else add to `missing_fields`; `raw_text` must be a substring of the stripped message (anti-hallucination). Customer confirms the card before anything moves.

**Example**
```json
// message: "เอากุ้งแม่น้ำเป็นๆ 2 โล กับหอยแครงโลนึง ส่งพรุ่งนี้เช้านะคะ"
{
  "intent": "new_order",
  "items": [
    { "product_ref": "p4", "raw_text": "กุ้งแม่น้ำเป็นๆ 2 โล", "qty": 2, "unit": "kg", "prep_type": "live", "note": null },
    { "product_ref": "p9", "raw_text": "หอยแครงโลนึง", "qty": 1, "unit": "kg", "prep_type": "any", "note": null }
  ],
  "delivery_time": { "iso": "2027-01-15T07:00:00+07:00", "raw_text": "พรุ่งนี้เช้า" },
  "missing_fields": [],
  "clarification_question_th": null
}
```

### 6.3 Task 2 — OWNER_NOTE (NLP)

**Input:** `{ note: string /* stripped */, orderItems: { itemRef: string; name: string; qty: number; unit: Unit }[], catalog: same as above }`

**Output schema**
```ts
export const OwnerNoteResult = z.object({
  message_th: z.string().max(500),             // polite customer-facing Thai (ค่ะ/ครับ per settings.owner_politeness)
  out_of_stock: z.array(z.object({ item_ref: z.string().nullable(), raw_text: z.string() })),
  substitutes: z.array(z.object({
    product_ref: z.string().nullable(),
    name_th: z.string(),
    qty: z.number().positive().nullable(),
    unit: z.enum(['kg', 'piece', 'box', 'tray', 'set']).nullable(),
    price_baht: z.number().nonnegative().nullable(),   // only if the owner wrote a number
  })),
});
```
**Code checks:** every `price_baht` must appear literally as a number in the owner's note (AI may not invent prices); `message_th` must contain each substitute price it mentions. **Owner reviews and edits before sending.**

**Example** — note `"ปูหมด มีกุ้งแม่น้ำ 900"` →
```json
{
  "message_th": "ขออภัยค่ะ วันนี้ปูหมดแล้ว ทางร้านมีกุ้งแม่น้ำสดแทนได้ ราคา 900 บาทค่ะ สนใจรับแทนไหมคะ",
  "out_of_stock": [{ "item_ref": "item_0", "raw_text": "ปู" }],
  "substitutes": [{ "product_ref": "p4", "name_th": "กุ้งแม่น้ำ", "qty": null, "unit": null, "price_baht": 900 }]
}
```

### 6.4 Task 3 — SUPPLIER_BILL (Vision)

**Input:** one image (JPEG, EXIF stripped) + `catalog` (for `product_ref` guesses).

**Output schema**
```ts
export const SupplierBillResult = z.object({
  is_bill: z.boolean(),
  supplier_name: z.string().nullable(),
  bill_date: z.string().nullable(),             // 'YYYY-MM-DD'; convert พ.ศ. → ค.ศ. in code if year > 2400
  lines: z.array(z.object({
    name: z.string(),
    product_ref: z.string().nullable(),
    qty: z.number().nullable(),
    unit: z.string().nullable(),
    unit_price: z.number().nullable(),          // baht, as written
    line_total: z.number().nullable(),          // baht, as written
    legible: z.boolean(),
  })),
  bill_total: z.number().nullable(),
});
```
**Code checks (produce `BillFlag[]`):** `|qty × unit_price − line_total| > 1 baht` → `LINE_MATH`; `|Σ line_total − bill_total| > 1` → `TOTAL_MATH`; `legible=false` or nulls → `UNREADABLE`; `product_ref=null` → `NO_PRODUCT_MATCH`. AI returns numbers as written; **code** converts to satang. Nothing is saved to stock until the owner taps **Save**.

### 6.5 Task 4 — PAYMENT_SLIP (Vision)

**Input:** one slip image (per `GEMINI_SLIP_MODE`). Prompt explicitly says: *do not output the payer's name or account*.

**Output schema**
```ts
export const SlipReadResult = z.object({
  is_slip: z.boolean(),
  bank: z.string().nullable(),                  // e.g. 'KBANK', 'SCB'
  amount: z.number().nullable(),                // baht, e.g. 1970.00
  date_time: z.string().nullable(),             // ISO with +07:00; code converts พ.ศ.
  receiver_name_or_id: z.string().nullable(),   // as printed, e.g. 'นาง ดา ท***' or 'xxx-x-x1234-x'
  reference_no: z.string().nullable(),
});
```
**Code checks:** see `PROJECT_SPEC.md §5`. Output → `PaymentCheckView`. **Owner confirms; code never sets PAID.**

### 6.6 Prompt files
`packages/ai/src/prompts/{order_parse,owner_note,supplier_bill,payment_slip}.v<N>.md`. Changing a prompt = bump version + re-run the benchmark for that task.

---

## 7. Mocks for Parallel Work

| You are | Mock this | How |
|---|---|---|
| Kitirat (web) | Worker API | MSW handlers in `apps/web/src/mocks/` returning the view models above |
| Thanadon (worker) | Gemini | `USE_MOCK_AI=true` → `packages/ai` uses the deterministic mock provider (`src/mock/`): rule-based Thai order/note parsing, image-fingerprint fixtures for bills/slips |
| Thanakrit (AI) | DB / LINE | Pure functions; run with `pnpm --filter ai test` and `pnpm eval:<task>` |
