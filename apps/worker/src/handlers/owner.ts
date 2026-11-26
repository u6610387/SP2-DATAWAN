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
import { logEvent } from '../services/orders';
import * as actions from '../services/orderActions';
import { withNames } from '../services/itemNames';
import { reply } from './customer';

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

const conflictOr = (res: { ok: false; reason: string; order: OrderRow }) =>
  res.reason === 'VERSION_CONFLICT' ? th.owner.conflict : th.owner.wrongState(res.order.code, th.status[res.order.status]);

// ---------------- commands (business logic lives in services/orderActions.ts) ----------------

async function setPrice(deps: Deps, order: OrderRow, amountSatang: number, note: string | null): Promise<LineMessage[]> {
  if (order.status === 'NEGOTIATING') {
    const r = await actions.ownerCounter(deps, order, amountSatang);
    if (!r.ok) return [flex.ownerText(conflictOr(r))];
    return [flex.priceEcho(r.order, 'เสนอใหม่', amountSatang, r.items, r.margin, pushNote(r.push))];
  }
  const r = await actions.ownerSetPrice(deps, order, amountSatang, note);
  if (!r.ok) return [flex.ownerText(conflictOr(r))];
  return [flex.priceEcho(r.order, 'ราคา', amountSatang, r.items, r.margin, pushNote(r.push))];
}

async function acceptCounter(deps: Deps, order: OrderRow): Promise<LineMessage[]> {
  const r = await actions.ownerAcceptCounter(deps, order);
  if (!r.ok) {
    if (r.reason === 'NO_CANDIDATE') return [flex.ownerText(th.owner.noCandidate)];
    if (r.reason === 'DELIVERY_INCOMPLETE') return [flex.ownerText(th.owner.deliveryIncomplete(order.code))];
    return [flex.ownerText(conflictOr(r))];
  }
  return [flex.priceEcho(r.order, 'รับราคา', r.amountSatang, r.items, r.margin, `พิมพ์ "${order.code} ship <ค่าส่ง>" ต่อได้เลย`)];
}

async function holdPrice(deps: Deps, order: OrderRow): Promise<LineMessage[]> {
  const r = await actions.ownerHold(deps, order);
  if (!r.ok) return [flex.ownerText(conflictOr(r))];
  return [flex.ownerText(`✅ ${order.code} ยืนราคา ${formatTHB(r.order.product_price_satang ?? 0)}\n${pushNote(r.push)}`)];
}

async function setShipping(deps: Deps, order: OrderRow, feeSatang: number): Promise<LineMessage[]> {
  const r = await actions.ownerSetShipping(deps, order, feeSatang);
  if (!r.ok && r.reason === 'DELIVERY_INCOMPLETE') return [flex.ownerText(th.owner.deliveryIncomplete(order.code))];
  if (!r.ok) return [flex.ownerText(conflictOr(r))];
  return flex.shippingEcho(r.order, r.lalamoveCard, pushNote(r.push));
}

async function confirmPayment(deps: Deps, order: OrderRow, overrideReason: string | null): Promise<LineMessage[]> {
  const r = await actions.ownerConfirmPayment(deps, order, deps.cfg.OWNER_AUTH_USER_ID, overrideReason);
  if (!r.ok) {
    if (r.reason === 'NO_SLIP') return [flex.ownerText(th.owner.noSlip(order.code))];
    if (r.reason === 'NEEDS_OVERRIDE') return [flex.ownerText(th.owner.paidNeedsPass(order.code, r.checkResult))];
    return [flex.ownerText(conflictOr(r))];
  }
  return [flex.ownerText(`✅ ${order.code} ยืนยันรับเงิน ${formatTHB(r.order.total_satang ?? 0)}${overrideReason ? ` (เหตุผล: ${overrideReason})` : ''}\nจองรถแล้วพิมพ์ "${order.code} track <ลิงก์>"`)];
}

async function dispatch(deps: Deps, order: OrderRow, url: string): Promise<LineMessage[]> {
  const r = await actions.ownerDispatch(deps, order, url);
  if (!r.ok) return [flex.ownerText(conflictOr(r))];
  return [flex.ownerText(`🚚 ${order.code} กำลังจัดส่ง\n${pushNote(r.push)}`)];
}

async function delivered(deps: Deps, order: OrderRow): Promise<LineMessage[]> {
  const r = await actions.ownerDelivered(deps, order, deps.cfg.OWNER_AUTH_USER_ID);
  if (!r.ok) return [flex.ownerText(conflictOr(r))];
  return [flex.ownerText(`✅ ${order.code} ส่งถึงแล้ว | ยอดขาย ${formatTHB(r.order.total_satang ?? 0)} | ตัดสต็อก ${r.items.length} รายการ`)];
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
