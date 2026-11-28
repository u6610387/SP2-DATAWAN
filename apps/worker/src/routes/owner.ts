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
  CategoryCreateRequest,
  ProductCreateRequest,
  ProductUpdateRequest,
  type CategoryRow,
  type ProductRow,
  ConfirmPaymentRequest,
  DeliveredRequest,
  DispatchRequest,
  NegotiationRequest,
  OwnerB2bDecisionRequest,
  OwnerB2bReasonRequest,
  type OwnerB2bDetailView,
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
import { createCategory, createProduct, updateProduct } from '../services/catalog';
import { suggestPrice } from '../services/pricing';
import { buildOwnerListViews, trackingPushFrom } from '../services/ownerList';
import { ownerCheckSlipQr } from '../services/slipQrCheck';
import { splitPath } from '../services/storage';
import { toOwnerB2bDetailView, toOwnerB2bSummaryView, toOwnerOrderView } from '../services/views';
import { acknowledgeB2b, approveB2b, rejectB2b, revokeB2b, type B2bResult } from '../services/b2b';
import { startOfBangkokDay } from '../util/time';
import { apiError, checkIfMatch, conflictError, deliveryIncompleteError } from './respond';

type Env = { Bindings: Bindings; Variables: { ownerId: string } };

function productView(p: ProductRow) {
  return { id: p.id, nameTh: p.name_th, unit: p.unit, isActive: p.is_active, aliases: p.aliases, prepTypes: p.prep_types, categoryId: p.category_id ?? null };
}
function categoryView(c: CategoryRow) {
  return { id: c.id, nameTh: c.name_th, sort: c.sort };
}

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
  const [items, products, negotiations, user, payment, b2bProfile] = await Promise.all([
    deps.repo.getItems(order.id),
    deps.repo.listActiveProducts(),
    deps.repo.listNegotiations(order.id),
    deps.repo.getUser(order.user_id),
    deps.repo.latestPayment(order.id),
    deps.repo.getBusinessProfile(order.user_id),
  ]);
  if (!user) throw new Error(`order ${order.id} has no user`);
  const address = order.address_id ? await deps.repo.getAddress(order.address_id) : null;
  const slipImageUrl = payment?.slip_path ? await (({ bucket, key }) => deps.storage.getSignedUrl(bucket, key, 600))(splitPath(payment.slip_path)) : null;
  const suggestion = await suggestPrice(deps, order, items);
  const trackingPush = order.tracking_url ? trackingPushFrom(order, await deps.repo.listPushEvents(order.id)) : null;
  return toOwnerOrderView({
    order,
    items,
    products,
    negotiations,
    address,
    user,
    b2bProfile,
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

async function buildB2bDetail(deps: Deps, userId: string): Promise<OwnerB2bDetailView | null> {
  const [profile, user, docRows] = await Promise.all([
    deps.repo.getBusinessProfile(userId),
    deps.repo.getUser(userId),
    deps.repo.listBusinessDocuments(userId),
  ]);
  if (!profile) return null;
  const docs: { id: string; url: string }[] = [];
  for (const doc of docRows) {
    try {
      const { bucket, key } = splitPath(doc.path);
      docs.push({ id: doc.id, url: await deps.storage.getSignedUrl(bucket, key, 300) });
    } catch {
      // A re-apply can leave a row whose object was purged: skip it, keep the review usable.
      console.warn('[b2b] doc url failed', doc.id);
    }
  }
  return toOwnerB2bDetailView(profile, user, docs);
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
    }
    // One query for every delivered order's items (was one per order: subrequest limit).
    const items = await deps.repo.getItemsForOrders(delivered.map((o) => o.id));
    costSatang = items.reduce((a, i) => a + (i.cost_satang ?? 0), 0);
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

  app.get('/customers', async (c) => {
    const filter = c.req.query('filter') ?? 'pending';
    if (filter !== 'pending' && filter !== 'b2b' && filter !== 'all') return apiError(c, 'VALIDATION_FAILED', 'filter must be pending, b2b or all', 400);
    const profiles = await deps.repo.listBusinessProfiles(filter);
    // One query for every profile's user (was one per profile: Workers Free 50-subrequest limit).
    const usersById = new Map((await deps.repo.getUsers(profiles.map((p) => p.user_id))).map((u) => [u.id, u]));
    return c.json(profiles.map((p) => toOwnerB2bSummaryView(p, usersById.get(p.user_id) ?? null)));
  });

  app.get('/customers/:userId', async (c) => {
    const view = await buildB2bDetail(deps, c.req.param('userId'));
    return view ? c.json(view) : apiError(c, 'NOT_FOUND', 'customer not found', 404);
  });

  const b2bDecision = async (c: Context<Env>, run: (userId: string) => Promise<B2bResult>) => {
    const userId = c.req.param('userId') ?? '';
    const r = await run(userId);
    if (!r.ok) {
      return r.reason === 'NOT_FOUND'
        ? apiError(c, 'NOT_FOUND', 'customer not found', 404)
        : apiError(c, r.reason, 'application is not in a state that allows this decision', 409);
    }
    const view = await buildB2bDetail(deps, userId);
    return view ? c.json(view) : apiError(c, 'NOT_FOUND', 'customer not found', 404);
  };

  // Every decision carries the profile updatedAt the owner's detail view showed (§3.1): a customer
  // edit since then is 409 INVALID_FROM_STATE and the dashboard refetches.
  app.post('/customers/:userId/approve', async (c) => {
    const body = OwnerB2bDecisionRequest.safeParse(await readJson(c));
    if (!body.success) return apiError(c, 'VALIDATION_FAILED', 'expectedUpdatedAt is required', 400);
    return b2bDecision(c, (id) => approveB2b(deps, id, c.get('ownerId'), body.data.expectedUpdatedAt));
  });
  app.post('/customers/:userId/acknowledge', async (c) => {
    const body = OwnerB2bDecisionRequest.safeParse(await readJson(c));
    if (!body.success) return apiError(c, 'VALIDATION_FAILED', 'expectedUpdatedAt is required', 400);
    return b2bDecision(c, (id) => acknowledgeB2b(deps, id, c.get('ownerId'), body.data.expectedUpdatedAt));
  });
  app.post('/customers/:userId/reject', async (c) => {
    const body = OwnerB2bReasonRequest.safeParse(await readJson(c));
    if (!body.success) return apiError(c, 'VALIDATION_FAILED', 'reason (1-200 characters) and expectedUpdatedAt are required', 400);
    return b2bDecision(c, (id) => rejectB2b(deps, id, c.get('ownerId'), body.data.reason, body.data.expectedUpdatedAt));
  });
  app.post('/customers/:userId/revoke', async (c) => {
    const body = OwnerB2bReasonRequest.safeParse(await readJson(c));
    if (!body.success) return apiError(c, 'VALIDATION_FAILED', 'reason (1-200 characters) and expectedUpdatedAt are required', 400);
    return b2bDecision(c, (id) => revokeB2b(deps, id, c.get('ownerId'), body.data.reason, body.data.expectedUpdatedAt));
  });

  app.get('/orders', async (c) => {
    const status = c.req.query('status') as OrderStatus | undefined;
    const orders = await deps.repo.listOpenOrders(status ? { statuses: [status] } : undefined);
    // Batch-built: a per-order view here ran past the 50-subrequest limit at 5 open orders.
    return c.json(await buildOwnerListViews(deps, orders));
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
    const r = await actions.ownerConfirmPayment(deps, order, c.get('ownerId'), parsed.data.overrideReason ?? null, parsed.data.slipChecklist ?? null);
    if (!r.ok) {
      if (r.reason === 'NO_SLIP') return apiError(c, 'VALIDATION_FAILED', 'no slip to confirm', 422);
      if (r.reason === 'NEEDS_CHECKLIST') return apiError(c, 'SLIP_CHECKLIST_REQUIRED', 'nothing read this slip: enter its amount, receiver and time (slipChecklist)', 422);
      if (r.reason === 'NEEDS_OVERRIDE') {
        const failed = r.checks.filter((x) => x.result !== 'PASS').map((x) => `${x.rule} ${x.result}`).join(', ');
        return apiError(c, 'VALIDATION_FAILED', `slip check is ${r.checkResult} (${failed}); overrideReason required`, 422);
      }
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
    return c.json(products.map(productView));
  });

  // สต็อก tab: categories + new products (owner only; the service role never reaches the browser).
  app.get('/categories', async (c) => c.json((await deps.repo.listActiveCategories()).map(categoryView)));

  app.post('/categories', async (c) => {
    const parsed = CategoryCreateRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.issues.map((i) => i.message).join('; '), 400);
    const r = await createCategory(deps, parsed.data.nameTh);
    if (!r.ok) return apiError(c, 'DUPLICATE', 'มีหมวดหมู่ชื่อนี้อยู่แล้ว', 409);
    return c.json(categoryView(r.category), 201);
  });

  app.post('/products', async (c) => {
    const parsed = ProductCreateRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.issues.map((i) => i.message).join('; '), 400);
    const r = await createProduct(deps, parsed.data);
    if (!r.ok) {
      if (r.reason === 'CATEGORY_NOT_FOUND') return apiError(c, 'NOT_FOUND', 'ไม่พบหมวดหมู่นี้', 404);
      if (r.reason === 'ALIAS_TAKEN') return apiError(c, 'DUPLICATE', `คำเรียก "${r.alias}" ใช้กับสินค้า ${r.productName} อยู่แล้ว`, 409);
      return apiError(c, 'DUPLICATE', 'มีสินค้าชื่อนี้อยู่แล้ว', 409);
    }
    return c.json({ ...productView(r.product), ...(r.merged ? { merged: true } : {}) }, r.merged ? 200 : 201);
  });

  // Edit / move an existing product from the สต็อก list.
  app.patch('/products/:id', async (c) => {
    const parsed = ProductUpdateRequest.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 'VALIDATION_FAILED', parsed.error.issues.map((i) => i.message).join('; '), 400);
    const r = await updateProduct(deps, c.req.param('id'), parsed.data);
    if (!r.ok) {
      if (r.reason === 'NOT_FOUND') return apiError(c, 'NOT_FOUND', 'ไม่พบสินค้านี้', 404);
      if (r.reason === 'CATEGORY_NOT_FOUND') return apiError(c, 'NOT_FOUND', 'ไม่พบหมวดหมู่นี้', 404);
      if (r.reason === 'ALIAS_TAKEN') return apiError(c, 'DUPLICATE', `คำเรียก "${r.alias}" ใช้กับสินค้า ${r.productName} อยู่แล้ว`, 409);
      return apiError(c, 'DUPLICATE', 'มีสินค้าชื่อนี้อยู่แล้ว', 409);
    }
    return c.json(productView(r.product));
  });

  app.get('/stock', async (c) => {
    const [rows, active] = await Promise.all([deps.repo.listProductStock(), deps.repo.listActiveProducts()]);
    const activeById = new Map(active.map((p) => [p.id, p]));
    return c.json(rows.map((r) => ({ productId: r.product_id, nameTh: r.name_th, unit: r.unit, onHand: r.on_hand, categoryId: r.category_id ?? null, categoryName: r.category_name ?? null, isActive: activeById.has(r.product_id), aliases: activeById.get(r.product_id)?.aliases ?? [] })));
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
