/**
 * GET /api/owner/customers must use a constant number of DB calls, whatever the number of
 * business profiles (Workers Free: 50 subrequests per request). It used to look up each
 * profile's user one at a time, so it would fail at ~48 profiles. See ownerOrdersList.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { applyB2b } from '../src/services/b2b';
import { makeHarness, OWNER_TOKEN } from './harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function scenario(n: number) {
  const h = makeHarness();
  const base = h.repo.users[0]!;
  for (let i = 0; i < n; i++) {
    const user = i === 0 ? base : { ...base, id: `u-shop-${i}`, line_user_id: `U${String(i).padStart(32, '0')}`, full_name: `Shop owner ${i}` };
    if (i > 0) h.repo.users.push(user);
    await applyB2b(h.deps, user, { businessName: `Shop ${i}`, businessType: 'restaurant', addressText: `99 Road ${i}`, lat: null, lng: null, deliveryWindow: null, taxId: null, documentPaths: [] });
  }
  let calls = 0;
  const repo = new Proxy(h.deps.repo as unknown as Record<string, unknown>, {
    get(t, k) {
      const v = t[k as string];
      return typeof v === 'function' ? (...a: unknown[]) => { calls++; return (v as (...x: unknown[]) => unknown).apply(t, a); } : v;
    },
  });
  return { h, app: createApp({ ...h.deps, repo: repo as never }), calls: () => calls, reset: () => { calls = 0; } };
}

describe('GET /api/owner/customers', () => {
  for (const filter of ['all', 'pending']) {
    it(`filter=${filter}: same number of repo calls for 1 and for 20 profiles`, async () => {
      const counts: number[] = [];
      for (const n of [1, 20]) {
        const s = await scenario(n);
        s.reset();
        const res = await s.app.request(`/api/owner/customers?filter=${filter}`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
        expect(res.status).toBe(200);
        expect(((await res.json()) as unknown[]).length).toBe(n);
        counts.push(s.calls());
      }
      expect(counts[1]).toBe(counts[0]);
    });
  }

  it('each row still carries its own customer (names not mixed up)', async () => {
    const s = await scenario(5);
    const app = createApp(s.h.deps);
    const list = (await (await app.request('/api/owner/customers?filter=all', { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).json()) as any[];
    for (const row of list) {
      const one = (await (await app.request(`/api/owner/customers/${row.userId}`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).json()) as any;
      for (const k of Object.keys(row)) if (k in one) expect(row[k], k).toEqual(one[k]);
    }
  });
});
