/**
 * LIFF customer auth: verify the LIFF ID token via LINE's oauth2 verify endpoint
 * (line-liff-architect §6.1). A dev-only bypass lets the LIFF order room be exercised in a
 * normal Chrome tab via an `x-liff-dev-user` header instead of a real LINE login — gated on
 * APP_ENV === 'dev' *inside this function*, so no other env var can turn it on anywhere else.
 */
import type { Config } from '../env';

export function createLiffVerifier(cfg: Pick<Config, 'APP_ENV' | 'LIFF_DEV_BYPASS' | 'LINE_LOGIN_CHANNEL_ID'>, fetchImpl: typeof fetch = fetch) {
  return async function verifyLiffUser(idToken: string | null, devUserHeader: string | null): Promise<{ lineUserId: string } | null> {
    if (cfg.APP_ENV === 'dev' && cfg.LIFF_DEV_BYPASS && devUserHeader) {
      return { lineUserId: devUserHeader };
    }
    if (!idToken) return null;
    const res = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: cfg.LINE_LOGIN_CHANNEL_ID }),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { sub?: string };
    return payload.sub ? { lineUserId: payload.sub } : null;
  };
}
