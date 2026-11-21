/**
 * Owner LINE commands. Every decision here is an owner action (actor='owner'), recorded in
 * order_events. Replies to the owner are free (replyToken); customer updates go through
 * sendPushGuarded() or wait for LIFF / pull-on-message.
 */
import type { webhook } from '@line/bot-sdk';
import { formatTHB, th, type OrderRow, type OrderStatus } from '@datawan/shared';
import type { Deps } from '../deps';
import type { LineMessage } from '../line/api';
import * as flex from '../line/flex';
import { parseOwnerCommand, type OwnerCommand } from '../line/ownerCommands';
import { sendPushGuarded, type GuardedPushResult } from '../line/quota';
import { applyEvent, logEvent } from '../services/orders';
import { allocateUnitPrices, costItems, marginFor } from '../services/pricing';
import { addMinutes } from '../util/time';
import { reply, withNames } from './customer';

type CodedCommand = Exclude<OwnerCommand, { kind: 'list' | 'help' | 'unknown' }>;

/** Which statuses each command can act on (used to auto-pick the order when no code is given). */
const TARGETS: Record<CodedCommand['kind'], OrderStatus[]> = {
  price: ['AWAITING_PRICE', 'PRICE_QUOTED', 'NEGOTIATING'],
  ok: ['NEGOTIATING'],
  hold: ['NEGOTIATING'],
  ship: ['AWAITING_SHIPPING_FEE', 'PAYMENT_EXPIRED', 'AWAITING_PAYMENT'],
  paid: ['PAYMENT_REVIEW'],
  track: ['PAID'],
  done: ['DELIVERING'],
  note: ['AWAITING_PRICE', 'PRICE_QUOTED', 'NEGOTIATING', 'AWAITING_SHIPPING_FEE'],
};

function pushNote(r: GuardedPushResult): string {
  return r.sent ? th.owner.pushSent : th.owner.pushDeferred;
}

async function resolveOrder(deps: Deps, cmd: CodedCommand): Promise<{ order: OrderRow } | { message: string }> {
  const targets = TARGETS[cmd.kind];
  if (cmd.code) {
    const order = await deps.repo.getOpenOrderByCode(cmd.code);
    if (!order) return { message: th.owner.notFound(cmd.code) };
    if (!targets.includes(order.status)) return { message: th.owner.wrongState(order.code, th.status[order.status]) };
    return { order };
  }
  // Without a code, prefer the "primary" status (e.g. price → AWAITING_PRICE) before others.
  const candidates = await deps.repo.listOpenOrders({ statuses: targets });
  const primary = candidates.filter((o) => o.status === targets[0]);
  const pool = primary.length ? primary : candidates;
  if (pool.length === 1) return { order: pool[0]! };
  if (pool.length === 0) return { message: th.owner.noCandidate };
  return { message: th.owner.ambiguous(pool.map((o) => o.code)) };
}

async function namedItems(deps: Deps, orderId: string) {
  const [items, products] = await Promise.all([deps.repo.getItems(orderId), deps.repo.listActiveProducts()]);
  return withNames(items, products);
}

async function nextRound(deps: Deps, orderId: string): Promise<number> {
  return (await deps.repo.listNegotiations(orderId)).length + 1;
}

const conflictOr = (res: { ok: false; reason: string; order: OrderRow }) =>
  res.reason === 'VERSION_CONFLICT' ? th.owner.conflict : th.owner.wrongState(res.order.code, th.status[res.order.status]);

// ---------------- commands ----------------

async function setPrice(deps: Deps, order: OrderRow, amountSatang: number, note: string | null): Promise<LineMessage[]> {
  if (order.status === 'NEGOTIATING') return ownerCounter(deps, order, amountSatang);

  // Snapshot costs at quote time → margin.
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
  if (!res.ok) return [flex.ownerText(conflictOr(res))];
  await deps.repo.insertNegotiation({
    order_id: order.id, round: await nextRound(deps, order.id), actor: 'owner', action: 'quote',
    amount_satang: amountSatang, margin_satang: margin.marginSatang, message: note,
  });
  const push = await sendPushGuarded(deps, {
    order: res.order,
    priority: 'P1',
    reason: 'PRICE_READY',
    messages: [flex.priceCard(res.order, withNames(costed, await deps.repo.listActiveProducts()), deps.cfg.LIFF_ID)],
  });
  return [flex.priceEcho(res.order, 'ราคา', amountSatang, costed, margin, pushNote(push))];
}

async function ownerCounter(deps: Deps, order: OrderRow, amountSatang: number): Promise<LineMessage[]> {
  const items = await deps.repo.getItems(order.id);
  const margin = marginFor(amountSatang, items);
  const res = await applyEvent(deps, order, 'OWNER_COUNTER', 'owner', { product_price_satang: amountSatang, quoted_at: deps.now().toISOString() }, { amount_satang: amountSatang });
  if (!res.ok) return [flex.ownerText(conflictOr(res))];
  await deps.repo.insertNegotiation({
    order_id: order.id, round: await nextRound(deps, order.id), actor: 'owner', action: 'counter',
    amount_satang: amountSatang, margin_satang: margin.marginSatang, message: null,
  });
  const push = await sendPushGuarded(deps, {
    order: res.order,
    priority: 'P2',
    reason: 'OWNER_COUNTER',
    messages: [flex.priceCard(res.order, await namedItems(deps, order.id), deps.cfg.LIFF_ID, `ร้านเสนอราคาใหม่ ${formatTHB(amountSatang)}`)],
  });
  return [flex.priceEcho(res.order, 'เสนอใหม่', amountSatang, items, margin, pushNote(push))];
}

async function acceptCounter(deps: Deps, order: OrderRow): Promise<LineMessage[]> {
  const rounds = await deps.repo.listNegotiations(order.id);
  const counter = [...rounds].reverse().find((n) => n.actor === 'customer' && n.action === 'counter');
  if (!counter?.amount_satang) return [flex.ownerText(th.owner.noCandidate)];
  const items = await deps.repo.getItems(order.id);
  const margin = marginFor(counter.amount_satang, items);
  const res = await applyEvent(deps, order, 'OWNER_ACCEPT', 'owner', { product_price_satang: counter.amount_satang }, { amount_satang: counter.amount_satang });
  if (!res.ok) return [flex.ownerText(conflictOr(res))];
  await deps.repo.insertNegotiation({
    order_id: order.id, round: rounds.length + 1, actor: 'owner', action: 'accept',
    amount_satang: counter.amount_satang, margin_satang: margin.marginSatang, message: null,
  });
  return [flex.priceEcho(res.order, 'รับราคา', counter.amount_satang, items, margin, `พิมพ์ "${order.code} ship <ค่าส่ง>" ต่อได้เลย`)];
}

async function holdPrice(deps: Deps, order: OrderRow): Promise<LineMessage[]> {
  const res = await applyEvent(deps, order, 'OWNER_HOLD', 'owner');
  if (!res.ok) return [flex.ownerText(conflictOr(res))];
  await deps.repo.insertNegotiation({
    order_id: order.id, round: await nextRound(deps, order.id), actor: 'owner', action: 'hold',
    amount_satang: order.product_price_satang, margin_satang: null, message: null,
  });
  const push = await sendPushGuarded(deps, {
    order: res.order,
    priority: 'P2',
    reason: 'OWNER_HOLD',
    messages: [flex.priceCard(res.order, await namedItems(deps, order.id), deps.cfg.LIFF_ID, 'ร้านขอยืนราคาเดิมนะคะ')],
  });
  return [flex.ownerText(`✅ ${order.code} ยืนราคา ${formatTHB(order.product_price_satang ?? 0)}\n${pushNote(push)}`)];
}

async function setShipping(deps: Deps, order: OrderRow, feeSatang: number): Promise<LineMessage[]> {
  const res = await applyEvent(deps, order, 'OWNER_SET_SHIPPING', 'owner', {
    shipping_fee_satang: feeSatang,
    payment_expires_at: addMinutes(deps.now(), deps.cfg.PAYMENT_EXPIRY_MINUTES).toISOString(),
  }, { fee_satang: feeSatang });
  if (!res.ok) return [flex.ownerText(conflictOr(res))];
  const [address, user] = await Promise.all([
    res.order.address_id ? deps.repo.getAddress(res.order.address_id) : Promise.resolve(null),
    deps.repo.getUser(res.order.user_id),
  ]);
  // Total + QR ready is P1: without it the customer cannot pay (shares the per-order cap with PRICE_READY).
  const push = await sendPushGuarded(deps, { order: res.order, priority: 'P1', reason: 'TOTAL_READY', messages: [flex.totalCard(res.order, deps.cfg.LIFF_ID)] });
  return flex.shippingEcho(push.order, flex.lalamoveCardText(push.order, address, user), pushNote(push));
}

async function confirmPayment(deps: Deps, order: OrderRow, overrideReason: string | null): Promise<LineMessage[]> {
  const payment = await deps.repo.latestPayment(order.id);
  if (!payment) return [flex.ownerText(th.owner.noSlip(order.code))];
  if (payment.check_result !== 'PASS' && !overrideReason) return [flex.ownerText(th.owner.paidNeedsPass(order.code, payment.check_result))];
  const now = deps.now().toISOString();
  const res = await applyEvent(deps, order, 'OWNER_CONFIRM_PAYMENT', 'owner', {
    paid_at: now,
    paid_confirmed_by: deps.cfg.OWNER_AUTH_USER_ID,
  }, { payment_id: payment.id, check_result: payment.check_result, override_reason: overrideReason });
  if (!res.ok) return [flex.ownerText(conflictOr(res))];
  await deps.repo.updatePayment(payment.id, { confirmed_by: deps.cfg.OWNER_AUTH_USER_ID, confirmed_at: now, override_reason: overrideReason });
  return [flex.ownerText(`✅ ${order.code} ยืนยันรับเงิน ${formatTHB(order.total_satang ?? 0)}${overrideReason ? ` (เหตุผล: ${overrideReason})` : ''}\nจองรถแล้วพิมพ์ "${order.code} track <ลิงก์>"`)];
}

async function dispatch(deps: Deps, order: OrderRow, url: string): Promise<LineMessage[]> {
  const res = await applyEvent(deps, order, 'OWNER_DISPATCH', 'owner', { tracking_url: url, dispatched_at: deps.now().toISOString() }, { tracking_url: url });
  if (!res.ok) return [flex.ownerText(conflictOr(res))];
  const push = await sendPushGuarded(deps, { order: res.order, priority: 'P1', reason: 'TRACKING_LINK', messages: [flex.dispatchedMessage(res.order)] });
  return [flex.ownerText(`🚚 ${order.code} กำลังจัดส่ง\n${pushNote(push)}`)];
}

async function delivered(deps: Deps, order: OrderRow): Promise<LineMessage[]> {
  const res = await applyEvent(deps, order, 'OWNER_DELIVERED', 'owner', { delivered_at: deps.now().toISOString() });
  if (!res.ok) return [flex.ownerText(conflictOr(res))];
  const items = await deps.repo.getItems(order.id);
  // Stock out (owner action: the Delivered tap) — PROJECT_SPEC step 9.
  await deps.repo.insertStockLogs(
    items
      .filter((i) => i.product_id)
      .map((i) => ({ product_id: i.product_id!, reason: 'sale' as const, qty_delta: -(i.actual_qty ?? i.qty), order_id: order.id, created_by: deps.cfg.OWNER_AUTH_USER_ID })),
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
  return [flex.ownerText(`✅ ${order.code} ส่งถึงแล้ว | ยอดขาย ${formatTHB(res.order.total_satang ?? 0)} | ตัดสต็อก ${items.length} รายการ`)];
}

async function draftNote(deps: Deps, order: OrderRow, note: string): Promise<LineMessage[]> {
  const [items, products, user] = await Promise.all([deps.repo.getItems(order.id), deps.repo.listActiveProducts(), deps.repo.getUser(order.user_id)]);
  const named = withNames(items, products);
  const r = await deps.ai.polishOwnerNote({
    note,
    orderItems: named.map((i) => ({ id: i.id, name: i.name ?? i.raw_text, qty: i.qty, unit: i.unit as 'kg' })),
    products,
    knownNames: [user?.full_name, user?.display_name, user?.business_name].filter((x): x is string => !!x),
    politeness: deps.cfg.OWNER_POLITENESS,
  });
  if (!r.ok) return [flex.ownerText(th.owner.aiUnavailable)];
  // The draft is stored, not sent: the owner must tap "ส่ง" (human-in-the-loop).
  const ev = await logEvent(deps, order, 'ai', 'NOTE_DRAFT', { note: r.data.note, warnings: r.data.warnings });
  return [flex.noteDraftMessage(order, r.data.note, ev.id)];
}

async function listOpen(deps: Deps): Promise<LineMessage[]> {
  const open = await deps.repo.listOpenOrders();
  const withCounts = await Promise.all(open.map(async (o) => ({ ...o, itemCount: (await deps.repo.getItems(o.id)).length })));
  return [flex.openOrdersText(withCounts)];
}

export async function runOwnerCommand(deps: Deps, text: string): Promise<LineMessage[]> {
  const cmd = parseOwnerCommand(text);
  if (cmd.kind === 'list') return listOpen(deps);
  if (cmd.kind === 'help') return [flex.ownerText(th.owner.help)];
  if (cmd.kind === 'unknown') return [flex.ownerText(`${th.owner.unknown}\n${th.owner.help}`)];

  const target = await resolveOrder(deps, cmd);
  if ('message' in target) return [flex.ownerText(target.message)];
  const order = target.order;
  switch (cmd.kind) {
    case 'price': return setPrice(deps, order, cmd.amountSatang, cmd.note);
    case 'ok': return acceptCounter(deps, order);
    case 'hold': return holdPrice(deps, order);
    case 'ship': return setShipping(deps, order, cmd.feeSatang);
    case 'paid': return confirmPayment(deps, order, cmd.overrideReason);
    case 'track': return dispatch(deps, order, cmd.url);
    case 'done': return delivered(deps, order);
    case 'note': return draftNote(deps, order, cmd.text);
  }
}

async function sendNote(deps: Deps, orderId: string, eventId: string): Promise<LineMessage[]> {
  const [order, ev] = await Promise.all([deps.repo.getOrder(orderId), deps.repo.getEvent(eventId)]);
  const draft = (ev?.payload as { note?: { message_th: string } } | null)?.note;
  if (!order || !ev || ev.event !== 'NOTE_DRAFT' || !draft) return [flex.ownerText(th.owner.noCandidate)];
  await logEvent(deps, order, 'owner', 'NOTE_APPROVED', { draft_event_id: eventId, message_th: draft.message_th });
  const push = await sendPushGuarded(deps, { order, priority: 'P2', reason: 'OWNER_NOTE', messages: [flex.textMsg(draft.message_th)] });
  return [flex.ownerText(push.sent ? th.owner.noteSent : th.owner.noteDeferred)];
}

export async function handleOwnerEvent(deps: Deps, ev: webhook.Event): Promise<void> {
  const replyToken = 'replyToken' in ev ? (ev.replyToken as string | undefined) : undefined;
  if (ev.type === 'message' && ev.message.type === 'text') {
    return reply(deps, replyToken, await runOwnerCommand(deps, ev.message.text));
  }
  if (ev.type === 'postback') {
    const p = new URLSearchParams(ev.postback.data);
    if (p.get('a') === 'note_send' && p.get('o') && p.get('e')) return reply(deps, replyToken, await sendNote(deps, p.get('o')!, p.get('e')!));
  }
  if (ev.type === 'message') return reply(deps, replyToken, [flex.ownerText(th.owner.help)]);
}
