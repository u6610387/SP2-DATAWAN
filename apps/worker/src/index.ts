/**
 * Cloudflare Worker entry: LINE webhook + cron. REST API for LIFF/dashboard comes in Part 2.
 */
import { Hono } from 'hono';
import { createAi } from '@datawan/ai';
import type { Deps } from './deps';
import { loadConfig, type Bindings } from './env';
import { runScheduled } from './jobs';
import { createLineApi } from './line/api';
import { getQuotaStatus } from './line/quota';
import { ConsoleNotifier } from './services/notifier';
import { createSupabaseBroadcaster } from './services/realtime';
import { SupabaseRepo } from './services/repo.supabase';
import { createSupabaseStorage } from './services/storage';
import { handleWebhook } from './routes/webhook';

export function buildDeps(env: Bindings): Deps {
  const cfg = loadConfig(env);
  return {
    cfg,
    repo: SupabaseRepo.fromEnv(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY),
    line: createLineApi(cfg.LINE_CHANNEL_ACCESS_TOKEN),
    ai: createAi(cfg, { onMeta: (m) => console.log('[ai]', JSON.stringify(m)) }),
    notifier: new ConsoleNotifier(), // TODO(Kitirat): WebPushNotifier
    realtime: createSupabaseBroadcaster(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY),
    storage: createSupabaseStorage(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY),
    now: () => new Date(),
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true, env: c.env.APP_ENV ?? 'dev', ai: c.env.USE_MOCK_AI === 'false' ? 'gemini' : 'mock' }));

app.post('/webhook', async (c) => handleWebhook(buildDeps(c.env), await c.req.text(), c.req.header('x-line-signature') ?? null));

// Temporary, read-only, no PII. Owner auth (Supabase JWT) arrives with the REST API in Part 2.
app.get('/api/quota', async (c) => c.json(await getQuotaStatus(buildDeps(c.env))));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(buildDeps(env), event.cron).then((r) => console.log('[cron]', event.cron, JSON.stringify(r))));
  },
};
