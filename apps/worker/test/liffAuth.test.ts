/**
 * Unit tests for the real LIFF auth verifier (not the test harness's FakeAuth), proving the
 * dev-bypass header is hard-gated to APP_ENV==='dev' and cannot activate in any other env
 * regardless of the LIFF_DEV_BYPASS flag — line-liff-architect / CLAUDE.md §3.2 concern about
 * no backdoor paths reaching exhibition/defence/production.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLiffVerifier } from '../src/auth/liff';

describe('createLiffVerifier', () => {
  it('honours the dev-bypass header only when APP_ENV=dev and LIFF_DEV_BYPASS=true', async () => {
    const fetchImpl = vi.fn();
    const verify = createLiffVerifier({ APP_ENV: 'dev', LIFF_DEV_BYPASS: true, LINE_LOGIN_CHANNEL_ID: 'x' }, fetchImpl);
    const r = await verify(null, 'Udev-user');
    expect(r).toEqual({ lineUserId: 'Udev-user' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores the dev header when LIFF_DEV_BYPASS is false, even in dev', async () => {
    const fetchImpl = vi.fn();
    const verify = createLiffVerifier({ APP_ENV: 'dev', LIFF_DEV_BYPASS: false, LINE_LOGIN_CHANNEL_ID: 'x' }, fetchImpl);
    const r = await verify(null, 'Udev-user');
    expect(r).toBeNull();
  });

  it('ignores the dev header outside APP_ENV=dev, even if LIFF_DEV_BYPASS is somehow true', async () => {
    const fetchImpl = vi.fn();
    for (const env of ['exhibition', 'defence', 'production'] as const) {
      const verify = createLiffVerifier({ APP_ENV: env, LIFF_DEV_BYPASS: true, LINE_LOGIN_CHANNEL_ID: 'x' }, fetchImpl);
      const r = await verify(null, 'Udev-user');
      expect(r).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('verifies a real ID token against LINE and returns the sub as lineUserId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sub: 'Uabc123' }), { status: 200 }));
    const verify = createLiffVerifier({ APP_ENV: 'production', LIFF_DEV_BYPASS: false, LINE_LOGIN_CHANNEL_ID: 'channel-1' }, fetchImpl);
    const r = await verify('some-id-token', null);
    expect(r).toEqual({ lineUserId: 'Uabc123' });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.line.me/oauth2/v2.1/verify', expect.objectContaining({ method: 'POST' }));
  });

  it('returns null when LINE rejects the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));
    const verify = createLiffVerifier({ APP_ENV: 'production', LIFF_DEV_BYPASS: false, LINE_LOGIN_CHANNEL_ID: 'channel-1' }, fetchImpl);
    expect(await verify('bad-token', null)).toBeNull();
  });

  it('returns null with no token and no dev header', async () => {
    const fetchImpl = vi.fn();
    const verify = createLiffVerifier({ APP_ENV: 'dev', LIFF_DEV_BYPASS: true, LINE_LOGIN_CHANNEL_ID: 'x' }, fetchImpl);
    expect(await verify(null, null)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
