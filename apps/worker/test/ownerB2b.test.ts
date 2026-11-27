/** Owner B2B review routes: real Hono app + in-memory repo + MemoryStorage. */
import { describe, expect, it, vi } from 'vitest';
import type { UserRow } from '@datawan/shared';
import { createApp } from '../src/app';
import { applyB2b } from '../src/services/b2b';
import { LIFF_TOKEN, makeHarness, OWNER_TOKEN } from './harness';

const UID = 'u-customer';
const doc = (n: number) => `business-docs/${UID}/00000000-0000-4000-8000-00000000000${n}.jpeg`;
const input = (over: Record<string, unknown> = {}) => ({
  businessName: 'Test Kitchen', businessType: 'restaurant' as const, addressText: '99 Test Road, Bangkok',
  lat: 13.7, lng: 100.5, deliveryWindow: null, taxId: '0105536000316', documentPaths: [doc(1), doc(2)], ...over,
});

async function setup() {
  const h = makeHarness();
  const app = createApp(h.deps);
  const user = (await h.repo.getUser(UID)) as UserRow;
  const r = await applyB2b(h.deps, user, input());
  expect(r.ok).toBe(true);
  const call = (path: string, body?: unknown, token = OWNER_TOKEN) =>
    app.request(`/api/owner/customers${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { h, call };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('owner B2B routes', () => {
  it('pending list has the applicant; filter=b2b does not; bad filter is 400', async () => {
    const { call } = await setup();
    const pending = (await (await call('')).json()) as any[];
    expect(pending.map((p) => p.userId)).toEqual([UID]);
    expect(pending[0].status).toBe('PENDING_VERIFICATION');
    expect(await (await call('?filter=b2b')).json()).toEqual([]);
    expect(((await (await call('?filter=all')).json()) as any[]).length).toBe(1);
    const bad = await call('?filter=bogus');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe('VALIDATION_FAILED');
  });

  it('detail: signed URLs with 300 s expiry, taxIdValid false for a bad checksum, owner phone, map link', async () => {
    const { h, call } = await setup();
    const spy = vi.spyOn(h.deps.storage, 'getSignedUrl');
    const res = await call(`/${UID}`);
    expect(res.status).toBe(200);
    const v = (await res.json()) as any;
    expect(v.taxIdValid).toBe(false);
    expect(v.documents).toHaveLength(2);
    expect(v.documents[0].url).toMatch(/^memory:\/\/signed\/business-docs\/u-customer\//);
    expect(spy).toHaveBeenCalledWith('business-docs', expect.stringMatching(/^u-customer\//), 300);
    expect(v.mapUrl).toContain('13.7,100.5');
    expect(v.phone).toBeTruthy();
    expect(v.customerName).toBeTruthy();
  });

  it('taxIdValid is null without a Tax ID, 404 for an unknown user', async () => {
    const h = makeHarness();
    const app = createApp(h.deps);
    const user = (await h.repo.getUser(UID)) as UserRow;
    await applyB2b(h.deps, user, input({ taxId: null, documentPaths: [] }));
    const hdr = { Authorization: `Bearer ${OWNER_TOKEN}` };
    expect(((await (await app.request(`/api/owner/customers/${UID}`, { headers: hdr })).json()) as any).taxIdValid).toBeNull();
    expect((await app.request('/api/owner/customers/nobody', { headers: hdr })).status).toBe(404);
  });

  it('a document whose URL cannot be signed is left out; the detail still returns 200', async () => {
    const { h, call } = await setup();
    const orig = h.deps.storage.getSignedUrl.bind(h.deps.storage);
    vi.spyOn(h.deps.storage, 'getSignedUrl').mockImplementation(async (b, k, e) => {
      if (k.endsWith('000000000001.jpeg')) throw new Error('object missing');
      return orig(b, k, e);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await call(`/${UID}`);
    expect(res.status).toBe(200);
    const v = (await res.json()) as any;
    expect(v.documents).toHaveLength(1);
    expect(v.documents[0].url).toContain('000000000002.jpeg');
    expect(warn).toHaveBeenCalledWith('[b2b] doc url failed', expect.any(String));
    warn.mockRestore();
  });

  it('approve → VERIFIED detail, second approve → 409 INVALID_FROM_STATE, unknown user → 404', async () => {
    const { call } = await setup();
    const ok = await call(`/${UID}/approve`, {});
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).status).toBe('VERIFIED');
    const again = await call(`/${UID}/approve`, {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error.code).toBe('INVALID_FROM_STATE');
    expect((await call('/nobody/approve', {})).status).toBe(404);
  });

  it('reject needs a reason (400); with one it returns REJECTED with the reason', async () => {
    const { call } = await setup();
    expect((await call(`/${UID}/reject`, {})).status).toBe(400);
    expect((await call(`/${UID}/reject`, { reason: '   ' })).status).toBe(400);
    const res = await call(`/${UID}/reject`, { reason: 'unclear document' });
    expect(res.status).toBe(200);
    const v = (await res.json()) as any;
    expect(v.status).toBe('REJECTED');
    expect(v.rejectionReason).toBe('unclear document');
  });

  it('revoke needs a reason and a VERIFIED profile; acknowledge is 409 outside re-review', async () => {
    const { call } = await setup();
    expect((await call(`/${UID}/revoke`, { reason: 'x' })).status).toBe(409);
    await call(`/${UID}/approve`, {});
    expect((await call(`/${UID}/revoke`, {})).status).toBe(400);
    expect((await call(`/${UID}/acknowledge`, {})).status).toBe(409);
    const res = await call(`/${UID}/revoke`, { reason: 'closed' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).not.toBe('VERIFIED');
  });

  it('rejects customer tokens', async () => {
    const { call } = await setup();
    expect((await call('', undefined, LIFF_TOKEN)).status).toBe(401);
  });
});
