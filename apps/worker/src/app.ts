/** All HTTP routes, built from an already-constructed Deps so tests can inject fakes (test/harness.ts). */
import { Hono } from 'hono';
import type { Deps } from './deps';
import type { Bindings } from './env';
import { createLiffRoutes } from './routes/liff';
import { createOwnerRoutes } from './routes/owner';
import { handleWebhook } from './routes/webhook';

export function createApp(deps: Deps) {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get('/health', (c) => c.json({ ok: true, env: deps.cfg.APP_ENV, ai: deps.ai.provider }));

  app.post('/webhook', async (c) => handleWebhook(deps, await c.req.text(), c.req.header('x-line-signature') ?? null));

  app.route('/api/owner', createOwnerRoutes(deps));
  app.route('/api/liff', createLiffRoutes(deps));

  return app;
}
