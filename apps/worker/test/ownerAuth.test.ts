import { describe, expect, it } from 'vitest';
import { createSupabaseOwnerVerifier } from '../src/auth/owner';

const URL_ = 'https://proj.supabase.co';
const json = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

function make(fetchImpl: typeof fetch, url = URL_) {
  const logs: string[] = [];
  const verify = createSupabaseOwnerVerifier(url, 'anon', fetchImpl, (m) => logs.push(m));
  return { verify, logs };
}

describe('createSupabaseOwnerVerifier', () => {
  it('accepts an owner and logs nothing', async () => {
    const { verify, logs } = make(json(200, { id: 'u1', app_metadata: { role: 'owner' } }));
    expect(await verify('tok')).toEqual({ id: 'u1' });
    expect(logs).toEqual([]);
  });

  it('logs supabase rejection with status, error code and host, never the token', async () => {
    const { verify, logs } = make(json(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }));
    expect(await verify('secret-token')).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"reason":"supabase_rejected"');
    expect(logs[0]).toContain('"status":403');
    expect(logs[0]).toContain('"errorCode":"bad_jwt"');
    expect(logs[0]).toContain('"supabaseHost":"proj.supabase.co"');
    expect(logs[0]).not.toContain('secret-token');
  });

  it('logs a non-owner role', async () => {
    const { verify, logs } = make(json(200, { id: 'u2', app_metadata: {} }));
    expect(await verify('tok')).toBeNull();
    expect(logs[0]).toContain('"reason":"not_owner_role"');
  });

  it('logs a missing token without calling supabase', async () => {
    let called = false;
    const { verify, logs } = make((async () => ((called = true), new Response('{}'))) as unknown as typeof fetch);
    expect(await verify(null)).toBeNull();
    expect(called).toBe(false);
    expect(logs[0]).toContain('"reason":"no_bearer_token"');
  });
});
