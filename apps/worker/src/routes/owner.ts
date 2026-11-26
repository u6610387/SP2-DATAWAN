/**
 * Owner dashboard REST API — docs/API_AND_AI_CONTRACTS.md §2.3 (scoped to what the dashboard
 * described in Part 2 actually calls; see the Part 2 plan for the explicit cut list).
 * Every handler delegates the actual mutation to services/orderActions.ts — the exact same
 * functions the LINE owner commands use — so "owner acts via dashboard" and "owner acts via
 * LINE" can never silently diverge.
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import {
  CancelOrderRequest,
  ConfirmPaymentRequest,
  DeliveredRequest,
  DispatchRequest,
  NegotiationRequest,
  PushSubscriptionRequest,
  RejectSlipRequest,
  SetPriceRequest,
  SlipQrRequest,
  ShippingRequest,
  StockAdjustRequest,
  type OrderRow,
  type OrderStatus,
  type OwnerOrderView,
} from '@datawan/shared';
import type { Deps } from '../deps';
import type { Bindings } from '../env';
import { getQuotaStatus } from '../line/quota';
import * as actions from '../services/orderActions';
import { suggestPrice } from '../services/pricing';
import { ownerCheckSlipQr } from '../services/slipQrCheck';
import { splitPath } from '../services/storage';
import { toOwnerOrderView } from '../services/views';
import { startOfBangkokDay } from '../util/time';
import { apiError, checkIfMatch, conflictError, deliveryIncompleteError } from './respond';

type Env = { Bindings: Bindings; Variables: { ownerId: string } };

function bearerToken(c: Context): string | null {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

function requireOwner(deps: Deps) {
  return async (c: Context<Env>, next: Next) => {
    const owner = await deps.auth.verifyOwner(bearerToken(c));
    if (!owner) return apiError(c, 'UNAUTHORIZED', 'owner auth required', 401);
    c.set('ownerId', owner.id);
    await next();
  };
}

async function buildOwnerView(deps: Deps, order: OrderRow): Promise<OwnerOrderView> {
  const [items, products, negotiations, user, payment] = await Promise.all([
    deps.repo.getItems(order.id),
    deps.repo.listActiveProducts(),
    deps.repo.listNegotiations(order.id),
    deps.repo.getUser(order.user_id),
    deps.repo.latestPayment(order.id),
  ]);
  if (!user) throw new Error(`order ${order.id} has no user`);
  const address = order.address_id ? await deps.repo.getAddress(order.address_id) : null;
  const slipImageUrl = payment?.slip_path ? await (({ bucket, key }) => deps.storage.getSignedUrl(bucket, key, 600))(splitPath(payment.slip_path)) : null;
  const suggestion = await suggestPrice(deps, order, items);
  const trackingEv = order.tracking_url
    ? (await deps.repo.listPushEvents(order.id)).find((e) => (e.payload as { why?: string } | null)?.why === 'TRACKING_LINK')
    : undefined;
  const trackingPush = trackingEv
    ? { sent: trackingEv.event === 'PUSH_SENT', reason: trackingEv.event === 'PUSH_SENT' ? null : ((trackingEv.payload as { reason?: string }).reason ?? null) }
    : null;
  return toOwnerOrderView({
    order,
    items,
    products,
    negotiations,
    address,
    user,
    promptpayId: deps.cfg.PROMPTPAY_ID,
    costSatang: suggestion.costSatang,
    suggestedPriceSatang: suggestion.suggestedSatang,
    b2bAnchorPriceSatang: suggestion.b2bAnchorSatang,
    latestPayment: payment,
    slipImageUrl,
    needsOwnerReview: order.needs_owner_review,
    pushCount: order.push_count,
    trackingPush,
  });
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export function createOwnerRoutes(deps: Deps) {
  const app = new Hono<Env>();
  app.use('*', requireOwner(deps));

  app.get('/summary/today', async (c) => {
    const sinceIso = startOfBangkokDay(deps.now()).toISOString();
    const [delivered, open] = await Promise.all([deps.repo.listDeliveredSince(sinceIso), deps.repo.listOpenOrders()]);
    let productRevenueSatang = 0;
    let shippingCollectedSatang = 0;
    let costSatang = 0;
    for (const o of delivered) {
      productRevenueSatang += o.product_price_satang ?? 0;
      shippingCollectedSatang += o.shipping_fee_satang ?? 0;
      const items = await deps.repo.getItems(o.id);
      costSatang += items.reduce((a, i) => a + (i.cost_satang ?? 0), 0);
    }
    const openByStatus = {} as Record<OrderStatus, number>;
    for (const o of open) openByStatus[o.status] = (openByStatus[o.status] ?? 0) + 1;
    return c.json({
      ordersDelivered: delivered.length,
      productRevenueSatang,
      shippingCollectedSatang,
      grossMarginSatang: productRevenueSatang - costSatang,
      openByStatus,
    });
  });

  app.get('/orders', async (c) => {
    const status = c.req.query('status') as OrderStatus | undefined;
    const orders = await deps.repo.listOpenOrders(status ? { statuses: [status] } : undefined);
    return c.json(await Promise.all(orders.map((o) => buildOwnerView(deps, o))));
  });

  app.get('/orders/:id', async (c) => {
    const order = await deps.repo.getOrder(c.req.param('id'));
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    return c.json(await buildOwnerView(deps, order));
  });

  app.post('/orders/:id/price', async (c) => {
    const order = await deps.repo.getOrder(c.req.param('id'));
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = SetPriceRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r =
      order.status === 'NEGOTIATING'
        ? await actions.ownerCounter(deps, order, parsed.data.amountSatang)
        : await actions.ownerSetPrice(deps, order, parsed.data.amountSatang, parsed.data.note ?? null);
    if (!r.ok) return conflictError(c, r.reason, r.order);
    return c.json(await buildOwnerView(deps, r.order));
  });

  app.post('/orders/:id/negotiation', async (c) => {
    const order = await deps.repo.getOrder(c.req.param('id'));
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = NegotiationRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const { action, amountSatang } = parsed.data;
    if (action === 'counter' && amountSatang === undefined) return apiError(c, 'VALIDATION_FAILED', 'amountSatang required for counter', 400);
    const r =
      action === 'accept' ? await actions.ownerAcceptCounter(deps, order)
      : action === 'hold' ? await actions.ownerHold(deps, order)
      : await actions.ownerCounter(deps, order, amountSatang!);
    if (!r.ok) {
      if (r.reason === 'NO_CANDIDATE') return apiError(c, 'VALIDATION_FAILED', 'no customer counter-offer to accept', 422);
      if (r.reason === 'DELIVERY_INCOMPLETE') return deliveryIncompleteError(c);
      return conflictError(c, r.reason, r.order);
    }
    return c.json(await buildOwnerView(deps, r.order));
  });

  app.post('/orders/:id/shipping', async (c) => {
    const order = await deps.repo.getOrder(c.req.param('id'));
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = ShippingRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r = await actions.ownerSetShipping(deps, order, parsed.data.feeSatang);
    if (!r.ok) return r.reason === 'DELIVERY_INCOMPLETE' ? deliveryIncompleteError(c) : conflictError(c, r.reason, r.order);
    return c.json(await buildOwnerView(deps, r.order));
  });

  app.post('/payments/:id/confirm', async (c) => {
    const payment = await deps.repo.getPayment(c.req.param('id'));
    if (!payment) return apiError(c, 'NOT_FOUND', 'payment not found', 404);
    const order = await deps.repo.getOrder(payment.order_id);
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = ConfirmPaymentRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r = await actions.ownerConfirmPayment(deps, order, c.get('ownerId'), parsed.data.overrideReason ?? null);
    if (!r.ok) {
      if (r.reason === 'NO_SLIP') return apiError(c, 'VALIDATION_FAILED', 'no slip to confirm', 422);
      if (r.reason === 'NEEDS_OVERRIDE') return apiError(c, 'VALIDATION_FAILED', `slip check is ${r.checkResult}; overrideReason required`, 422);
      return conflictError(c, r.reason, r.order);
    }
    return c.json(await buildOwnerView(deps, r.order));
  });

  // Owner's dashboard decoded the slip's Mini-QR; flag duplicate / tampered slips (never approves).
  app.post('/payments/:id/qr', async (c) => {
    const payment = await deps.repo.getPayment(c.req.param('id'));
    if (!payment) return apiError(c, 'NOT_FOUND', 'payment not found', 404);
    const order = await deps.repo.getOrder(payment.order_id);
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const parsed = SlipQrRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r = await ownerCheckSlipQr(deps, order, payment, c.get('ownerId'), parsed.data.payload);
    if (!r.ok) return apiError(c, 'ORDER_STATE_INVALID', 'payment already confirmed', 409);
    return c.json(await buildOwnerView(deps, order));
  });

  app.post('/payments/:id/reject', async (c) => {
    const payment = await deps.repo.getPayment(c.req.param('id'));
    if (!payment) return apiError(c, 'NOT_FOUND', 'payment not found', 404);
    const order = await deps.repo.getOrder(payment.order_id);
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = RejectSlipRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r = await actions.ownerRejectSlip(deps, order, parsed.data.reason);
    if (!r.ok) {
      if (r.reason === 'NO_SLIP') return apiError(c, 'VALIDATION_FAILED', 'no slip to reject', 422);
      return conflictError(c, r.reason, r.order);
    }
    return c.json(await buildOwnerView(deps, r.order));
  });

  app.post('/orders/:id/dispatch', async (c) => {
    const order = await deps.repo.getOrder(c.req.param('id'));
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = DispatchRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r = await actions.ownerDispatch(deps, order, parsed.data.trackingUrl);
    if (!r.ok) return conflictError(c, r.reason, r.order);
    return c.json(await buildOwnerView(deps, r.order));
  });

  app.post('/orders/:id/delivered', async (c) => {
    const order = await deps.repo.getOrder(c.req.param('id'));
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = DeliveredRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r = await actions.ownerDelivered(deps, order, c.get('ownerId'), parsed.data.actualQty);
    if (!r.ok) return conflictError(c, r.reason, r.order);
    return c.json(await buildOwnerView(deps, r.order));
  });

  app.post('/orders/:id/cancel', async (c) => {
    const order = await deps.repo.getOrder(c.req.param('id'));
    if (!order) return apiError(c, 'NOT_FOUND', 'order not found', 404);
    const conflict = checkIfMatch(c, order);
    if (conflict) return conflict;
    const parsed = CancelOrderRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const r = await actions.ownerCancel(deps, order, c.get('ownerId'), parsed.data.reason);
    if (!r.ok) return conflictError(c, r.reason, r.order);
    return c.json(await buildOwnerView(deps, r.order));
  });

  app.get('/quota', async (c) => c.json(await getQuotaStatus(deps)));

  app.post('/push-subscriptions', async (c) => {
    const parsed = PushSubscriptionRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    await deps.repo.upsertPushSubscription({
      owner_id: c.get('ownerId'),
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    });
    return c.body(null, 204);
  });

  app.get('/products', async (c) => {
    const products = await deps.repo.listActiveProducts();
    return c.json(products.map((p) => ({ id: p.id, nameTh: p.name_th, unit: p.unit, isActive: p.is_active })));
  });

  app.get('/stock', async (c) => {
    const rows = await deps.repo.listProductStock();
    return c.json(rows.map((r) => ({ productId: r.product_id, nameTh: r.name_th, unit: r.unit, onHand: r.on_hand })));
  });

  app.post('/stock', async (c) => {
    const parsed = StockAdjustRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.message, 400);
    const row = await deps.repo.insertStockLog({
      product_id: parsed.data.productId,
      reason: parsed.data.reason,
      qty_delta: parsed.data.qtyDelta,
      order_id: null,
      unit_cost_satang: parsed.data.unitCostSatang ?? null,
      note: parsed.data.note ?? null,
      created_by: c.get('ownerId'),
    });
    return c.json({ stockLogId: row.id });
  });

  return app;
}
