/** All HTTP routes, built from an already-constructed Deps so tests can inject fakes (test/harness.ts). */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Deps } from './deps';
import type { Bindings } from './env';
import { createLiffRoutes } from './routes/liff';
import { createOwnerRoutes } from './routes/owner';
import { handleWebhook } from './routes/webhook';

export function createApp(deps: Deps) {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get('/health', (c) => c.json({ ok: true, env: deps.cfg.APP_ENV, ai: deps.ai.provider }));

  app.post('/webhook', async (c) => handleWebhook(deps, await c.req.text(), c.req.header('x-line-signature') ?? null));

  // CORS must run BEFORE the routers' auth middleware: browsers send the OPTIONS preflight
  // without an Authorization header, so it has to be answered here (204) rather than 401.
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (deps.cfg.CORS_ALLOWED_ORIGINS.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'If-Match', 'x-liff-dev-user'],
      maxAge: 600,
    }),
  );

  app.route('/api/owner', createOwnerRoutes(deps));
  app.route('/api/liff', createLiffRoutes(deps));

  return app;
}
