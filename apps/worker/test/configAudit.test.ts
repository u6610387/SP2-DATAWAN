import { describe, expect, it } from 'vitest';
import { auditConfig, summarize } from '../src/services/configAudit';
import { ConfigSchema } from '../src/env';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function vapidPair() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { pub: b64url(pub), priv: jwk.d! };
}

const OWNER_UUID = '22222222-2222-4222-8222-222222222222';
const okFetch = (async (url: string) => {
  if (url.includes('/auth/v1/admin/users/')) return new Response(JSON.stringify({ id: OWNER_UUID, app_metadata: { role: 'owner' } }));
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

async function realCfg(overrides: Record<string, string> = {}) {
  const v = await vapidPair();
  return ConfigSchema.parse({
    LINE_CHANNEL_SECRET: '0123456789abcdef0123456789abcdef',
    LINE_CHANNEL_ACCESS_TOKEN: 'A'.repeat(60) + 'b9/+='.repeat(25),
    LINE_OWNER_USER_ID: 'U0123456789abcdef0123456789abcdef',
    LINE_LOGIN_CHANNEL_ID: '2006123456',
    LIFF_ID: '2006123456-AbCdEf12',
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
    OWNER_AUTH_USER_ID: OWNER_UUID,
    PROMPTPAY_ID: '0891234567',
    PROMPTPAY_RECEIVER_NAME: 'ดาทะวัน ซีฟู้ด',
    VAPID_PUBLIC_KEY: v.pub,
    VAPID_PRIVATE_KEY: v.priv,
    VAPID_SUBJECT: 'mailto:shop@datawan.test',
    ...overrides,
  });
}

describe('auditConfig', () => {
  it('passes realistic values', async () => {
    const s = summarize(await auditConfig(await realCfg(), okFetch));
    expect(s.failing).toEqual({});
    expect(s.ok).toBe(true);
  });

  it('flags template placeholders and never echoes values', async () => {
    const cfg = await realCfg({
      LINE_CHANNEL_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      PROMPTPAY_ID: '0812345678',
      PROMPTPAY_RECEIVER_NAME: 'YOUR_SHOP_NAME',
      VAPID_SUBJECT: 'mailto:team-highlow@example.com',
      LIFF_ID: '1999999999-AbCdEf12',
    });
    const r = await auditConfig(cfg, okFetch);
    expect(r.LINE_CHANNEL_SECRET).toMatchObject({ ok: false, issue: 'placeholder_pattern' });
    expect(r.PROMPTPAY_ID).toMatchObject({ ok: false, issue: 'known_example_value' });
    expect(r.PROMPTPAY_RECEIVER_NAME).toMatchObject({ ok: false, issue: 'placeholder_pattern' });
    expect(r.VAPID_SUBJECT).toMatchObject({ ok: false, issue: 'template_default' });
    expect(r.LIFF_ID).toMatchObject({ ok: false, issue: 'channel_prefix_mismatch' });
    const out = JSON.stringify(summarize(r));
    for (const secret of [cfg.LINE_CHANNEL_ACCESS_TOKEN, cfg.VAPID_PRIVATE_KEY, cfg.SUPABASE_SERVICE_ROLE_KEY, cfg.PROMPTPAY_ID, ...cfg.LINE_OWNER_USER_ID]) {
      expect(out).not.toContain(secret);
    }
  });

  it('detects a VAPID private key that does not match the public key', async () => {
    const other = await vapidPair();
    const r = await auditConfig(await realCfg({ VAPID_PRIVATE_KEY: other.priv }), okFetch);
    expect(r.VAPID_PRIVATE_KEY).toMatchObject({ ok: false, issue: 'pair_mismatch' });
  });

  it('reports LINE token rejection and owner user missing from the project', async () => {
    const f = (async (url: string) =>
      new Response('{}', { status: url.includes('/v2/bot/info') ? 401 : url.includes('/admin/users/') ? 404 : 200 })) as unknown as typeof fetch;
    const r = await auditConfig(await realCfg(), f);
    expect(r.LINE_CHANNEL_ACCESS_TOKEN).toMatchObject({ ok: false, issue: 'line_api_rejected', lineBotInfo: 401 });
    expect(r.OWNER_AUTH_USER_ID).toMatchObject({ ok: false, issue: 'user_not_in_project' });
  });
});
