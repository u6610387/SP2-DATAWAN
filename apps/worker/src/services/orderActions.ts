/**
 * Mutation + push/notify logic for owner and customer order actions, shared between the LINE
 * handlers (apps/worker/src/handlers/*.ts) and the REST routes (apps/worker/src/routes/*.ts).
 * Returns structured results (never LineMessage[]) so each caller formats its own channel —
 * LINE Flex text or a JSON view model — from the exact same business logic and DB writes.
 *
 * Human-in-the-loop (CLAUDE.md §3.1): every owner-only action here requires an explicit
 * `ownerId` from the caller (the verified Supabase user for REST, LINE_OWNER_USER_ID's
 * configured auth id for the LINE grammar) — never invented here.
 */
import {
  bahtToSatang,
  formatTHB,
  type Margin,
  type OrderItemRow,
  type OrderRow,
  type PaymentRow,
  type SlipCheckResult,
} from '@datawan/shared';
import type { Deps } from '../deps';
import * as flex from '../line/flex';
import { sendPushGuarded, type GuardedPushResult } from '../line/quota';
import { applyEvent, type ApplyResult } from './orders';
import { allocateUnitPrices, costItems, marginFor } from './pricing';
import { checkSlip } from './slipCheck';
import { deliveryReady } from './recipient';
import { withNames } from './itemNames';
import { addMinutes } from '../util/time';

type ConflictReason = 'INVALID_FROM_STATE' | 'WRONG_ACTOR' | 'VERSION_CONFLICT';
type Conflict = { ok: false; reason: ConflictReason; order: OrderRow };
/** No location or recipient yet: the shipping-fee step can't be entered or completed. */
type DeliveryIncomplete = { ok: false; reason: 'DELIVERY_INCOMPLETE'; order: OrderRow };
const incomplete = (order: OrderRow): DeliveryIncomplete => ({ ok: false, reason: 'DELIVERY_INCOMPLETE', order });

async function nextRound(deps: Deps, orderId: string): Promise<number> {
  return (await deps.repo.listNegotiations(orderId)).length + 1;
}

function asConflict(res: ApplyResult): Conflict {
  // res.ok is false here; reason is one of ConflictReason by ApplyResult's definition.
  return res as Conflict;
}

// ---------------- owner actions ----------------

export type SetPriceResult =
  | { ok: true; order: OrderRow; items: OrderItemRow[]; margin: Margin; push: GuardedPushResult }
  | Conflict;

/** Quote or re-quote a price. Not valid while NEGOTIATING — callers redirect to ownerCounter there. */
export async function ownerSetPrice(deps: Deps, order: OrderRow, amountSatang: number, note: string | null): Promise<SetPriceResult> {
  const items = await deps.repo.getItems(order.id);
  const costs = await costItems(deps, items);
  await deps.repo.updateItemCosts(costs);
  const costed = items.map((it) => ({ ...it, cost_satang: costs.find((c) => c.id === it.id)?.cost_satang ?? null }));
  const margin = marginFor(amountSatang, costed);

  const res = await applyEvent(deps, order, 'OWNER_SET_PRICE', 'owner', {
    product_price_satang: amountSatang,
    price_note: note,
    quoted_at: deps.now().toISOString(),
  }, { amount_satang: amountSatang, margin_satang: margin.marginSatang });
  if (!res.ok) return asConflict(res);

  await deps.repo.insertNegotiation({
    order_id: order.id, round: await nextRound(deps, order.id), actor: 'owner', action: 'quote',
    amount_satang: amountSatang, margin_satang: margin.marginSatang, message: note,
  });
  const products = await deps.repo.listActiveProducts();
  const push = await sendPushGuarded(deps, {
    order: res.order, priority: 'P1', reason: 'PRICE_READY',
    messages: [flex.priceCard(res.order, withNames(costed, products), deps.cfg.LIFF_ID)],
  });
  return { ok: true, order: push.order, items: costed, margin, push };
}

export type OwnerCounterResult =
  | { ok: true; order: OrderRow; items: OrderItemRow[]; margin: Margin; push: GuardedPushResult }
  | Conflict;

/** Owner counters the customer's counter-offer (NEGOTIATING only). */
export async function ownerCounter(deps: Deps, order: OrderRow, amountSatang: number): Promise<OwnerCounterResult> {
  const items = await deps.repo.getItems(order.id);
  const margin = marginFor(amountSatang, items);
  const res = await applyEvent(deps, order, 'OWNER_COUNTER', 'owner', { product_price_satang: amountSatang, quoted_at: deps.now().toISOString() }, { amount_satang: amountSatang });
  if (!res.ok) return asConflict(res);

  await deps.repo.insertNegotiation({
    order_id: order.id, round: await nextRound(deps, order.id), actor: 'owner', action: 'counter',
    amount_satang: amountSatang, margin_satang: margin.marginSatang, message: null,
  });
  const products = await deps.repo.listActiveProducts();
  const push = await sendPushGuarded(deps, {
    order: res.order, priority: 'P2', reason: 'OWNER_COUNTER',
    messages: [flex.priceCard(res.order, withNames(items, products), deps.cfg.LIFF_ID, `ร้านเสนอราคาใหม่ ${formatTHB(amountSatang)}`)],
  });
  return { ok: true, order: push.order, items, margin, push };
}

export type OwnerAcceptCounterResult =
  | { ok: true; order: OrderRow; items: OrderItemRow[]; margin: Margin; amountSatang: number }
  | { ok: false; reason: 'NO_CANDIDATE'; order: OrderRow }
  | DeliveryIncomplete
  | Conflict;

/** Owner accepts the customer's latest counter-offer. */
export async function ownerAcceptCounter(deps: Deps, order: OrderRow): Promise<OwnerAcceptCounterResult> {
  if (!deliveryReady(order)) return incomplete(order);
  const rounds = await deps.repo.listNegotiations(order.id);
  const counter = [...rounds].reverse().find((n) => n.actor === 'customer' && n.action === 'counter');
  if (!counter?.amount_satang) return { ok: false, reason: 'NO_CANDIDATE', order };

  const items = await deps.repo.getItems(order.id);
  const margin = marginFor(counter.amount_satang, items);
  const res = await applyEvent(deps, order, 'OWNER_ACCEPT', 'owner', { product_price_satang: counter.amount_satang }, { amount_satang: counter.amount_satang });
  if (!res.ok) return asConflict(res);

  await deps.repo.insertNegotiation({
    order_id: order.id, round: rounds.length + 1, actor: 'owner', action: 'accept',
    amount_satang: counter.amount_satang, margin_satang: margin.marginSatang, message: null,
  });
  return { ok: true, order: res.order, items, margin, amountSatang: counter.amount_satang };
}

export type OwnerHoldResult = { ok: true; order: OrderRow; push: GuardedPushResult } | Conflict;

/** Owner stands by the current price during a negotiation. */
export async function ownerHold(deps: Deps, order: OrderRow): Promise<OwnerHoldResult> {
  const res = await applyEvent(deps, order, 'OWNER_HOLD', 'owner');
  if (!res.ok) return asConflict(res);

  await deps.repo.insertNegotiation({
    order_id: order.id, round: await nextRound(deps, order.id), actor: 'owner', action: 'hold',
    amount_satang: order.product_price_satang, margin_satang: null, message: null,
  });
  const [items, products] = await Promise.all([deps.repo.getItems(order.id), deps.repo.listActiveProducts()]);
  const push = await sendPushGuarded(deps, {
    order: res.order, priority: 'P2', reason: 'OWNER_HOLD',
    messages: [flex.priceCard(res.order, withNames(items, products), deps.cfg.LIFF_ID, 'ร้านขอยืนราคาเดิมนะคะ')],
  });
  return { ok: true, order: push.order, push };
}

export type OwnerSetShippingResult =
  | { ok: true; order: OrderRow; lalamoveCard: string; push: GuardedPushResult }
  | DeliveryIncomplete
  | Conflict;

/** Set the shipping fee: locks the total, opens the PromptPay QR + payment timer. */
export async function ownerSetShipping(deps: Deps, order: OrderRow, feeSatang: number): Promise<OwnerSetShippingResult> {
  if (!deliveryReady(order)) return incomplete(order);
  const res = await applyEvent(deps, order, 'OWNER_SET_SHIPPING', 'owner', {
    shipping_fee_satang: feeSatang,
    payment_expires_at: addMinutes(deps.now(), deps.cfg.PAYMENT_EXPIRY_MINUTES).toISOString(),
  }, { fee_satang: feeSatang });
  if (!res.ok) return asConflict(res);

  const [address, user] = await Promise.all([
    res.order.address_id ? deps.repo.getAddress(res.order.address_id) : Promise.resolve(null),
    deps.repo.getUser(res.order.user_id),
  ]);
  const push = await sendPushGuarded(deps, { order: res.order, priority: 'P1', reason: 'TOTAL_READY', messages: [flex.totalCard(res.order, deps.cfg.LIFF_ID, { id: deps.cfg.PROMPTPAY_ID, name: deps.cfg.PROMPTPAY_RECEIVER_NAME })] });
  return { ok: true, order: push.order, lalamoveCard: flex.lalamoveCardText(push.order, address, user), push };
}

export type OwnerConfirmPaymentResult =
  | { ok: true; order: OrderRow; payment: PaymentRow }
  | { ok: false; reason: 'NO_SLIP'; order: OrderRow }
  | { ok: false; reason: 'NEEDS_OVERRIDE'; order: OrderRow; checkResult: SlipCheckResult }
  | Conflict;

/** Owner confirms the latest payment slip. PASS needs no reason; WARN/FAIL require `overrideReason`. */
export async function ownerConfirmPayment(deps: Deps, order: OrderRow, ownerId: string, overrideReason: string | null): Promise<OwnerConfirmPaymentResult> {
  const payment = await deps.repo.latestPayment(order.id);
  if (!payment) return { ok: false, reason: 'NO_SLIP', order };
  if (payment.check_result !== 'PASS' && !overrideReason) return { ok: false, reason: 'NEEDS_OVERRIDE', order, checkResult: payment.check_result };

  const now = deps.now().toISOString();
  const res = await applyEvent(deps, order, 'OWNER_CONFIRM_PAYMENT', 'owner', { paid_at: now, paid_confirmed_by: ownerId }, {
    payment_id: payment.id, check_result: payment.check_result, override_reason: overrideReason,
  });
  if (!res.ok) return asConflict(res);

  const updated = await deps.repo.updatePayment(payment.id, { confirmed_by: ownerId, confirmed_at: now, override_reason: overrideReason });
  return { ok: true, order: res.order, payment: updated };
}

export type OwnerRejectSlipResult =
  | { ok: true; order: OrderRow; payment: PaymentRow }
  | { ok: false; reason: 'NO_SLIP'; order: OrderRow }
  | Conflict;

/** Owner rejects the latest slip (e.g. wrong amount owner wants the customer to re-send). */
export async function ownerRejectSlip(deps: Deps, order: OrderRow, reason: string): Promise<OwnerRejectSlipResult> {
  const payment = await deps.repo.latestPayment(order.id);
  if (!payment) return { ok: false, reason: 'NO_SLIP', order };
  const res = await applyEvent(deps, order, 'OWNER_REJECT_SLIP', 'owner', {}, { payment_id: payment.id, reason });
  if (!res.ok) return asConflict(res);
  return { ok: true, order: res.order, payment };
}

export type OwnerDispatchResult = { ok: true; order: OrderRow; push: GuardedPushResult } | Conflict;

export async function ownerDispatch(deps: Deps, order: OrderRow, trackingUrl: string): Promise<OwnerDispatchResult> {
  const res = await applyEvent(deps, order, 'OWNER_DISPATCH', 'owner', { tracking_url: trackingUrl, dispatched_at: deps.now().toISOString() }, { tracking_url: trackingUrl });
  if (!res.ok) return asConflict(res);
  const push = await sendPushGuarded(deps, { order: res.order, priority: 'P1', reason: 'TRACKING_LINK', messages: [flex.dispatchedMessage(res.order)] });
  return { ok: true, order: push.order, push };
}

export type OwnerCancelResult = { ok: true; order: OrderRow } | Conflict;

/**
 * Owner cancels an order that is not yet paid (OWNER_CANCEL edges in orderMachine). Works for
 * any pre-payment order, including one that is no longer the customer's active order and
 * empty NEEDS_REVIEW orders. No LINE push: the customer sees the status in LIFF / on next message.
 */
export async function ownerCancel(deps: Deps, order: OrderRow, ownerId: string, reason: string): Promise<OwnerCancelResult> {
  const res = await applyEvent(deps, order, 'OWNER_CANCEL', 'owner', {
    cancelled_at: deps.now().toISOString(),
    cancel_reason: `owner: ${reason}`,
  }, { reason, owner_id: ownerId });
  if (!res.ok) return asConflict(res);
  const user = await deps.repo.getUser(order.user_id);
  if (user?.active_order_id === order.id) await deps.repo.setActiveOrder(user.id, null);
  return { ok: true, order: res.order };
}

export type OwnerDeliveredResult ={ ok: true; order: OrderRow; items: OrderItemRow[] } | Conflict;

/** Marks DELIVERED: writes stock `sale` rows + sell price_history in the same step (PROJECT_SPEC §9). */
export async function ownerDelivered(
  deps: Deps,
  order: OrderRow,
  ownerId: string,
  actualQtyOverrides?: { itemId: string; actualQty: number }[],
): Promise<OwnerDeliveredResult> {
  if (actualQtyOverrides?.length) {
    await deps.repo.updateItemActualQty(actualQtyOverrides.map((o) => ({ id: o.itemId, actual_qty: o.actualQty })));
  }
  const res = await applyEvent(deps, order, 'OWNER_DELIVERED', 'owner', { delivered_at: deps.now().toISOString() });
  if (!res.ok) return asConflict(res);

  const items = await deps.repo.getItems(order.id);
  await deps.repo.insertStockLogs(
    items
      .filter((i) => i.product_id)
      .map((i) => ({ product_id: i.product_id!, reason: 'sale' as const, qty_delta: -(i.actual_qty ?? i.qty), order_id: order.id, created_by: ownerId })),
  );
  if (res.order.product_price_satang !== null) {
    await deps.repo.insertPriceHistory(
      allocateUnitPrices(res.order.product_price_satang, items)
        .filter((a) => a.item.product_id)
        .map((a) => ({ product_id: a.item.product_id!, kind: 'sell' as const, unit_price_satang: a.unitSatang, source: 'order' as const, user_id: order.user_id, order_id: order.id })),
    );
  }
  const user = await deps.repo.getUser(order.user_id);
  if (user?.active_order_id === order.id) await deps.repo.setActiveOrder(user.id, null);
  return { ok: true, order: res.order, items };
}

// ---------------- customer actions (LINE + LIFF) ----------------

export type CustomerAcceptResult = { ok: true; order: OrderRow } | DeliveryIncomplete | Conflict;

export async function customerAccept(deps: Deps, order: OrderRow): Promise<CustomerAcceptResult> {
  if (!deliveryReady(order)) return incomplete(order);
  const res = await applyEvent(deps, order, 'CUSTOMER_ACCEPT', 'customer');
  if (!res.ok) return asConflict(res);
  const rounds = await deps.repo.listNegotiations(order.id);
  await deps.repo.insertNegotiation({
    order_id: order.id, round: rounds.length + 1, actor: 'customer', action: 'accept',
    amount_satang: order.product_price_satang, margin_satang: null, message: null,
  });
  await deps.notifier.notify({ kind: 'ACCEPTED', orderId: order.id, code: order.code });
  return { ok: true, order: res.order };
}

export type CustomerCounterResult =
  | { ok: true; order: OrderRow; margin: Margin }
  | { ok: false; reason: 'COUNTER_TOO_HIGH'; order: OrderRow }
  | Conflict;

export async function customerCounter(deps: Deps, order: OrderRow, amountSatang: number, message: string | null = null): Promise<CustomerCounterResult> {
  if (order.product_price_satang !== null && amountSatang >= order.product_price_satang) {
    return { ok: false, reason: 'COUNTER_TOO_HIGH', order };
  }
  const items = await deps.repo.getItems(order.id);
  const margin = marginFor(amountSatang, items);
  const res = await applyEvent(deps, order, 'CUSTOMER_COUNTER', 'customer', {}, { amount_satang: amountSatang });
  if (!res.ok) return asConflict(res);

  const rounds = await deps.repo.listNegotiations(order.id);
  await deps.repo.insertNegotiation({
    order_id: order.id, round: rounds.length + 1, actor: 'customer', action: 'counter',
    amount_satang: amountSatang, margin_satang: margin.marginSatang, message,
  });
  await deps.notifier.notify({ kind: 'COUNTER_OFFER', orderId: order.id, code: order.code, amountSatang, marginColor: margin.color });
  return { ok: true, order: res.order, margin };
}

export type SubmitSlipResult =
  | { ok: true; order: OrderRow; payment: PaymentRow }
  | { ok: false; reason: 'NOT_A_SLIP'; order: OrderRow }
  | Conflict;

/** Runs the slip pipeline (AI read → code cross-check → payment row → SLIP_UPLOADED) given bytes already in Storage. */
export async function submitSlip(deps: Deps, order: OrderRow, path: string, bytes: Uint8Array, mime: 'image/jpeg' | 'image/png' | 'image/webp'): Promise<SubmitSlipResult> {
  const r = await deps.ai.parsePaymentSlip({
    image: { bytes, mimeType: mime },
    mockOnly: { expectedTotalSatang: order.total_satang, receiverName: deps.cfg.PROMPTPAY_RECEIVER_NAME },
  });
  const slip = r.ok ? r.data : null;
  if (slip && !slip.is_slip) return { ok: false, reason: 'NOT_A_SLIP', order };

  const refUsed = slip?.reference_no ? await deps.repo.referenceExists(slip.reference_no) : false;
  const manual = deps.cfg.GEMINI_SLIP_MODE === 'manual';
  const outcome = checkSlip(slip, {
    order, receiverName: deps.cfg.PROMPTPAY_RECEIVER_NAME, promptpayId: deps.cfg.PROMPTPAY_ID,
    referenceAlreadyUsed: refUsed, now: deps.now(), manualReview: manual,
  });
  const payment = await deps.repo.insertPayment({
    order_id: order.id,
    slip_path: path,
    ai_extract: slip,
    amount_satang: slip?.amount != null ? bahtToSatang(slip.amount) : null,
    slip_time: slip?.date_time ?? null,
    receiver_text: slip?.receiver_name_or_id ?? null,
    reference_no: refUsed ? null : slip?.reference_no ?? null,
    check_result: outcome.result,
    check_details: { checks: outcome.checks, ...(refUsed ? { duplicate_reference: slip?.reference_no } : {}), ai: r.ok ? 'ok' : manual ? 'MANUAL' : r.error },
  });
  const res = await applyEvent(deps, order, 'SLIP_UPLOADED', 'customer', {}, { payment_id: payment.id, result: outcome.result });
  if (!res.ok) return asConflict(res);

  await deps.notifier.notify({ kind: 'SLIP_UPLOADED', orderId: order.id, code: order.code, result: outcome.result });
  return { ok: true, order: res.order, payment };
}
