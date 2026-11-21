/** Cloudflare Worker entry: builds Deps from env, then delegates to app.ts (routes) / jobs (cron). */
import { createAi } from '@datawan/ai';
import { createLiffVerifier } from './auth/liff';
import { createSupabaseOwnerVerifier } from './auth/owner';
import type { Deps } from './deps';
import { loadConfig, type Bindings } from './env';
import { createApp } from './app';
import { runScheduled } from './jobs';
import { createLineApi } from './line/api';
import { createSupabaseBroadcaster } from './services/realtime';
import { SupabaseRepo } from './services/repo.supabase';
import { createSupabaseStorage } from './services/storage';
import { createWebPushNotifier } from './services/webpush';

export function buildDeps(env: Bindings): Deps {
  const cfg = loadConfig(env);
  const repo = SupabaseRepo.fromEnv(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY);
  return {
    cfg,
    repo,
    line: createLineApi(cfg.LINE_CHANNEL_ACCESS_TOKEN),
    ai: createAi(cfg, { onMeta: (m) => console.log('[ai]', JSON.stringify(m)) }),
    notifier: createWebPushNotifier(cfg, repo),
    realtime: createSupabaseBroadcaster(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY),
    storage: createSupabaseStorage(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY),
    auth: {
      verifyOwner: createSupabaseOwnerVerifier(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY),
      verifyLiffUser: createLiffVerifier(cfg),
    },
    now: () => new Date(),
  };
}

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return createApp(buildDeps(env)).fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(buildDeps(env), event.cron).then((r) => console.log('[cron]', event.cron, JSON.stringify(r))));
  },
};
