import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

/** Sent on every page. */
export const BASE_SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];
/**
 * Owner dashboard + login must never be framed (clickjacking on Confirm payment / Dispatch).
 * /liff is excluded: it runs inside LINE's in-app browser, so framing rules are left to LINE.
 */
export const NO_FRAME_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: BASE_SECURITY_HEADERS },
      { source: '/((?!liff).*)', headers: NO_FRAME_HEADERS },
    ];
  },
};

export default nextConfig;

// Lets `next dev` see Cloudflare bindings. Guarded so `next build` (run by `opennextjs-cloudflare build`)
// doesn't spin up a local workerd/Miniflare instance it doesn't need.
if (process.env.NODE_ENV === 'development') {
  initOpenNextCloudflareForDev();
}
