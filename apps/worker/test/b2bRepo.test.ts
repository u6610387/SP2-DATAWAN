import { describe, expect, it } from 'vitest';
import type { BusinessProfileRow } from '@datawan/shared';
import { MemoryRepo } from '../src/services/repo.memory';
import { MemoryStorage } from '../src/services/storage';

const profile = (user_id: string, over: Partial<BusinessProfileRow> = {}): Omit<BusinessProfileRow, 'created_at' | 'updated_at'> => ({
  user_id,
  status: 'PENDING_VERIFICATION',
  business_name: 'Test Kitchen',
  business_type: 'restaurant',
  address_text: '1 Test Road',
  lat: null,
  lng: null,
  default_delivery_window: null,
  tax_id: null,
  submitted_at: new Date().toISOString(),
  decided_at: null,
  decided_by: null,
  verified_at: null,
  rejection_reason: null,
  needs_rereview: false,
  rereview_fields: [],
  ...over,
});

describe('B2B repo (memory)', () => {
  it('updateBusinessProfile returns null and leaves the row unchanged when status differs', async () => {
    const repo = new MemoryRepo();
    await repo.upsertBusinessProfile(profile('u1'));
    const r = await repo.updateBusinessProfile('u1', 'VERIFIED', { status: 'REJECTED' });
    expect(r).toBeNull();
    expect((await repo.getBusinessProfile('u1'))?.status).toBe('PENDING_VERIFICATION');
    const ok = await repo.updateBusinessProfile('u1', 'PENDING_VERIFICATION', { status: 'VERIFIED' });
    expect(ok?.status).toBe('VERIFIED');
  });

  it('listBusinessProfiles filters pending / b2b / all', async () => {
    const repo = new MemoryRepo();
    await repo.upsertBusinessProfile(profile('p', { submitted_at: '2026-01-01T00:00:00Z' }));
    await repo.upsertBusinessProfile(profile('v', { status: 'VERIFIED', needs_rereview: true, submitted_at: '2026-01-02T00:00:00Z' }));
    await repo.upsertBusinessProfile(profile('v2', { status: 'VERIFIED', submitted_at: '2026-01-03T00:00:00Z' }));
    await repo.upsertBusinessProfile(profile('r', { status: 'REJECTED', submitted_at: '2026-01-04T00:00:00Z' }));
    expect((await repo.listBusinessProfiles('pending')).map((x) => x.user_id)).toEqual(['v', 'p']);
    expect((await repo.listBusinessProfiles('b2b')).map((x) => x.user_id)).toEqual(['v2', 'v']);
    expect(await repo.listBusinessProfiles('all')).toHaveLength(4);
  });

  it('listDocsDueForPurge honours decided_at and uploaded_at', async () => {
    const repo = new MemoryRepo();
    const day = 86_400_000;
    const decided = new Date(Date.now() - 40 * day).toISOString();
    await repo.upsertBusinessProfile(profile('a', { status: 'VERIFIED', decided_at: decided }));
    await repo.upsertBusinessProfile(profile('b'));
    const [old] = await repo.insertBusinessDocuments([{ user_id: 'a', path: 'business-docs/a/1.jpeg', content_type: 'image/jpeg' }]);
    old!.uploaded_at = new Date(Date.now() - 41 * day).toISOString();
    const [fresh] = await repo.insertBusinessDocuments([{ user_id: 'a', path: 'business-docs/a/2.jpeg', content_type: 'image/jpeg' }]);
    fresh!.uploaded_at = new Date(Date.now() - 10 * day).toISOString();
    await repo.insertBusinessDocuments([{ user_id: 'b', path: 'business-docs/b/1.jpeg', content_type: 'image/jpeg' }]);
    // memory rows are returned as copies; mutate the stored ones
    repo.businessDocuments.find((d) => d.id === old!.id)!.uploaded_at = old!.uploaded_at;
    repo.businessDocuments.find((d) => d.id === fresh!.id)!.uploaded_at = fresh!.uploaded_at;
    const due = await repo.listDocsDueForPurge(new Date(Date.now() - 30 * day).toISOString());
    expect(due.map((d) => d.path)).toEqual(['business-docs/a/1.jpeg']);
    await repo.deleteBusinessDocuments([old!.id]);
    expect((await repo.listBusinessDocuments('a')).map((d) => d.id)).toEqual([fresh!.id]);
  });

  it('updateUserB2bDetails only touches B2B users and never user_type', async () => {
    const repo = new MemoryRepo();
    const u = await repo.upsertUserByLineId('Utestb2bdetails00000000000000000');
    expect(await repo.updateUserB2bDetails(u.id, { default_delivery_window: '06:00-08:00' })).toBeNull();
    expect((await repo.getUser(u.id))?.default_delivery_window).toBeNull();
    await repo.setUserB2B(u.id, { user_type: 'B2B', business_name: 'Test Kitchen', default_delivery_window: null });
    const out = await repo.updateUserB2bDetails(u.id, { business_name: 'Test Kitchen 2', default_delivery_window: '07:00-09:00' });
    expect([out?.user_type, out?.business_name, out?.default_delivery_window]).toEqual(['B2B', 'Test Kitchen 2', '07:00-09:00']);
  });

  it('setUserB2B updates the user; user events list ascending', async () => {
    const repo = new MemoryRepo();
    const u = await repo.upsertUserByLineId('Utest');
    const out = await repo.setUserB2B(u.id, { user_type: 'B2B', business_name: 'Test Kitchen', default_delivery_window: '06:00-08:00' });
    expect(out).toMatchObject({ user_type: 'B2B', business_name: 'Test Kitchen', default_delivery_window: '06:00-08:00' });
    await repo.insertUserEvent({ user_id: u.id, actor: 'customer', event: 'B2B_APPLIED' });
    await repo.insertUserEvent({ user_id: u.id, actor: 'owner', event: 'B2B_APPROVED', payload: { x: 1 } });
    expect((await repo.listUserEvents(u.id)).map((e) => e.event)).toEqual(['B2B_APPLIED', 'B2B_APPROVED']);
  });
});

describe('MemoryStorage.remove', () => {
  it('deletes only the named keys', async () => {
    const s = new MemoryStorage();
    await s.upload('business-docs', 'u/1.jpeg', new Uint8Array([1]), 'image/jpeg');
    await s.upload('business-docs', 'u/2.jpeg', new Uint8Array([2]), 'image/jpeg');
    await s.remove('business-docs', ['u/1.jpeg']);
    expect([...s.objects.keys()]).toEqual(['business-docs/u/2.jpeg']);
  });
});
