/** Security headers config (verified against `next start` output in the security-rls-audit run). */
import { describe, expect, it } from 'vitest';
import nextConfig, { BASE_SECURITY_HEADERS, NO_FRAME_HEADERS } from '../next.config';

describe('next.config headers()', () => {
  it('sends nosniff / referrer / HSTS everywhere and blocks framing except under /liff', async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toContainEqual({ source: '/:path*', headers: BASE_SECURITY_HEADERS });
    const noFrame = rules.find((r) => r.headers === NO_FRAME_HEADERS)!;
    const re = new RegExp(`^${noFrame.source.replace('/((?!liff).*)', '/((?!liff).*)')}$`);
    for (const p of ['/', '/dashboard', '/dashboard/orders/abc', '/login']) expect(re.test(p), p).toBe(true);
    for (const p of ['/liff', '/liff/orders/abc']) expect(re.test(p), p).toBe(false);
    expect(NO_FRAME_HEADERS).toContainEqual({ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" });
  });
});
