import { describe, expect, it } from 'vitest';
import type { UserRow } from '@datawan/shared';
import { B2B_KEYWORD_RE } from '../src/handlers/customer';
import { runImageCleanup } from '../src/jobs/cleanup';
import { applyB2b, approveB2b, B2B_DOC_RETENTION_DAYS } from '../src/services/b2b';
import type { MemoryStorage } from '../src/services/storage';
import { makeHarness, OWNER_AUTH } from './harness';

const UID = 'u-customer';
const docPath = (n: number) => `business-docs/${UID}/00000000-0000-4000-8000-00000000000${n}.jpeg`;
const input = (documentPaths: string[] = []) => ({
  businessName: 'ร้านทดสอบ ครัวสมมติ',
  businessType: 'restaurant' as const,
  addressText: '99 ถนนทดสอบ แขวงสมมติ',
  lat: 13.7,
  lng: 100.5,
  deliveryWindow: null,
  taxId: null,
  documentPaths,
});
// MemoryStorage.deleteOlderThan ignores the bucket, so keep slip retention out of the way.
const cleanup = (h: ReturnType<typeof makeHarness>) =>
  runImageCleanup({ ...h.deps, cfg: { ...h.deps.cfg, STORAGE_RETENTION_DAYS: 3650 } });
const upload = (h: ReturnType<typeof makeHarness>, n: number) =>
  (h.deps.storage as MemoryStorage).upload('business-docs', docPath(n).slice('business-docs/'.length), new Uint8Array([n]), 'image/jpeg');

describe('B2B_KEYWORD_RE', () => {
  it.each(['เลขบัญชีร้านอะไรคะ', 'โอนเข้าบัญชีร้านได้ไหม', 'บัญชีร้านค้าชื่ออะไร', 'กุ้ง 2 โล'])('does not match %s', (t) => {
    expect(B2B_KEYWORD_RE.test(t)).toBe(false);
  });
  it.each(['สมัครร้านค้า', 'อยากสมัครร้านค้าค่ะ', 'บัญชีร้าน', 'บัญชีร้านค้า', 'ร้านค้า B2B', 'b2b'])('matches %s', (t) => {
    expect(B2B_KEYWORD_RE.test(t)).toBe(true);
  });
});

describe('B2B chat keyword', () => {
  it('"สมัครร้านค้า" replies once with the /account link, no push, no order', async () => {
    const h = makeHarness();
    await h.customerText('สมัครร้านค้า');
    expect(h.line.replies).toHaveLength(1);
    expect(JSON.stringify(h.line.replies[0])).toContain('/account');
    expect(JSON.stringify(h.line.replies[0])).not.toContain('สถานะ:');
    expect(h.line.pushes).toHaveLength(0);
    expect(h.repo.orders).toHaveLength(0);
  });

  it('"บัญชีร้าน" with a pending profile appends the status', async () => {
    const h = makeHarness();
    await applyB2b(h.deps, (await h.repo.getUser(UID)) as UserRow, input());
    await h.customerText('บัญชีร้าน');
    expect(h.line.replies).toHaveLength(1);
    expect(JSON.stringify(h.line.replies[0])).toContain('รอร้านตรวจสอบ');
    expect(h.line.pushes).toHaveLength(0);
    expect(h.repo.orders).toHaveLength(0);
  });
});

describe('B2B document purge in the daily cleanup', () => {
  it('purges only documents uploaded before the decision, 31 days later', async () => {
    const h = makeHarness();
    await upload(h, 1);
    await applyB2b(h.deps, (await h.repo.getUser(UID)) as UserRow, input([docPath(1)]));
    h.clock.advance(1);
    await approveB2b(h.deps, UID, OWNER_AUTH, (await h.repo.getBusinessProfile(UID))!.updated_at);
    h.clock.advance(1);
    await upload(h, 2); // uploaded after the decision (a re-review)
    await h.repo.insertBusinessDocuments([{ user_id: UID, path: docPath(2), content_type: 'image/jpeg' }]);

    h.clock.advance(31 * 24 * 60);
    expect(await cleanup(h)).toBe(1);

    const storage = h.deps.storage as MemoryStorage;
    expect([...storage.objects.keys()].some((k) => k.includes('0001.jpeg'))).toBe(false);
    expect([...storage.objects.keys()].some((k) => k.includes('0002.jpeg'))).toBe(true);
    expect((await h.repo.listBusinessDocuments(UID)).map((d) => d.path)).toEqual([docPath(2)]);
    const purged = (await h.repo.listUserEvents(UID)).filter((e) => e.event === 'B2B_DOCS_PURGED');
    expect(purged).toMatchObject([{ actor: 'system', payload: { count: 1 } }]);
  });

  it('deletes nothing 29 days after the decision', async () => {
    const h = makeHarness();
    await upload(h, 1);
    await applyB2b(h.deps, (await h.repo.getUser(UID)) as UserRow, input([docPath(1)]));
    h.clock.advance(1);
    await approveB2b(h.deps, UID, OWNER_AUTH, (await h.repo.getBusinessProfile(UID))!.updated_at);
    h.clock.advance((B2B_DOC_RETENTION_DAYS - 1) * 24 * 60);
    expect(await cleanup(h)).toBe(0);
    expect((h.deps.storage as MemoryStorage).objects.size).toBe(1);
    expect(await h.repo.listBusinessDocuments(UID)).toHaveLength(1);
  });
});
