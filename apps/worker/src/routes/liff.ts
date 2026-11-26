/**
 * Customer LIFF REST API — docs/API_AND_AI_CONTRACTS.md §2.2 (scoped to the LIFF order room;
 * see the Part 2 plan for the explicit cut list). Auth is the LIFF ID token (or the dev-bypass
 * header, gated inside auth/liff.ts to APP_ENV==='dev' only) — never a userId in the body.
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import {
  RecipientContactRequest, CounterOfferRequest, SlipSubmitRequest, SlipUploadUrlRequest, type CustomerOrderView, type OrderRow, type UserRow } from '@datawan/shared';
import type { Deps } from '../deps';
import type { Bindings } from '../env';
import * as actions from '../services/orderActions';
import { setRecipient } from '../services/recipient';
import { parseSlipQr } from '../services/slipQr';
import { PAYABLE } from '../handlers/customer';
import { splitPath } from '../services/storage';
import { toCustomerOrderView } from '../services/views';
import { apiError, checkIfMatch, conflictError, deliveryIncompleteError } from './respond';

type Env = { Bindings: Bindings; Variables: { user: UserRow } };

function bearerToken(c: Context): string | null {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

function requireLiffUser(deps: Deps) {
  return async (c: Context<Env>, next: Next) => {
    const verified = await deps.auth.verifyLiffUser(bearerToken(c), c.req.header('x-liff-dev-user') ?? null);
    if (!verified) return apiError(c, 'UNAUTHORIZED', 'LIFF auth required', 401);
    c.set('user', await deps.repo.upsertUserByLineId(verified.lineUserId));
    await next();
  };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Same shape /slip-upload-url issues: slips/<orderId>/<uuid>.<jpeg|png|webp>. */
export function isOwnSlipPath(path: string, orderId: string): boolean {
  return new RegExp(`^slips/${orderId.replace(/[^0-9a-f-]/gi, '')}/${UUID}\\.(jpeg|png|webp)$`, 'i').test(path);
}

async function getOwnOrder(c: Context<Env>, deps: Deps): Promise<OrderRow | Response> {
  const order = await deps.repo.getOrder(c.req.param('id')!);
  if (!order || order.user_id !== c.get('user').id) return apiError(c, 'NOT_FOUND', 'order not found', 404);
  return order;
}

async function buildCustomerView(deps: Deps, order: OrderRow): Promise<CustomerOrderView> {
  const [items, products, negotiations] = await Promise.all([
    deps.repo.getItems(order.id),
    deps.repo.listActiveProducts(),
    deps.repo.listNegotiations(order.id),
  ]);
  const address = order.address_id ? await deps.repo.getAddress(order.address_id) : null;
  return toCustomerOrderView({ order, items, products, negotiations, address, promptpayId: deps.cfg.PROMPTPAY_ID });
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export function createLiffRoutes(deps: Deps) {
  const app = new Hono<Env>();
  app.use('*', requireLiffUser(deps));

  app.get('/orders/:id', async (c) => {
    const order = await getOwnOrder(c, deps);
    if (order instanceof Response) return order;
    return c.json(await buildCustomerView(deps, order));
  });

  app.post('/orders/:id/accept', async (c) => {
    const order = await getOwnOrder(c, deps);
    if (order instanceof Response) return order;
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const r = await actions.customerAccept(deps, order);
    if (!r.ok) return r.reason === 'DELIVERY_INCOMPLETE' ? deliveryIncompleteError(c) : conflictError(c, r.reason, r.order);
    return c.json(await buildCustomerView(deps, r.order));
  });

  app.post('/orders/:id/counter', async (c) => {
    const order = await getOwnOrder(c, deps);
    if (order instanceof Response) return order;
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = CounterOfferRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r = await actions.customerCounter(deps, order, parsed.data.amountSatang, parsed.data.message ?? null);
    if (!r.ok) {
      if (r.reason === 'COUNTER_TOO_HIGH') return apiError(c, 'VALIDATION_FAILED', 'counter must be lower than the current offer', 400);
      return conflictError(c, r.reason, r.order);
    }
    return c.json(await buildCustomerView(deps, r.order));
  });

  // Delivery recipient (name + Thai phone). Submits a held order to the shop when it was the
  // only thing missing; otherwise just updates it. Saved to the profile for next time.
  app.post('/orders/:id/recipient', async (c) => {
    const order = await getOwnOrder(c, deps);
    if (order instanceof Response) return order;
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = RecipientContactRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.issues.map((i) => i.message).join('; '), 400);
    const r = await setRecipient(deps, order, c.get('user'), { name: parsed.data.recipientName, phone: parsed.data.recipientPhone });
    if (!r.ok) return conflictError(c, r.reason, r.order);
    return c.json(await buildCustomerView(deps, r.order));
  });

  app.post('/orders/:id/slip-upload-url', async (c) => {
    const order = await getOwnOrder(c, deps);
    if (order instanceof Response) return order;
    const parsed = SlipUploadUrlRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    if (!(PAYABLE as readonly string[]).includes(order.status)) return conflictError(c, 'INVALID_FROM_STATE', order);
    const key = `${order.id}/${crypto.randomUUID()}.${parsed.data.contentType.split('/')[1]}`;
    return c.json(await deps.storage.createSignedUploadUrl('slips', key));
  });

  app.post('/orders/:id/slip', async (c) => {
    const order = await getOwnOrder(c, deps);
    if (order instanceof Response) return order;
    const parsed = SlipSubmitRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    // Only a path this order's /slip-upload-url could have issued: never another order's slip,
    // another bucket, or a traversal. Checked before Storage is touched (service role).
    if (!isOwnSlipPath(parsed.data.path, order.id)) return apiError(c, 'VALIDATION_FAILED', 'path is not an upload for this order', 400);
    if (!(PAYABLE as readonly string[]).includes(order.status)) return conflictError(c, 'INVALID_FROM_STATE', order);
    // The customer's browser decoded the bank Mini-QR; re-check it here (cheap: no image decoding).
    const qr = parseSlipQr(parsed.data.qrPayload);
    if (!qr.ok) return apiError(c, 'NOT_A_SLIP', 'image has no valid Thai bank slip QR code', 422);
    const { bucket, key } = splitPath(parsed.data.path);
    const { bytes, contentType } = await deps.storage.download(bucket, key);
    const r = await actions.submitSlip(deps, order, parsed.data.path, bytes, contentType, { via: 'liff', sendingBank: qr.sendingBank });
    if (!r.ok) {
      if (r.reason === 'NOT_A_SLIP') return apiError(c, 'VALIDATION_FAILED', 'image is not a payment slip', 422);
      return conflictError(c, r.reason, r.order);
    }
    return c.json(await buildCustomerView(deps, r.order));
  });

  app.post('/orders/:id/heartbeat', async (c) => {
    const order = await getOwnOrder(c, deps);
    if (order instanceof Response) return order;
    await deps.repo.touchCustomerLastSeen(order.id, deps.now().toISOString());
    return c.body(null, 204);
  });

  return app;
}
