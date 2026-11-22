import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Minimal config: no R2 incremental cache (see wrangler.toml). Every page is a client component.
export default defineCloudflareConfig({});
