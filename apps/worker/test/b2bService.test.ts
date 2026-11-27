import { describe, expect, it } from 'vitest';
import type { UserRow } from '@datawan/shared';
import {
  acknowledgeB2b,
  applyB2b,
  approveB2b,
  B2B_DOC_RETENTION_DAYS,
  type B2bApplyInput,
  purgeDecidedDocuments,
  rejectB2b,
  revokeB2b,
} from '../src/services/b2b';
import type { MemoryStorage } from '../src/services/storage';
import { makeHarness, OWNER_AUTH } from './harness';

const UID = 'u-customer';
const NAME = 'ร้านทดสอบ ครัวสมมติ';
const NEW_NAME = 'ร้านทดสอบ ครัวใหม่';
const TAX = '1234567890121';
const ADDRESS = '99 ถนนทดสอบ แขวงสมมติ';
const REASON = 'เอกสารไม่ชัดเจน ทดสอบ';

const doc = (n: number) => `business-docs/${UID}/00000000-0000-4000-8000-00000000000${n}.jpeg`;
const input = (over: Partial<B2bApplyInput> = {}): B2bApplyInput => ({
  businessName: NAME,
  businessType: 'restaurant',
  addressText: ADDRESS,
  lat: 13.7,
  lng: 100.5,
  deliveryWindow: '06:00-09:00',
  taxId: TAX,
  documentPaths: [],
  ...over,
});

async function setup() {
  const h = makeHarness();
  const user = (await h.repo.getUser(UID)) as UserRow;
  const fresh = async () => (await h.repo.getUser(UID)) as UserRow;
  const alerts = (kind: string) => h.notifier.alerts.filter((a) => a.kind === kind);
  const events = async () => (await h.repo.listUserEvents(UID)).map((e) => e.event);
  return { ...h, user, fresh, alerts, events };
}

async function verified() {
  const s = await setup();
  await applyB2b(s.deps, s.user, input());
  await approveB2b(s.deps, UID, OWNER_AUTH);
  s.notifier.alerts.length = 0;
  return s;
}

describe('B2B service — applyB2b', () => {
  it('no profile → PENDING_VERIFICATION, B2B_APPLIED (customer), alert B2B_APPLICATION without business name', async () => {
    const s = await setup();
    const r = await applyB2b(s.deps, s.user, input({ documentPaths: [doc(1)] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.status).toBe('PENDING_VERIFICATION');
    expect(r.profile.submitted_at).toBe(s.clock.now().toISOString());
    expect(r.profile.business_name).toBe(NAME);
    const ev = await s.repo.listUserEvents(UID);
    expect(ev.map((e) => [e.event, e.actor])).toEqual([['B2B_APPLIED', 'customer']]);
    expect(s.alerts('B2B_APPLICATION')).toEqual([{ kind: 'B2B_APPLICATION', userId: UID }]);
    expect(JSON.stringify(s.notifier.alerts)).not.toContain(NAME);
    const docs = await s.repo.listBusinessDocuments(UID);
    expect(docs.map((d) => [d.path, d.content_type])).toEqual([[doc(1), 'image/jpeg']]);
    expect((await s.fresh()).user_type).toBe('B2C');
  });

  it('PENDING → update fields, B2B_UPDATED, no second alert (Review Focus 3)', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input());
    const r = await applyB2b(s.deps, s.user, input({ addressText: '100 ถนนทดสอบใหม่' }));
    expect(r.ok && r.profile.address_text).toBe('100 ถนนทดสอบใหม่');
    expect(r.ok && r.profile.status).toBe('PENDING_VERIFICATION');
    expect(await s.events()).toEqual(['B2B_APPLIED', 'B2B_UPDATED']);
    expect(s.alerts('B2B_APPLICATION').length).toBe(1);
  });

  it('REJECTED → apply again → PENDING_VERIFICATION with decision fields cleared', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input());
    await rejectB2b(s.deps, UID, OWNER_AUTH, REASON);
    const r = await applyB2b(s.deps, s.user, input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.status).toBe('PENDING_VERIFICATION');
    expect(r.profile.rejection_reason).toBeNull();
    expect(r.profile.decided_at).toBeNull();
    expect(r.profile.decided_by).toBeNull();
    expect(await s.events()).toEqual(['B2B_APPLIED', 'B2B_REJECTED', 'B2B_APPLIED']);
    expect(s.alerts('B2B_APPLICATION').length).toBe(2);
  });

  it('VERIFIED, name changed → needs_rereview, users row keeps old name until acknowledge', async () => {
    const s = await verified();
    const r = await applyB2b(s.deps, await s.fresh(), input({ businessName: NEW_NAME, deliveryWindow: '07:00-10:00' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.status).toBe('VERIFIED');
    expect(r.profile.needs_rereview).toBe(true);
    expect(r.profile.rereview_fields).toEqual(['business_name']);
    const u = await s.fresh();
    expect(u.user_type).toBe('B2B');
    expect(u.business_name).toBe(NAME);
    expect(u.default_delivery_window).toBe('07:00-10:00');
    const ev = await s.repo.listUserEvents(UID);
    expect(ev.at(-1)).toMatchObject({ event: 'B2B_REREVIEW', actor: 'customer', payload: { fields: ['business_name'] } });
    expect(s.alerts('B2B_REREVIEW')).toEqual([{ kind: 'B2B_REREVIEW', userId: UID }]);

    // A second sensitive change while already flagged: fields unioned, no second alert.
    const r2 = await applyB2b(s.deps, await s.fresh(), input({ businessName: NEW_NAME, taxId: null }));
    expect(r2.ok && r2.profile.rereview_fields).toEqual(['business_name', 'tax_id']);
    expect(s.alerts('B2B_REREVIEW').length).toBe(1);

    const a = await acknowledgeB2b(s.deps, UID, OWNER_AUTH);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.profile.needs_rereview).toBe(false);
    expect(a.profile.rereview_fields).toEqual([]);
    expect(a.profile.decided_at).toBe(s.clock.now().toISOString());
    expect((await s.fresh()).business_name).toBe(NEW_NAME);
    const last = (await s.repo.listUserEvents(UID)).at(-1);
    expect(last).toMatchObject({ event: 'B2B_ACKNOWLEDGED', actor: 'owner', payload: { fields: ['business_name', 'tax_id'] } });
  });

  it('VERIFIED, name differs only by whitespace → not a re-review', async () => {
    const s = await verified();
    const r = await applyB2b(s.deps, await s.fresh(), input({ businessName: `  ${NAME} ` }));
    expect(r.ok && r.profile.needs_rereview).toBe(false);
    expect((await s.events()).at(-1)).toBe('B2B_UPDATED');
  });

  it('VERIFIED, other fields only → B2B_UPDATED, delivery window copied to users, no alert', async () => {
    const s = await verified();
    const r = await applyB2b(s.deps, await s.fresh(), input({ addressText: '1 ถนนใหม่ทดสอบ', deliveryWindow: '05:00-08:00' }));
    expect(r.ok && r.profile.needs_rereview).toBe(false);
    expect(r.ok && r.profile.address_text).toBe('1 ถนนใหม่ทดสอบ');
    const u = await s.fresh();
    expect(u.user_type).toBe('B2B');
    expect(u.business_name).toBe(NAME);
    expect(u.default_delivery_window).toBe('05:00-08:00');
    expect((await s.events()).at(-1)).toBe('B2B_UPDATED');
    expect(s.notifier.alerts).toEqual([]);
  });

  it('TOO_MANY_DOCUMENTS when existing + new > 3, and nothing is written', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input({ documentPaths: [doc(1), doc(2)] }));
    const r = await applyB2b(s.deps, s.user, input({ addressText: '2 ถนนอื่นทดสอบ', documentPaths: [doc(3), doc(4)] }));
    expect(r).toEqual({ ok: false, reason: 'TOO_MANY_DOCUMENTS' });
    expect((await s.repo.listBusinessDocuments(UID)).length).toBe(2);
    expect((await s.repo.getBusinessProfile(UID))?.address_text).toBe(ADDRESS);
    expect(await s.events()).toEqual(['B2B_APPLIED']);
    const ok = await applyB2b(s.deps, s.user, input({ documentPaths: [doc(3)] }));
    expect(ok.ok).toBe(true);
    expect((await s.repo.listBusinessDocuments(UID)).length).toBe(3);
  });
});

describe('B2B service — owner decisions', () => {
  it('approve PENDING → VERIFIED, users B2B, B2B_APPROVED (owner)', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input());
    const r = await approveB2b(s.deps, UID, OWNER_AUTH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const now = s.clock.now().toISOString();
    expect(r.profile).toMatchObject({ status: 'VERIFIED', decided_at: now, verified_at: now, decided_by: OWNER_AUTH });
    const u = await s.fresh();
    expect([u.user_type, u.business_name, u.default_delivery_window]).toEqual(['B2B', NAME, '06:00-09:00']);
    expect((await s.repo.listUserEvents(UID)).at(-1)).toMatchObject({ event: 'B2B_APPROVED', actor: 'owner', payload: {} });
  });

  it('approve twice → second INVALID_FROM_STATE, exactly one B2B_APPROVED (Review Focus 2)', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input());
    expect((await approveB2b(s.deps, UID, OWNER_AUTH)).ok).toBe(true);
    expect(await approveB2b(s.deps, UID, OWNER_AUTH)).toEqual({ ok: false, reason: 'INVALID_FROM_STATE' });
    expect((await s.events()).filter((e) => e === 'B2B_APPROVED').length).toBe(1);
  });

  it('a guarded update losing the race → INVALID_FROM_STATE, no event', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input());
    const real = s.repo.updateBusinessProfile.bind(s.repo);
    s.repo.updateBusinessProfile = async () => null;
    expect(await approveB2b(s.deps, UID, OWNER_AUTH)).toEqual({ ok: false, reason: 'INVALID_FROM_STATE' });
    s.repo.updateBusinessProfile = real;
    expect(await s.events()).toEqual(['B2B_APPLIED']);
    expect((await s.fresh()).user_type).toBe('B2C');
  });

  it('NOT_FOUND when there is no profile', async () => {
    const s = await setup();
    for (const r of [
      await approveB2b(s.deps, UID, OWNER_AUTH),
      await rejectB2b(s.deps, UID, OWNER_AUTH, REASON),
      await acknowledgeB2b(s.deps, UID, OWNER_AUTH),
      await revokeB2b(s.deps, UID, OWNER_AUTH, REASON),
    ]) expect(r).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('reject PENDING → REJECTED with reason, users B2C, B2B_REJECTED {}', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input());
    const r = await rejectB2b(s.deps, UID, OWNER_AUTH, `  ${REASON} `);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile).toMatchObject({ status: 'REJECTED', rejection_reason: REASON, decided_by: OWNER_AUTH, decided_at: s.clock.now().toISOString() });
    const u = await s.fresh();
    expect([u.user_type, u.business_name, u.default_delivery_window]).toEqual(['B2C', null, null]);
    expect((await s.repo.listUserEvents(UID)).at(-1)).toMatchObject({ event: 'B2B_REJECTED', actor: 'owner', payload: {} });
    // Reject is only from PENDING.
    expect(await rejectB2b(s.deps, UID, OWNER_AUTH, REASON)).toEqual({ ok: false, reason: 'INVALID_FROM_STATE' });
  });

  it('acknowledge requires VERIFIED with needs_rereview', async () => {
    const s = await verified();
    expect(await acknowledgeB2b(s.deps, UID, OWNER_AUTH)).toEqual({ ok: false, reason: 'INVALID_FROM_STATE' });
  });

  it('revoke VERIFIED → REJECTED, needs_rereview false, users B2C, B2B_REVOKED {}', async () => {
    const s = await verified();
    await applyB2b(s.deps, await s.fresh(), input({ businessName: NEW_NAME }));
    s.clock.advance(60);
    const r = await revokeB2b(s.deps, UID, OWNER_AUTH, REASON);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile).toMatchObject({ status: 'REJECTED', rejection_reason: REASON, needs_rereview: false, decided_by: OWNER_AUTH, decided_at: s.clock.now().toISOString() });
    const u = await s.fresh();
    expect([u.user_type, u.business_name, u.default_delivery_window]).toEqual(['B2C', null, null]);
    expect((await s.repo.listUserEvents(UID)).at(-1)).toMatchObject({ event: 'B2B_REVOKED', actor: 'owner', payload: {} });
    expect(await revokeB2b(s.deps, UID, OWNER_AUTH, REASON)).toEqual({ ok: false, reason: 'INVALID_FROM_STATE' });
  });

  it('approve from REJECTED → INVALID_FROM_STATE', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input());
    await rejectB2b(s.deps, UID, OWNER_AUTH, REASON);
    expect(await approveB2b(s.deps, UID, OWNER_AUTH)).toEqual({ ok: false, reason: 'INVALID_FROM_STATE' });
  });
});

describe('B2B service — audit PII guard', () => {
  it('user_events never contain business name, Tax ID, address or reason text', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input({ documentPaths: [doc(1)] }));
    await applyB2b(s.deps, s.user, input());
    await rejectB2b(s.deps, UID, OWNER_AUTH, REASON);
    await applyB2b(s.deps, s.user, input());
    await approveB2b(s.deps, UID, OWNER_AUTH);
    await applyB2b(s.deps, await s.fresh(), input({ businessName: NEW_NAME, taxId: '9876543210987' }));
    await acknowledgeB2b(s.deps, UID, OWNER_AUTH);
    await revokeB2b(s.deps, UID, OWNER_AUTH, REASON);
    s.clock.advance((B2B_DOC_RETENTION_DAYS + 1) * 24 * 60);
    await purgeDecidedDocuments(s.deps);
    const json = JSON.stringify(await s.repo.listUserEvents(UID));
    for (const secret of [NAME, NEW_NAME, TAX, '9876543210987', ADDRESS, REASON]) expect(json).not.toContain(secret);
    expect(JSON.stringify(s.notifier.alerts)).not.toContain(NAME);
  });
});

describe('B2B service — purgeDecidedDocuments', () => {
  it('removes storage objects and rows for documents decided > 30 days ago, logs B2B_DOCS_PURGED {count}', async () => {
    const s = await setup();
    const storage = s.deps.storage as MemoryStorage;
    for (const n of [1, 2]) await storage.upload('business-docs', doc(n).slice('business-docs/'.length), new Uint8Array([n]), 'image/jpeg');
    await applyB2b(s.deps, s.user, input({ documentPaths: [doc(1), doc(2)] }));
    s.clock.advance(1); // the owner decides after the upload
    await approveB2b(s.deps, UID, OWNER_AUTH);

    s.clock.advance((B2B_DOC_RETENTION_DAYS - 1) * 24 * 60);
    expect(await purgeDecidedDocuments(s.deps)).toBe(0);
    expect(storage.objects.size).toBe(2);

    s.clock.advance(2 * 24 * 60);
    expect(await purgeDecidedDocuments(s.deps)).toBe(2);
    expect(storage.objects.size).toBe(0);
    expect(await s.repo.listBusinessDocuments(UID)).toEqual([]);
    expect((await s.repo.listUserEvents(UID)).at(-1)).toMatchObject({ event: 'B2B_DOCS_PURGED', actor: 'system', payload: { count: 2 } });

    // Idempotent: nothing left to purge.
    expect(await purgeDecidedDocuments(s.deps)).toBe(0);
  });

  it('a failed storage remove throws before rows are deleted', async () => {
    const s = await setup();
    await applyB2b(s.deps, s.user, input({ documentPaths: [doc(1)] }));
    s.clock.advance(1);
    await approveB2b(s.deps, UID, OWNER_AUTH);
    s.clock.advance((B2B_DOC_RETENTION_DAYS + 1) * 24 * 60);
    s.deps.storage.remove = async () => { throw new Error('storage down'); };
    await expect(purgeDecidedDocuments(s.deps)).rejects.toThrow('storage down');
    expect((await s.repo.listBusinessDocuments(UID)).length).toBe(1);
    expect((await s.events()).includes('B2B_DOCS_PURGED')).toBe(false);
  });
});
