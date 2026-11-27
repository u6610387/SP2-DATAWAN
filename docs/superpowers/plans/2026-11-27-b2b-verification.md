# B2B Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers can apply for B2B status from LIFF. The owner approves or rejects the application in a new dashboard tab. Only verified shops get the B2B badge, the 30-day price memory and the default delivery window.

**Architecture:**
- **Data:** a separate `business_profiles` table holds the application and its state machine. `business_documents` tracks the private uploads. `user_events` is the append-only audit log.
- **The flip:** `users.user_type` becomes `'B2B'` only on approval, so the existing `user_type === 'B2B'` checks keep meaning "verified".
- **Code:** all transitions live in one worker service, `apps/worker/src/services/b2b.ts`, called by the LIFF and owner routes. The daily cleanup cron purges documents 30 days after a decision.

**Tech Stack:** TypeScript strict, Hono on Cloudflare Workers, Supabase Postgres + Storage, Zod (`@datawan/shared`), Next.js App Router + Tailwind (`apps/web`), vitest, PGlite E2E.

**Spec:** the Obsidian note `Projects/da-tawan-seafood/B2B Verification Design.md`, approved 2026-11-27. Its section numbers are cited below as "Design §n".

## Global Constraints

- **Owner-only decisions:** approve, reject, acknowledge and revoke happen only through `/api/owner/*` (owner auth). Each writes a `user_events` row with `actor = 'owner'`. Code may flag (Tax ID ✗) but never approves (CLAUDE.md §3.1).
- **No paid services:** no verification APIs. Storage is a private Supabase bucket `business-docs` (`public = false`, `file_size_limit = 1048576`, mimes `image/jpeg`, `image/png`, `image/webp`).
- **No LINE push** about application status. The customer sees status in LIFF or by chat reply (free). The owner is alerted by Web Push only (`deps.notifier`).
- **No business data in logs:** `user_events.payload` holds field names and reason codes only, never names, Tax IDs, addresses or reason text. No `console.log` of request bodies.
- **Business data is never sent to Gemini:** no change to `packages/ai`.
- **Tables:** every new table has RLS enabled, an `is_owner()` policy, and `revoke update, delete … from authenticated` where it is an audit log.
- **Storage paths:** a document path from a request must match `business-docs/<callerUserId>/<uuid>.(jpeg|png|webp)`, checked before Storage is touched.
- **Customer copy:** customer-facing Thai strings go in `packages/shared/src/i18n/th.ts`. Dashboard and LIFF UI strings go in `apps/web/src/lib/i18n/{th,en,dictionary}.ts`.
- **Document retention:** 30 days after the decision (constant `B2B_DOC_RETENTION_DAYS = 30` in `b2b.ts`, Design §3.9).
- **Signed URLs:** owner preview links expire after 300 s, as for slips.
- **Field limits:**

  | Field | Rule |
  |---|---|
  | `businessName` | trimmed, 1–100 characters |
  | `addressText` | trimmed, 5–300 characters |
  | `taxId` | `^\d{13}$` or null |
  | `deliveryWindow` | `^([01]\d\|2[0-3]):[0-5]\d-([01]\d\|2[0-3]):[0-5]\d$` or null |
  | `lat` / `lng` | within Thailand: lat 5–21, lng 97–106, or both null |
  | rejection / revoke reason | trimmed, 1–200 characters |
  | documents | ≤ 3 un-purged per user |

- **Contracts:** a change to `packages/shared/src/contracts/` or `supabase/migrations/` updates `docs/API_AND_AI_CONTRACTS.md` / `docs/ARCHITECTURE_AND_DB.md` in the same task.
- **Ship gate:** `pnpm verify` and `pnpm audit:security` both pass on the final commit.

## Review Focus

1. **Another customer's document path:** customer B submits an application with `documentPaths` pointing at A's `business-docs/<A>/…` object. Expected: 400, nothing stored or linked (Task 5 test).
2. **A double tap or two owners deciding at once:** approving twice, or approving after a reject, must not apply twice. Expected: the second call returns 409 `INVALID_FROM_STATE` and a single `B2B_APPROVED` event exists (Task 4 test).
3. **Re-submitting while pending:** a pending applicant edits and re-submits. Expected: the profile is updated and **no second** `B2B_APPLICATION` push is sent (Task 4 test).
4. **Revoking a shop with open orders:** expected: `user_type` goes back to `B2C`, and the next `GET /api/owner/orders/:id` for their open order has `customer.b2b === null` and `b2bAnchorPriceSatang === null` (Task 7 test).
5. **Purge timing:** a document uploaded during a re-review, *after* the last decision, must survive the purge until the next decision. Expected: only documents with `uploaded_at <= decided_at` and `decided_at < now − 30 d` are deleted (Task 8 test).

---

### Task 1: Shared contracts, Tax ID checksum and types

**Files:**
- Create: `packages/shared/src/taxId.ts`
- Modify:
  - `packages/shared/src/db.ts` (row types);
  - `packages/shared/src/contracts/requests.ts`;
  - `packages/shared/src/contracts/views.ts` (`OwnerOrderView.customer`);
  - `packages/shared/src/index.ts` (exports);
  - `packages/shared/src/i18n/th.ts`;
  - `docs/API_AND_AI_CONTRACTS.md` (new §2.x "B2B account").
- Test: `packages/shared/test/b2b.test.ts`

**Interfaces:**
- Produces:
  - `isValidThaiTaxId(id: string): boolean`
  - `type B2bStatus = 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED'`
  - `type BusinessType = 'restaurant' | 'reseller' | 'hotel' | 'other'`
  - `interface BusinessProfileRow { user_id; status: B2bStatus; business_name; business_type: BusinessType; address_text; lat: number|null; lng: number|null; default_delivery_window: string|null; tax_id: string|null; submitted_at; decided_at: string|null; decided_by: string|null; verified_at: string|null; rejection_reason: string|null; needs_rereview: boolean; rereview_fields: string[]; created_at; updated_at }`
  - `interface BusinessDocumentRow { id; user_id; path; content_type; uploaded_at }`
  - `interface UserEventRow { id; user_id; actor: EventActor; event: UserEventName; payload: Record<string, unknown>|null; created_at }`
  - `type UserEventName = 'B2B_APPLIED'|'B2B_UPDATED'|'B2B_APPROVED'|'B2B_REJECTED'|'B2B_REREVIEW'|'B2B_ACKNOWLEDGED'|'B2B_REVOKED'|'B2B_DOCS_PURGED'`
  - Zod schemas:
    - `B2bApplyRequest` `{ businessName, businessType, addressText, lat, lng, deliveryWindow, taxId, documentPaths: string[] (max 3), pdpaConsent: literal(true) }`, using the limits in Global Constraints;
    - `B2bDocUploadUrlRequest` `{ contentType: 'image/jpeg'|'image/png'|'image/webp' }`;
    - `OwnerB2bReasonRequest` `{ reason }`.
  - View types:
    - `CustomerAccountView { type: 'B2C'|'B2B'; b2b: null | { status; businessName; businessType; addressText; lat; lng; deliveryWindow; taxId; rejectionReason; needsRereview; documents: { id: string }[] } }`;
    - `OwnerB2bSummaryView { userId; customerName: string|null; businessName; businessType; status; needsRereview; submittedAt }`;
    - `OwnerB2bDetailView extends OwnerB2bSummaryView { phone; addressText; lat; lng; mapUrl: string|null; deliveryWindow; taxId; taxIdValid: boolean|null; rereviewFields: string[]; rejectionReason; decidedAt; verifiedAt; documents: { id; url: string }[] }`.
  - `OwnerOrderView.customer` gains `b2b: { businessName: string; deliveryWindow: string|null } | null`.
  - `th.b2bAccountLink(url: string): string`, used by the chat keyword reply in Task 8.

- [ ] **Step 1: Write the failing tests.**
  - `isValidThaiTaxId`:
    - `true` for `'0105536000313'` and `'3101700000016'`;
    - `false` for `'0105536000316'` (bad check digit), `'010553600031'` (12 digits) and `'01055360003a5'`.
  - `B2bApplyRequest.safeParse`:
    - rejects `businessName: '   '`, `pdpaConsent: false`, `lat: 40`, `deliveryWindow: '25:00-08:00'` and 4 `documentPaths`;
    - accepts a minimal valid body with `taxId: null, lat: null, lng: null, deliveryWindow: null, documentPaths: []`, and trims `businessName`.
- [ ] **Step 2: Run** `pnpm --filter @datawan/shared exec vitest run test/b2b.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.**
  - Tax ID checksum: `sum(d[i] × (13 − i)) for i in 0..11`, then `check = (11 − sum % 11) % 10`, which must equal `d[12]`.
  - Add the rest as listed in Interfaces, plus the docs section listing the endpoints from Tasks 5–6.
- [ ] **Step 4: Run** the same test. Expected: PASS. Then run `pnpm -r typecheck`. Expected: errors only where `OwnerOrderView.customer` is built (`apps/worker/src/services/views.ts`, `apps/web/src/mocks/data.ts`). Add `b2b: null` to both so typecheck is clean (Task 7 fills it in).
- [ ] **Step 5: Commit:** `feat(shared): B2B contracts, Thai Tax ID checksum`.

### Task 2: Migration 0007 (tables, RLS, private bucket)

**Files:**
- Create: `supabase/migrations/0007_b2b_verification.sql`
- Modify:
  - `docs/ARCHITECTURE_AND_DB.md` (schema section);
  - `apps/worker/test/e2e/rls.e2e.test.ts` (bucket list, owner-visible tables).

**Interfaces:**
- Produces:
  - tables `business_profiles`, `business_documents` and `user_events`, with the columns of the Task 1 row types;
  - enums `b2b_status` and `business_type`;
  - bucket `business-docs`.

- [ ] **Step 1: Update the failing RLS expectations.**
  - In `slips and supplier-bills buckets are private` (rename it to "all buckets are private"), expect `[{ id: 'business-docs', public: false }, { id: 'slips', public: false }, { id: 'supplier-bills', public: false }]`.
  - In the owner test, add `user_events` to the append-only assertions: `update user_events …` and `delete from user_events` both match `/permission denied/`.
- [ ] **Step 2: Run** `pnpm --filter @datawan/worker exec vitest run test/e2e/rls.e2e.test.ts`. Expected: FAIL (bucket list, `user_events` missing).
- [ ] **Step 3: Write the migration.**
  - `business_profiles.user_id` is the primary key, with `references users(id) on delete cascade`.
  - Checks:
    - `char_length(business_name) between 1 and 100`;
    - `tax_id is null or tax_id ~ '^\d{13}$'`;
    - `(lat is null) = (lng is null)`;
    - `status <> 'REJECTED' or rejection_reason is not null`.
  - `rereview_fields text[] not null default '{}'`, `needs_rereview boolean not null default false`.
  - `create trigger business_profiles_updated_at … execute function set_updated_at()`.
  - Indexes:
    - `business_profiles(status, submitted_at)`;
    - `business_documents(user_id)`;
    - `user_events(user_id, created_at)`.
  - `user_events.actor event_actor not null`.
  - Enable RLS on all three tables:
    - `create policy owner_all on business_profiles for all using (is_owner()) with check (is_owner())`;
    - the same on `business_documents`;
    - `create policy owner_read on user_events for select using (is_owner())`;
    - `revoke update, delete on user_events from authenticated`.
  - Bucket:
    - insert `('business-docs','business-docs', false, 1048576, array['image/jpeg','image/png','image/webp']) on conflict (id) do nothing`;
    - `create policy owner_read_business_docs on storage.objects for select using (bucket_id = 'business-docs' and is_owner())`.
  - Any new function sets `search_path = ''` (the RLS suite's linter check).
- [ ] **Step 4: Run** the RLS suite, then `pnpm --filter @datawan/worker exec vitest run test/e2e`. Expected: all PASS. The catalog guards cover the new tables automatically.
- [ ] **Step 5: Commit:** `feat(db): 0007 business profiles, documents, user events (RLS, private bucket)`.

### Task 3: Repo and storage methods

**Files:**
- Modify:
  - `apps/worker/src/services/repo.ts` (interface);
  - `repo.memory.ts`;
  - `repo.supabase.ts`;
  - `apps/worker/src/services/storage.ts`.
- Test: `apps/worker/test/b2bRepo.test.ts` (memory repo + `MemoryStorage`). The Supabase implementation is covered by Task 11's E2E.

**Interfaces:**
- Produces, on `Repo`:
  - `getBusinessProfile(userId: string): Promise<BusinessProfileRow | null>`
  - `upsertBusinessProfile(p: Omit<BusinessProfileRow, 'created_at'|'updated_at'>): Promise<BusinessProfileRow>`
  - `updateBusinessProfile(userId: string, expectedStatus: B2bStatus, patch: Partial<BusinessProfileRow>): Promise<BusinessProfileRow | null>`: a conditional update (`where user_id = $1 and status = $2`). It returns `null` when the status no longer matches, which is the concurrency guard for Review Focus 2.
  - `listBusinessProfiles(filter: 'pending' | 'b2b' | 'all'): Promise<BusinessProfileRow[]>`:
    - `pending` = `status = PENDING_VERIFICATION or needs_rereview`;
    - `b2b` = `VERIFIED`;
    - ordered by `submitted_at desc`.
  - `setUserB2B(userId: string, patch: { user_type: 'B2C'|'B2B'; business_name: string|null; default_delivery_window: string|null }): Promise<UserRow>`
  - `insertUserEvent(e: { user_id: string; actor: EventActor; event: UserEventName; payload?: Record<string, unknown> }): Promise<UserEventRow>`
  - `listUserEvents(userId: string): Promise<UserEventRow[]>` (ascending)
  - `insertBusinessDocuments(rows: { user_id: string; path: string; content_type: string }[]): Promise<BusinessDocumentRow[]>`
  - `listBusinessDocuments(userId: string): Promise<BusinessDocumentRow[]>`
  - `listDocsDueForPurge(decidedBeforeIso: string): Promise<BusinessDocumentRow[]>`: a join on the profile where `d.uploaded_at <= p.decided_at and p.decided_at < $1`.
  - `deleteBusinessDocuments(ids: string[]): Promise<void>`
- Produces, on `ImageStorage`:
  - `Bucket` adds `'business-docs'`;
  - `remove(bucket: Bucket, keys: string[]): Promise<void>` (Supabase: `DELETE /storage/v1/object/{bucket}` with body `{ prefixes: keys }`).

- [ ] **Step 1: Write the failing tests.**
  - `updateBusinessProfile` with the wrong `expectedStatus` returns `null` and leaves the row unchanged.
  - `listBusinessProfiles('pending')` includes a `VERIFIED` profile with `needs_rereview: true` and excludes `REJECTED`.
  - `listDocsDueForPurge`: a doc with `uploaded_at` before `decided_at` (40 days ago) is returned; a doc uploaded after `decided_at` isn't; a doc on an undecided profile isn't.
  - `MemoryStorage.remove` deletes only the named keys.
- [ ] **Step 2: Run** `pnpm --filter @datawan/worker exec vitest run test/b2bRepo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the memory and Supabase versions. In Supabase, the conditional update is `.update(patch).eq('user_id', id).eq('status', expected).select().maybeSingle()`. `listDocsDueForPurge` uses two queries: profiles with `decided_at < $1`, then docs for those users filtered in code by `uploaded_at <= decided_at`.
- [ ] **Step 4: Run** the test plus `pnpm -r typecheck`. Expected: PASS, no errors.
- [ ] **Step 5: Commit:** `feat(worker): repo + storage methods for B2B profiles`.

### Task 4: B2B service (state machine, audit, alerts)

**Files:**
- Create: `apps/worker/src/services/b2b.ts`
- Modify:
  - `apps/worker/src/services/notifier.ts` (alert kinds);
  - `apps/worker/src/services/webpush.ts` (alert text).
- Test: `apps/worker/test/b2bService.test.ts` (uses `makeHarness`)

**Interfaces:**
- Consumes: the Task 3 repo methods, plus `isValidThaiTaxId` and the types from Task 1.
- Produces:
  - `type B2bResult = { ok: true; profile: BusinessProfileRow } | { ok: false; reason: 'INVALID_FROM_STATE' | 'NOT_FOUND' | 'TOO_MANY_DOCUMENTS' }`
  - `applyB2b(deps: Deps, user: UserRow, input: B2bApplyInput): Promise<B2bResult>`, where `B2bApplyInput` is the parsed `B2bApplyRequest` minus `pdpaConsent`
  - `approveB2b(deps, userId: string, ownerId: string): Promise<B2bResult>`
  - `rejectB2b(deps, userId: string, ownerId: string, reason: string): Promise<B2bResult>`
  - `acknowledgeB2b(deps, userId: string, ownerId: string): Promise<B2bResult>`
  - `revokeB2b(deps, userId: string, ownerId: string, reason: string): Promise<B2bResult>`
  - `purgeDecidedDocuments(deps): Promise<number>`, with `B2B_DOC_RETENTION_DAYS = 30`
  - `OwnerAlert` gains `{ kind: 'B2B_APPLICATION'; userId: string }` and `{ kind: 'B2B_REREVIEW'; userId: string }`. They carry no business name: the push is shown on a lock screen. The text is "มีร้านค้าขอยืนยันตัวตน B2B" / "ร้านค้า B2B แก้ไขข้อมูล รอตรวจ", with a URL to `/dashboard/customers/<userId>`.

**Rules** (Design §3.3, §3.6, §3.7, §8):

| Call | From | Effect | Event / alert |
|---|---|---|---|
| `applyB2b` | no profile, or `REJECTED` | upsert `PENDING_VERIFICATION`, `submitted_at = now`, clear the decision fields | `B2B_APPLIED` (customer), alert `B2B_APPLICATION` |
| `applyB2b` | `PENDING_VERIFICATION` | update the fields | `B2B_UPDATED`, **no alert** |
| `applyB2b` | `VERIFIED`, name or taxId changed | update the fields, `needs_rereview = true`, `rereview_fields ∪= changed names`; users row unchanged except the delivery window | `B2B_REREVIEW` `{fields}`, alert `B2B_REREVIEW` (only when `needs_rereview` was false before) |
| `applyB2b` | `VERIFIED`, other fields only | update the fields; `setUserB2B` copies `default_delivery_window` | `B2B_UPDATED` |
| `approveB2b` | `PENDING_VERIFICATION` | `VERIFIED`, `decided_at = verified_at = now`, `decided_by`; `setUserB2B('B2B', name, window)` | `B2B_APPROVED` (owner) |
| `rejectB2b` | `PENDING_VERIFICATION` | `REJECTED`, reason, `decided_*`; `setUserB2B('B2C', null, null)` | `B2B_REJECTED` `{}` |
| `acknowledgeB2b` | `VERIFIED` with `needs_rereview` | clear the flag and fields, `decided_at = now`; `setUserB2B('B2B', profile name, window)` | `B2B_ACKNOWLEDGED` `{fields}` |
| `revokeB2b` | `VERIFIED` | `REJECTED`, reason, `needs_rereview = false`, `decided_*`; `setUserB2B('B2C', null, null)` | `B2B_REVOKED` `{}` |

Any other starting state returns `INVALID_FROM_STATE`. A guarded update that returns `null` also returns `INVALID_FROM_STATE`. `applyB2b` inserts `business_documents` rows for the new `documentPaths` (the caller already scoped them, see Task 5). It fails with `TOO_MANY_DOCUMENTS` if existing + new > 3.

- [ ] **Step 1: Write the failing tests** (in-memory harness, `RecordingNotifier`). One test per table row, plus:
  - **Review Focus 2:** `approveB2b` twice → the second returns `INVALID_FROM_STATE`; `listUserEvents` has exactly one `B2B_APPROVED`.
  - **Review Focus 3:** apply twice while pending → `notifier.alerts.filter(k === 'B2B_APPLICATION').length === 1`.
  - Apply → reject → apply again → `PENDING_VERIFICATION`, with `rejection_reason` null.
  - Verified shop changes `businessName` → `user_type` is still `'B2B'` and `users.business_name` is still the old name; after `acknowledgeB2b` it's the new name.
  - **PII guard:** `JSON.stringify(listUserEvents(...))` doesn't contain the business name, Tax ID, address or reason text.
- [ ] **Step 2: Run** `pnpm --filter @datawan/worker exec vitest run test/b2bService.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `b2b.ts` per the table, and the two alert kinds in the notifier and webpush.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(worker): B2B verification service with owner-only decisions`.

### Task 5: LIFF account routes

**Files:**
- Modify: `apps/worker/src/routes/liff.ts`
- Test: `apps/worker/test/liffB2b.test.ts`

**Interfaces:**
- Consumes: Task 4's `applyB2b`, and the Task 1 schemas and views.
- Produces:
  - `GET /api/liff/account` → `CustomerAccountView`;
  - `POST /api/liff/account/b2b/doc-upload-url` with body `B2bDocUploadUrlRequest` → `{ uploadUrl, path }`. The path is `business-docs/<user.id>/<uuid>.<ext>`. Returns 409 `TOO_MANY_DOCUMENTS` when 3 already exist.
  - `POST /api/liff/account/b2b` with body `B2bApplyRequest` → `CustomerAccountView`. Returns 400 when a path fails `isOwnBusinessDocPath`, 409 for `INVALID_FROM_STATE` / `TOO_MANY_DOCUMENTS`.
  - `isOwnBusinessDocPath(path: string, userId: string): boolean`, exported, with the same regex shape as `isOwnSlipPath`: `^business-docs/<userId>/<uuid>\.(jpeg|png|webp)$`.
  - `CustomerAccountView.b2b.documents` lists ids only, never paths or URLs: the customer doesn't need to re-download.

- [ ] **Step 1: Write the failing tests.**
  - Customer applies → 200, `b2b.status === 'PENDING_VERIFICATION'`, `type === 'B2C'`.
  - **Review Focus 1:** customer B posts `documentPaths: ['business-docs/<A.id>/<uuid>.jpeg']` → 400, and A's and B's document lists are empty.
  - Path traversal `business-docs/<B.id>/../x.jpeg` → 400.
  - `pdpaConsent` missing → 400.
  - The 4th doc-upload-url → 409.
  - `GET /account` for a user with no profile → `{ type: 'B2C', b2b: null }`.
- [ ] **Step 2: Run** `pnpm --filter @datawan/worker exec vitest run test/liffB2b.test.ts`. Expected: FAIL (404).
- [ ] **Step 3: Implement** the three routes, following the `/orders/:id/slip-upload-url` and `/slip` patterns (`readJson`, `safeParse`, `apiError`, `conflictError`).
- [ ] **Step 4: Run** the test, plus `test/e2e/authz.e2e.test.ts`. Expected: PASS. The authz suite auto-discovers the routes and asserts 401 without a token.
- [ ] **Step 5: Commit:** `feat(worker): LIFF B2B account endpoints`.

### Task 6: Owner customer routes

**Files:**
- Modify: `apps/worker/src/routes/owner.ts`
- Test: `apps/worker/test/ownerB2b.test.ts`

**Interfaces:**
- Consumes: Task 4's decision functions; `deps.storage.getSignedUrl('business-docs', key, 300)`; `mapUrl()` from `views.ts`.
- Produces:
  - `GET /api/owner/customers?filter=pending|b2b|all` (default `pending`) → `OwnerB2bSummaryView[]`;
  - `GET /api/owner/customers/:userId` → `OwnerB2bDetailView`, or 404. `taxIdValid` is `isValidThaiTaxId(taxId)`, or `null` when there's no Tax ID.
  - `POST /api/owner/customers/:userId/approve` → `OwnerB2bDetailView`;
  - `POST /api/owner/customers/:userId/reject` with `OwnerB2bReasonRequest`;
  - `POST /api/owner/customers/:userId/acknowledge`;
  - `POST /api/owner/customers/:userId/revoke` with `OwnerB2bReasonRequest`.
  - All four POSTs return 409 `INVALID_FROM_STATE` from a wrong state and 404 for an unknown user. The decided-by owner id is `c.get('ownerId')`.

- [ ] **Step 1: Write the failing tests.**
  - The pending list has the applicant and `filter=b2b` doesn't.
  - Approve → 200 `status: 'VERIFIED'`, then a second approve → 409.
  - Reject without a reason → 400.
  - Detail document URLs come from `MemoryStorage.getSignedUrl` with expiry `300`.
  - `taxIdValid === false` for `'0105536000316'`.
- [ ] **Step 2: Run** `pnpm --filter @datawan/worker exec vitest run test/ownerB2b.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes.
- [ ] **Step 4: Run** the test, plus `test/e2e/authz.e2e.test.ts`. Expected: PASS (every new owner route returns 401 for a missing, garbage or customer token).
- [ ] **Step 5: Commit:** `feat(worker): owner B2B review endpoints`.

### Task 7: Orders and pricing use verified status only

**Files:**
- Modify:
  - `apps/worker/src/services/pricing.ts` (`suggestPrice`);
  - `apps/worker/src/services/views.ts` (`toOwnerOrderView`);
  - `apps/worker/src/line/flex/owner.ts` (`lalamoveCardText`).
- Test: `apps/worker/test/b2bOrders.test.ts`

**Interfaces:**
- Consumes: `repo.getBusinessProfile`.
- Produces:
  - `suggestPrice` computes the anchor only when `user.user_type === 'B2B'` **and** the profile status is `'VERIFIED'`. Both are checked, so a stale `user_type` can't leak the anchor.
  - `OwnerViewArgs` gains `b2bProfile: BusinessProfileRow | null`. `customer.b2b = profile?.status === 'VERIFIED' ? { businessName: user.business_name ?? profile.business_name, deliveryWindow: user.default_delivery_window } : null`.
  - `lalamoveCardText` adds `เวลาส่งประจำ: <window> น.` when `order.requested_delivery_at` is null and `user.user_type === 'B2B'` with a `default_delivery_window`.

- [ ] **Step 1: Write the failing tests.**
  - Pending applicant with a 30-day purchase history → `b2bAnchorPriceSatang === null` and `customer.b2b === null`.
  - After approval → the anchor is non-null, and `customer.b2b.businessName` is the shop name.
  - **Review Focus 4:** after revoke, the same open order → `customer.b2b === null` and the anchor is `null`.
  - The Lalamove text contains `เวลาส่งประจำ: 06:00-08:00 น.` for a verified shop with no requested time, and doesn't for a B2C customer.
- [ ] **Step 2: Run** `pnpm --filter @datawan/worker exec vitest run test/b2bOrders.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Load the profile where `buildOwnerView` loads the user.
- [ ] **Step 4: Run** the test, plus the full worker suite `pnpm --filter @datawan/worker test`. Expected: PASS (existing Lalamove and owner-view tests unchanged).
- [ ] **Step 5: Commit:** `feat(worker): B2B badge, anchor and delivery window only for verified shops`.

### Task 8: Chat keyword and document purge cron

**Files:**
- Modify:
  - `apps/worker/src/handlers/customer.ts`;
  - `apps/worker/src/jobs/cleanup.ts`;
  - `packages/shared/src/i18n/th.ts` (if not done in Task 1).
- Test: `apps/worker/test/b2bChatAndPurge.test.ts`

**Interfaces:**
- Consumes: `purgeDecidedDocuments` (Task 4); `th.b2bAccountLink`.
- Produces:
  - `B2B_KEYWORD_RE = /(สมัคร\s*ร้านค้า|บัญชี\s*ร้าน|ร้านค้า\s*b2b|\bb2b\b)/i`, exported.
  - In `handleCustomerEvent`, the text path checks it right after `TRACKING_RE`, before the order parser. It replies (never pushes) with the link `https://liff.line.me/<LIFF_ID>/account`. The link base comes from the same config the order-room links use.
  - The status is appended when a profile exists: "สถานะ: รอร้านตรวจสอบ / ยืนยันแล้ว / ไม่ผ่าน".
  - `runImageCleanup` adds `await purgeDecidedDocuments(deps)` to its count. The purge removes the objects through `storage.remove('business-docs', keys)`, then deletes the rows, then writes one `B2B_DOCS_PURGED { count }` event per user (actor `system`).

- [ ] **Step 1: Write the failing tests.**
  - "สมัครร้านค้า" → one reply containing `/account`, zero pushes, and no order created.
  - "บัญชีร้าน" with a pending profile → the reply contains "รอร้านตรวจสอบ".
  - **Review Focus 5:** profile decided 31 days ago, with doc A uploaded before the decision and doc B uploaded after it (a re-review) → the purge deletes A only. `MemoryStorage` still has B, and there's a `B2B_DOCS_PURGED {count:1}` event.
  - A profile decided 29 days ago → nothing deleted.
- [ ] **Step 2: Run** `pnpm --filter @datawan/worker exec vitest run test/b2bChatAndPurge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, plus `test/reviewFlag.test.ts` and `test/happyPath.test.ts`. Expected: PASS (the order parsing path is untouched).
- [ ] **Step 5: Commit:** `feat(worker): B2B chat keyword reply and 30-day document purge`.

### Task 9: Web, LIFF `/liff/account` page

**Files:**
- Modify:
  - `apps/web/src/lib/api.ts` (client functions);
  - `apps/web/src/lib/i18n/{dictionary,th,en}.ts`;
  - `apps/web/src/app/liff/orders/[id]/page.tsx` (a small "บัญชีของฉัน" link).
- Create:
  - `apps/web/src/app/liff/account/page.tsx`;
  - `apps/web/src/components/B2bApplicationForm.tsx`.
- Test: `apps/web/test/b2bForm.test.tsx` (`renderToStaticMarkup` style, like `recipientCard.test.tsx`)

**Interfaces:**
- Consumes: the Task 5 endpoints, and the Task 1 types and `isValidThaiTaxId`.
- Produces:
  - `getAccount(auth): Promise<CustomerAccountView>`
  - `getB2bDocUploadUrl(auth, contentType): Promise<{ uploadUrl: string; path: string }>`
  - `applyB2b(auth, body: B2bApplyRequest): Promise<CustomerAccountView>`

  All three go through `liffFetch`.
- `<B2bApplicationForm account t busy onSubmit />` layout, top to bottom:
  - the status banner: ⏳ / ✅ / ❌ with the reason and a สมัครใหม่ button;
  - the type toggle (ลูกค้าทั่วไป / ร้านค้า/ธุรกิจ);
  - the fields of Design §8, in this order: ชื่อร้าน, ประเภทธุรกิจ, ที่อยู่ร้าน, 📍 ใช้ตำแหน่งปัจจุบัน (`navigator.geolocation`, optional), เวลาส่งประจำ (two `<input type="time">`), เลขผู้เสียภาษี, photos;
  - the PDPA checkbox: large, the same style as the delivery-step checkbox;
  - the submit button, disabled until the required fields and consent are filled.
  - Photos use the existing `compressImage()`. Each one is PUT to the signed URL, then its `path` is collected into `documentPaths`.
  - A Tax ID that fails the checksum shows an inline warning but can still be submitted (the owner sees ✗).

- [ ] **Step 1: Write the failing tests.**
  - `account.b2b === null` → no banner, and the submit button is disabled.
  - `status: 'REJECTED', rejectionReason: 'ไม่พบหน้าร้าน'` → the banner contains the reason and "สมัครใหม่".
  - `status: 'VERIFIED', needsRereview: true` → it shows "ส่งให้ร้านตรวจอีกครั้ง".
  - The Tax ID warning appears for `'0105536000316'` and not for `'0105536000313'`.
- [ ] **Step 2: Run** `pnpm --filter @datawan/web exec vitest run test/b2bForm.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the page (auth via `useLiffAuth`, like the order room), the form and the API functions.
- [ ] **Step 4: Run** `pnpm --filter @datawan/web test` and `pnpm --filter @datawan/web typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): LIFF B2B account page`.

### Task 10: Web, dashboard "ลูกค้า" tab and order badge

**Files:**
- Modify:
  - `apps/web/src/lib/api.ts`;
  - `apps/web/src/app/dashboard/layout.tsx` (third `TabLink`, `/dashboard/customers`, with the pending count);
  - `apps/web/src/app/dashboard/orders/[id]/page.tsx` (badge + window);
  - the order list card component (badge);
  - `apps/web/src/mocks/{data,handlers}.ts`;
  - i18n.
- Create:
  - `apps/web/src/app/dashboard/customers/page.tsx`;
  - `apps/web/src/app/dashboard/customers/[userId]/page.tsx`.
- Test: `apps/web/test/b2bDashboard.test.tsx`

**Interfaces:**
- Consumes: the Task 6 endpoints, and `OwnerOrderView.customer.b2b` (Task 7).
- Produces:
  - `listB2bCustomers(token, filter)`
  - `getB2bCustomer(token, userId)`
  - `approveB2bCustomer(token, userId)`
  - `rejectB2bCustomer(token, userId, reason)`
  - `acknowledgeB2bCustomer(token, userId)`
  - `revokeB2bCustomer(token, userId, reason)`
  - `<B2bBadge b2b />` renders `[B2B - {businessName}]` or nothing.
- **List page:** sub-tabs รอตรวจ (n) / ร้านค้า B2B / ทั้งหมด.
- **Detail page:** the fields, the map link, Tax ID ✓/✗, photo thumbnails (signed URLs), and actions by state: อนุมัติ, ไม่อนุมัติ (reason textarea, required), รับทราบ, ยกเลิกสถานะ B2B (reason required).
  - Use in-page confirm UI, not `window.confirm`.

- [ ] **Step 1: Write the failing tests.**
  - `<B2bBadge b2b={null}/>` is empty, and `{businessName:'ร้านครัวทดสอบ', deliveryWindow:'06:00-08:00'}` renders `[B2B - ร้านครัวทดสอบ]`.
  - On a pending detail view, approve and reject are present and acknowledge isn't.
  - On a verified view with `needsRereview`, acknowledge and revoke are present and approve isn't.
  - A view with `taxIdValid: false` renders ✗.
- [ ] **Step 2: Run** `pnpm --filter @datawan/web exec vitest run test/b2bDashboard.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the pages, the badge and the API functions, plus mocks (one pending, one verified fake shop, with fake data only).
- [ ] **Step 4: Run** `pnpm --filter @datawan/web test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): owner ลูกค้า tab, B2B review and order badge`.

### Task 11: E2E on real Postgres, the web↔worker contract and the gate

**Files:**
- Modify:
  - `apps/worker/test/e2e/lifecycle.e2e.test.ts`;
  - `apps/worker/test/e2e/webContract.e2e.test.ts`;
  - `docs/API_AND_AI_CONTRACTS.md` (final check).

**Interfaces:**
- Consumes: everything above, through the real web `api.ts` functions against `SupabaseRepo` + PGlite.

- [ ] **Step 1: Write the E2E test** `b2b: apply → B2C order → approve → badge+anchor → rename → rereview kept → acknowledge → revoke; reject → reapply; purge`. Assertions:
  - after apply, `select status from business_profiles` = `PENDING_VERIFICATION`, and `users.user_type = 'B2C'`;
  - an order placed while pending shows `customer.b2b === null`;
  - after approve, `users.user_type = 'B2B'` and the next owner order view has the badge name;
  - after a rename, `needs_rereview = true` and `user_type` stays `'B2B'`;
  - after acknowledge, `users.business_name` = the new name;
  - after revoke, `user_type = 'B2C'`;
  - for a second user, reject → reapply → `PENDING_VERIFICATION`;
  - with `vi.setSystemTime` 31 days later, `runScheduled(deps, CRONS.CLEANUP)` deletes the pre-decision document rows;
  - `select payload::text from user_events` contains none of the fake business name, Tax ID or address.
- [ ] **Step 2: Contract test.** Every new web `api.ts` function is called once against the worker and the response parses as its view type. Unknown-route 404s fail the test.
- [ ] **Step 3: Run** `pnpm verify`. Expected: typecheck clean, all suites PASS, and the e2e count goes up from 91.
- [ ] **Step 4: Run** `pnpm audit:security`. Expected: RLS/authz PASS, the bundle scan says "no secrets found", and no business-doc paths or owner routes appear in the client bundle except as URL paths.
- [ ] **Step 5: Commit:** `test(e2e): B2B verification lifecycle on real Postgres`.

**Ship** (after review): push, open a PR, merge, `wrangler deploy` the worker and `pnpm run deploy` the web. The owner runs `0007` in the SQL Editor **before** the worker deploy. Then:
- in Obsidian, mark "B2B verification" done in `da-tawan-seafood Tasks.md`;
- the follow-up "LIFF order history + Reorder" stays open.
