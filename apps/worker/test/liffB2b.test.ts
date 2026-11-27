/** LIFF B2B account routes: real Hono app + in-memory repo. */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { LIFF_TOKEN, makeHarness } from './harness';

const TOKEN_B = 'test-liff-token-b';
const LINE_B = 'Ucustomerb000000000000000000000000';
const UUID1 = '11111111-1111-4111-8111-111111111111';

function setup() {
  const h = makeHarness();
  h.auth.liffUsers.set(TOKEN_B, LINE_B);
  return { h, app: createApp(h.deps) };
}

function call(app: ReturnType<typeof createApp>, token: string, path: string, body?: unknown) {
  return app.request(`/api/liff/account${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const apply = (paths: string[], extra: Record<string, unknown> = {}) => ({
  businessName: 'Test Kitchen', businessType: 'restaurant', addressText: '99 Test Road, Bangkok',
  lat: null, lng: null, deliveryWindow: null, taxId: null, documentPaths: paths, pdpaConsent: true, ...extra,
});

async function me(app: ReturnType<typeof createApp>, token: string) {
  // GET /account upserts the user; the harness user list gives us the id.
  await call(app, token, '');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('LIFF B2B account', () => {
  it('GET /account for a user with no profile is B2C with b2b null', async () => {
    const { app } = setup();
    const res = await call(app, LIFF_TOKEN, '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 'B2C', b2b: null });
  });

  it('a customer applies: PENDING_VERIFICATION, still B2C, documents are ids only', async () => {
    const { h, app } = setup();
    await me(app, LIFF_TOKEN);
    const user = h.repo.users.find((u) => u.line_user_id === 'Ucustomer00000000000000000000000000')!;
    const up = await (await call(app, LIFF_TOKEN, '/b2b/doc-upload-url', { contentType: 'image/jpeg' })).json() as { path: string };
    expect(up.path).toMatch(new RegExp(`^business-docs/${user.id}/[0-9a-f-]{36}\\.jpeg$`));
    const res = await call(app, LIFF_TOKEN, '/b2b', apply([up.path]));
    expect(res.status).toBe(200);
    const view = await res.json() as any;
    expect(view.type).toBe('B2C');
    expect(view.b2b.status).toBe('PENDING_VERIFICATION');
    expect(view.b2b.documents).toHaveLength(1);
    expect(Object.keys(view.b2b.documents[0])).toEqual(['id']);
  });

  it('rejects another customer\'s document path and a traversal, storing nothing', async () => {
    const { h, app } = setup();
    await me(app, LIFF_TOKEN);
    await me(app, TOKEN_B);
    const a = h.repo.users.find((u) => u.line_user_id === 'Ucustomer00000000000000000000000000')!;
    const b = h.repo.users.find((u) => u.line_user_id === LINE_B)!;
    let res = await call(app, TOKEN_B, '/b2b', apply([`business-docs/${a.id}/${UUID1}.jpeg`]));
    expect(res.status).toBe(400);
    res = await call(app, TOKEN_B, '/b2b', apply([`business-docs/${b.id}/../x.jpeg`]));
    expect(res.status).toBe(400);
    expect(await h.repo.listBusinessDocuments(a.id)).toEqual([]);
    expect(await h.repo.listBusinessDocuments(b.id)).toEqual([]);
    expect(await h.repo.getBusinessProfile(b.id)).toBeNull();
  });

  it('rejects a missing pdpaConsent', async () => {
    const { app } = setup();
    const { pdpaConsent: _p, ...noConsent } = apply([]);
    expect((await call(app, LIFF_TOKEN, '/b2b', noConsent)).status).toBe(400);
  });

  it('the 4th doc-upload-url is 409 TOO_MANY_DOCUMENTS', async () => {
    const { app } = setup();
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(app, LIFF_TOKEN, '/b2b/doc-upload-url', { contentType: 'image/png' });
      expect(res.status).toBe(200);
      paths.push(((await res.json()) as { path: string }).path);
    }
    expect((await call(app, LIFF_TOKEN, '/b2b', apply(paths))).status).toBe(200);
    const res = await call(app, LIFF_TOKEN, '/b2b/doc-upload-url', { contentType: 'image/png' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('TOO_MANY_DOCUMENTS');
  });

  it('the rejection reason is shown only once REJECTED', async () => {
    const { h, app } = setup();
    expect((await call(app, LIFF_TOKEN, '/b2b', apply([]))).status).toBe(200);
    const user = h.repo.users.find((u) => u.line_user_id === 'Ucustomer00000000000000000000000000')!;
    const view = await (await call(app, LIFF_TOKEN, '')).json() as any;
    expect(view.b2b.rejectionReason).toBeNull();
    await h.repo.updateBusinessProfile(user.id, 'PENDING_VERIFICATION', { status: 'REJECTED', rejection_reason: 'blurry' });
    expect(((await (await call(app, LIFF_TOKEN, '')).json()) as any).b2b.rejectionReason).toBe('blurry');
  });
});
