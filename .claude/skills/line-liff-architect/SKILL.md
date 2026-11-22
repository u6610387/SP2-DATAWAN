---
name: line-liff-architect
description: Patterns for Da Tawan Seafood's LINE integration — webhook signature/dedupe, replyToken-first replies, owner command parsing, state-based chat fallback routing, Flex Message cards, LIFF auth (ID token), and Supabase Realtime sync for the LIFF order room. Use when writing or changing anything in apps/worker/src/line, the /webhook route, Flex templates, or apps/web/src/app/liff.
---

# LINE + LIFF Architect

Contracts: `docs/API_AND_AI_CONTRACTS.md §2–4`. Rules: load `seafood-domain-rules` too when the change sends messages or changes order state.

## 1. Webhook skeleton (Cloudflare Worker + Hono)

```ts
// apps/worker/src/routes/webhook.ts
app.post('/webhook', async (c) => {
  const raw = await c.req.text();
  if (!(await verifyLineSignature(raw, c.req.header('x-line-signature'), c.env.LINE_CHANNEL_SECRET))) {
    return c.text('bad signature', 401);
  }
  const body = JSON.parse(raw) as WebhookRequestBody;
  for (const ev of body.events) {
    if (await alreadySeen(c.env, ev.webhookEventId)) continue;   // insert into line_events ON CONFLICT DO NOTHING
    // Do the reply-critical work inline (reply token is short-lived);
    // push secondary work (persist extras, Web Push owner, broadcast) to waitUntil.
    await routeEvent(c, ev);
  }
  return c.text('ok');
});
```

Signature: HMAC-SHA256 over the **raw body** with the channel secret, base64, constant-time compare (`crypto.subtle`). Never parse JSON before verifying.

## 2. replyToken-first
- Every inbound event gets at most one reply call; batch up to 5 messages in it.
- Reply tokens are single-use and expire shortly; reply before slow work. For Gemini parses, keep the 5 s p95 budget; if Gemini is slow/429, reply "รับออเดอร์แล้ว กำลังตรวจสอบค่ะ" and set `needs_owner_review`.
- **Pull-on-message:** any customer message on an open order → include the pending update (`StatusCard`) in the reply. This is our main free delivery channel for updates the customer missed.
- Pushing is only via `sendPushGuarded()` (see `seafood-domain-rules §4`).

## 3. Routing by state (chat fallback)

```ts
async function routeEvent(c, ev) {
  if (ev.source.type !== 'user') return;
  if (isOwnerLineUser(cfg, ev.source.userId)) return ownerHandler(c, ev); // cfg = loadConfig(c.env); LINE_OWNER_USER_ID: comma-separated → string[]
  const user = await upsertUser(c, ev.source.userId);
  const open = await openOrders(c, user.id);                 // non-final, newest first
  const active = open.find(o => o.id === user.active_order_id) ?? open[0] ?? null;
  switch (ev.type) {
    case 'follow':   return replyWelcome(c, ev);
    case 'unfollow': return markInactive(c, user);
    case 'postback': return handlePostback(c, ev, user);     // a=…&o=…&v=…
    case 'message':  return handleMessage(c, ev, user, active, open);
  }
}
```

Message rules (full table in contracts §4.1):
- `image` + exactly one order in `AWAITING_PAYMENT|PAYMENT_EXPIRED` → slip pipeline. ≥ 2 → `ChooseOrderQuickReply` (pre-select an order whose total equals the slip amount if already read). Otherwise acknowledge, store for owner, no AI.
- `location` while pre-price → save address (`source='line_pin'`) → `AWAITING_PRICE`.
- `text` in `AWAITING_LOCATION` → Maps link / address → geocode (Longdo, fallback OSM).
- `text` number-only in `PRICE_QUOTED` → counter-offer; `ok|ตกลง|โอเค` → accept.
- `text` that parses as an order while one is open → ask "สั่งเพิ่มใน A12 หรือเปิดออเดอร์ใหม่?" via Quick Reply.
- Unknown → `StatusCard` (pull-on-message).

Always make handlers **idempotent** and check order `version` from postbacks; stale → reply current status instead of applying.

## 4. Owner commands
Deterministic grammar in `apps/worker/src/line/ownerCommands.ts` (contracts §4.2). Pattern:

```ts
const CODE = /^(?:([A-Z]\d{1,3})\s+)?/i;
const PATTERNS = [
  { kind: 'ship',  re: /^ship\s+(\d{1,5})$/i },
  { kind: 'track', re: /^track\s+(https?:\/\/\S+)$/i },
  { kind: 'note',  re: /^note\s+(.+)$/is },
  { kind: 'paid',  re: /^paid(!\s+.+)?$/i },
  { kind: 'done',  re: /^done$/i },
  { kind: 'ok',    re: /^ok$/i },
  { kind: 'hold',  re: /^hold$/i },
  { kind: 'list',  re: /^(list|\?)$/i },
  { kind: 'price', re: /^(\d{1,6})(?:\s+(.+))?$/s },   // last: plain number (+ note)
] as const;
```
Resolve the target order: explicit code → open order with that code; no code → the single order in the state the command expects, else reply with candidates. Echo result with margin, e.g. `✅ A12 ราคา ฿1,850 | กำไร +฿430 (23%) 🟢`. Unknown command → short help text. Owner replies are free (replyToken).

## 5. Flex Messages
- Templates live in `apps/worker/src/line/flex/*.ts` as pure functions `(view) => FlexMessage`; snapshot-test them.
- Keep `altText` meaningful Thai (shows in notifications): `"ราคาออเดอร์ A12: ฿1,850"`.
- Buttons: postback for state changes (`a=accept&o=<id>&v=<version>`, `displayText` in Thai), URI to `https://liff.line.me/<LIFF_ID>/orders/<id>` for anything needing a form.
- Quick Reply `location` action for pins; max 13 items.
- Never put cost/margin in customer cards.

## 6. LIFF

### 6.1 Init & auth
```ts
// apps/web/src/app/liff/LiffProvider.tsx
await liff.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID! });
if (!liff.isLoggedIn()) liff.login({ redirectUri: location.href });
const idToken = liff.getIDToken();          // send as Bearer to the Worker
```
- Worker verifies with `POST https://api.line.me/oauth2/v2.1/verify` (`id_token`, `client_id=LINE_LOGIN_CHANNEL_ID`), maps `sub` → `users.line_user_id`. Cache result for the token's lifetime.
- Never trust a userId sent in the body.
- Deep links: `https://liff.line.me/<LIFF_ID>/orders/<id>` → route `/liff/orders/[id]`.

### 6.2 Realtime sync
```ts
const ch = supabase.channel(view.realtime.channel)       // 'order:{id}:{token}'
  .on('broadcast', { event: 'order_updated' }, ({ payload }) => {
    if (payload.version > current.version) refetch();
  })
  .subscribe();
```
- Broadcast payload is only `{type, version}`; data comes from `GET /api/liff/orders/:id`.
- Heartbeat every 30 s while `document.visibilityState === 'visible'` → `POST /heartbeat` (presence for push decisions). Stop on `visibilitychange` hidden.
- On reconnect / tab focus → refetch (missed broadcasts are normal).
- Worker side: after every order mutation, `supabase.channel(name).send({ type:'broadcast', event:'order_updated', payload })` via REST broadcast endpoint.

### 6.3 LIFF screens
`/liff/register` · `/liff/orders` (open + history, B2B Reorder button) · `/liff/orders/[id]` (timeline, items edit, location, price + accept/negotiate, total + QR + countdown, slip upload, tracking link). Mobile-first, big tap targets, Thai copy from `packages/shared/src/i18n/th.ts`.

QR: render client-side from `promptpayPayload` (e.g. `qrcode` package to canvas). Show amount in large text and the countdown from `paymentExpiresAt`; show locked state on `PAYMENT_EXPIRED`.

Slip upload: compress client-side (≤ 1600 px, JPEG q≈0.8, strip EXIF via canvas) → `POST slip-upload-url` → `PUT` to signed URL → `POST slip`.

## 7. Testing
- Fixture events in `apps/worker/test/fixtures/line/*.json` (text, image, location, postback, follow, owner commands).
- Sign fixtures with a test secret to exercise the real signature path.
- Table-driven tests: `(state, event) → expected reply template + new state`.
- Test duplicates (same `webhookEventId` twice) and stale postback `v`.
