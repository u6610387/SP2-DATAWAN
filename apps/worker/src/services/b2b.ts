/**
 * B2B verification: customer applies, the owner decides (CLAUDE.md §3.1 human-in-the-loop).
 * Code never approves: approve / reject / acknowledge / revoke all take an explicit `ownerId`
 * from an owner-authenticated caller. Every transition writes one `user_events` row whose
 * payload holds field names / counts only, never business data (PDPA).
 *
 * State guards: each owner decision re-checks the expected status and the `updated_at` the owner's
 * detail view showed inside the repo update (`updateBusinessProfile` returns null when either no
 * longer matches), so a double-click, a race or a customer edit the owner has not seen yields
 * INVALID_FROM_STATE and no audit row (the owner decides on the data they saw).
 */
import type { B2bApplyRequest, BusinessDocumentRow, BusinessProfileRow, UserRow } from '@datawan/shared';
import type { Deps } from '../deps';
import { splitPath } from './storage';

/** Supplier documents are kept this many days after the owner's decision (Design §3.9). */
export const B2B_DOC_RETENTION_DAYS = 30;
const MAX_DOCUMENTS = 3;

export type B2bApplyInput = Omit<B2bApplyRequest, 'pdpaConsent'>;

export type B2bResult =
  | { ok: true; profile: BusinessProfileRow }
  | { ok: false; reason: 'INVALID_FROM_STATE' | 'NOT_FOUND' | 'TOO_MANY_DOCUMENTS' };

const fail = (reason: 'INVALID_FROM_STATE' | 'NOT_FOUND' | 'TOO_MANY_DOCUMENTS'): B2bResult => ({ ok: false, reason });
const invalid = () => fail('INVALID_FROM_STATE');

function profileFields(input: B2bApplyInput) {
  return {
    business_name: input.businessName.trim(),
    business_type: input.businessType,
    address_text: input.addressText.trim(),
    lat: input.lat,
    lng: input.lng,
    default_delivery_window: input.deliveryWindow,
    tax_id: input.taxId,
  };
}

/** `business-docs/<userId>/<uuid>.jpeg` → `image/jpeg` (paths are pre-validated by the caller). */
function contentTypeOf(path: string): string {
  return `image/${path.slice(path.lastIndexOf('.') + 1)}`;
}

/** Sensitive fields whose change on a VERIFIED shop needs the owner to look again. */
function changedSensitiveFields(profile: BusinessProfileRow, fields: ReturnType<typeof profileFields>): string[] {
  const changed: string[] = [];
  if (profile.business_name.trim() !== fields.business_name) changed.push('business_name');
  if (profile.tax_id !== fields.tax_id) changed.push('tax_id');
  return changed;
}

export async function applyB2b(deps: Deps, user: UserRow, input: B2bApplyInput): Promise<B2bResult> {
  const existing = await deps.repo.getBusinessProfile(user.id);
  let docs = await deps.repo.listBusinessDocuments(user.id);
  if (existing?.status === 'REJECTED' && docs.length) {
    // The rejected application's documents are done with: delete them now, so the new
    // application starts from zero (re-sent old paths count as new uploads).
    await purgeDocuments(deps, docs);
    docs = [];
  }
  const known = new Set(docs.map((d) => d.path));
  const newPaths = [...new Set(input.documentPaths)].filter((p) => !known.has(p));
  if (docs.length + newPaths.length > MAX_DOCUMENTS) return fail('TOO_MANY_DOCUMENTS');

  const fields = profileFields(input);
  const nowIso = deps.now().toISOString();
  let profile: BusinessProfileRow | null;
  let event: { event: 'B2B_APPLIED' | 'B2B_UPDATED' | 'B2B_REREVIEW'; payload: Record<string, unknown> };
  let alert: 'B2B_APPLICATION' | 'B2B_REREVIEW' | null = null;

  if (!existing || existing.status === 'REJECTED') {
    profile = await deps.repo.upsertBusinessProfile({
      user_id: user.id,
      status: 'PENDING_VERIFICATION',
      ...fields,
      submitted_at: nowIso,
      decided_at: null,
      decided_by: null,
      verified_at: null,
      rejection_reason: null,
      needs_rereview: false,
      rereview_fields: [],
    });
    event = { event: 'B2B_APPLIED', payload: {} };
    alert = 'B2B_APPLICATION';
  } else if (existing.status === 'PENDING_VERIFICATION') {
    profile = await deps.repo.updateBusinessProfile(user.id, 'PENDING_VERIFICATION', fields);
    event = { event: 'B2B_UPDATED', payload: {} };
  } else {
    // VERIFIED: the users row keeps the owner-approved business name until acknowledged;
    // only the delivery window (not sensitive) follows the profile immediately. A customer
    // edit never writes user_type: the conditional update is a no-op if the owner revoked
    // the shop in the meantime (CLAUDE.md §3.1).
    // New documents on a verified shop are sensitive too: the owner must look at them, and the
    // acknowledge moves decided_at past them so the retention purge then covers them.
    const changed = [...changedSensitiveFields(existing, fields), ...(newPaths.length ? ['documents'] : [])];
    if (changed.length) {
      const rereviewFields = [...new Set([...existing.rereview_fields, ...changed])];
      profile = await deps.repo.updateBusinessProfile(user.id, 'VERIFIED', { ...fields, needs_rereview: true, rereview_fields: rereviewFields });
      event = { event: 'B2B_REREVIEW', payload: { fields: changed } };
      if (!existing.needs_rereview) alert = 'B2B_REREVIEW';
    } else {
      profile = await deps.repo.updateBusinessProfile(user.id, 'VERIFIED', fields);
      event = { event: 'B2B_UPDATED', payload: {} };
    }
    if (profile) {
      await deps.repo.updateUserB2bDetails(user.id, { default_delivery_window: fields.default_delivery_window });
    }
  }
  if (!profile) return invalid();

  if (newPaths.length) {
    await deps.repo.insertBusinessDocuments(newPaths.map((path) => ({ user_id: user.id, path, content_type: contentTypeOf(path) })));
  }
  await deps.repo.insertUserEvent({ user_id: user.id, actor: 'customer', event: event.event, payload: event.payload });
  if (alert) await deps.notifier.notify({ kind: alert, userId: user.id });
  return { ok: true, profile };
}

/** True when the profile changed since the owner's view (`updated_at` compared exactly as stored). */
const changedSinceView = (p: BusinessProfileRow, expectedUpdatedAt: string) => p.updated_at !== expectedUpdatedAt;

export async function approveB2b(deps: Deps, userId: string, ownerId: string, expectedUpdatedAt: string): Promise<B2bResult> {
  const existing = await deps.repo.getBusinessProfile(userId);
  if (!existing) return fail('NOT_FOUND');
  if (existing.status !== 'PENDING_VERIFICATION' || changedSinceView(existing, expectedUpdatedAt)) return invalid();
  const nowIso = deps.now().toISOString();
  const profile = await deps.repo.updateBusinessProfile(userId, 'PENDING_VERIFICATION', {
    status: 'VERIFIED',
    decided_at: nowIso,
    verified_at: nowIso,
    decided_by: ownerId,
    rejection_reason: null,
    needs_rereview: false,
    rereview_fields: [],
  }, expectedUpdatedAt);
  if (!profile) return invalid();
  await deps.repo.setUserB2B(userId, { user_type: 'B2B', business_name: profile.business_name, default_delivery_window: profile.default_delivery_window });
  await deps.repo.insertUserEvent({ user_id: userId, actor: 'owner', event: 'B2B_APPROVED', payload: {} });
  return { ok: true, profile };
}

export async function rejectB2b(deps: Deps, userId: string, ownerId: string, reason: string, expectedUpdatedAt: string): Promise<B2bResult> {
  const existing = await deps.repo.getBusinessProfile(userId);
  if (!existing) return fail('NOT_FOUND');
  if (existing.status !== 'PENDING_VERIFICATION' || changedSinceView(existing, expectedUpdatedAt)) return invalid();
  const profile = await deps.repo.updateBusinessProfile(userId, 'PENDING_VERIFICATION', {
    status: 'REJECTED',
    rejection_reason: reason.trim(),
    decided_at: deps.now().toISOString(),
    decided_by: ownerId,
  }, expectedUpdatedAt);
  if (!profile) return invalid();
  await deps.repo.setUserB2B(userId, { user_type: 'B2C', business_name: null, default_delivery_window: null });
  await deps.repo.insertUserEvent({ user_id: userId, actor: 'owner', event: 'B2B_REJECTED', payload: {} });
  return { ok: true, profile };
}

export async function acknowledgeB2b(deps: Deps, userId: string, ownerId: string, expectedUpdatedAt: string): Promise<B2bResult> {
  const existing = await deps.repo.getBusinessProfile(userId);
  if (!existing) return fail('NOT_FOUND');
  if (existing.status !== 'VERIFIED' || !existing.needs_rereview || changedSinceView(existing, expectedUpdatedAt)) return invalid();
  const profile = await deps.repo.updateBusinessProfile(userId, 'VERIFIED', {
    needs_rereview: false,
    rereview_fields: [],
    decided_at: deps.now().toISOString(),
    decided_by: ownerId,
  }, expectedUpdatedAt);
  if (!profile) return invalid();
  // Conditional on user_type = 'B2B': a racing revoke stays revoked.
  await deps.repo.updateUserB2bDetails(userId, { business_name: profile.business_name, default_delivery_window: profile.default_delivery_window });
  await deps.repo.insertUserEvent({ user_id: userId, actor: 'owner', event: 'B2B_ACKNOWLEDGED', payload: { fields: existing.rereview_fields } });
  return { ok: true, profile };
}

export async function revokeB2b(deps: Deps, userId: string, ownerId: string, reason: string, expectedUpdatedAt: string): Promise<B2bResult> {
  const existing = await deps.repo.getBusinessProfile(userId);
  if (!existing) return fail('NOT_FOUND');
  if (existing.status !== 'VERIFIED' || changedSinceView(existing, expectedUpdatedAt)) return invalid();
  const profile = await deps.repo.updateBusinessProfile(userId, 'VERIFIED', {
    status: 'REJECTED',
    rejection_reason: reason.trim(),
    needs_rereview: false,
    rereview_fields: [],
    decided_at: deps.now().toISOString(),
    decided_by: ownerId,
  }, expectedUpdatedAt);
  if (!profile) return invalid();
  await deps.repo.setUserB2B(userId, { user_type: 'B2C', business_name: null, default_delivery_window: null });
  await deps.repo.insertUserEvent({ user_id: userId, actor: 'owner', event: 'B2B_REVOKED', payload: {} });
  return { ok: true, profile };
}

/**
 * Deletes documents whose decision is older than B2B_DOC_RETENTION_DAYS: Storage objects first,
 * then the rows, so a failed Storage call throws with the rows intact and the next run retries.
 * Returns the number of documents purged.
 */
export async function purgeDecidedDocuments(deps: Deps): Promise<number> {
  const cutoffIso = new Date(deps.now().getTime() - B2B_DOC_RETENTION_DAYS * 86_400_000).toISOString();
  const docs = await deps.repo.listDocsDueForPurge(cutoffIso);
  await purgeDocuments(deps, docs);
  return docs.length;
}

/** Storage objects first, then rows, then one B2B_DOCS_PURGED {count} (actor system) per user. */
async function purgeDocuments(deps: Deps, docs: BusinessDocumentRow[]): Promise<void> {
  if (!docs.length) return;
  await deps.storage.remove('business-docs', docs.map((d) => splitPath(d.path).key));
  await deps.repo.deleteBusinessDocuments(docs.map((d) => d.id));
  const perUser = new Map<string, number>();
  for (const d of docs) perUser.set(d.user_id, (perUser.get(d.user_id) ?? 0) + 1);
  for (const [userId, count] of perUser) {
    await deps.repo.insertUserEvent({ user_id: userId, actor: 'system', event: 'B2B_DOCS_PURGED', payload: { count } });
  }
}
