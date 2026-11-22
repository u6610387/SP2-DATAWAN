import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;

// Lets `next dev` see Cloudflare bindings. Guarded so `next build` (run by `opennextjs-cloudflare build`)
// doesn't spin up a local workerd/Miniflare instance it doesn't need.
if (process.env.NODE_ENV === 'development') {
  initOpenNextCloudflareForDev();
}
