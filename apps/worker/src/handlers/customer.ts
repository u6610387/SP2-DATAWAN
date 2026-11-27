/**
 * Customer chat handling — routed by the active order's state (CLAUDE.md §3.5 chat fallback).
 * Every customer interaction is answered with the free replyToken.
 */
import type { webhook } from '@line/bot-sdk';
import type { ResolvedOrderParse } from '@datawan/ai';
import {
  bahtToSatang,
  formatTHB,
  th,
  type AddressSource,
  type OrderRow,
  type ProductRow,
  type UserRow,
} from '@datawan/shared';
import type { Deps } from '../deps';
import type { LineMessage } from '../line/api';
import * as flex from '../line/flex';
import { applyEvent, logEvent, patchOrder, resolveActiveOrder } from '../services/orders';
import { completeLocation, profileHasRecipient } from '../services/recipient';
import { reviewNeeded } from '../services/review';
import * as actions from '../services/orderActions';
import { isMapsUrl, looksLikeAddress, parseMapsLink } from '../services/location';
import { suggestPrice } from '../services/pricing';
import type { NewOrderItem } from '../services/repo';
import { withNames } from '../services/itemNames';
import { bangkokHHMM } from '../util/time';
import { infoReplyText, matchInfoCommand, shippingOrder } from './infoCommands';

/** Statuses that accept a slip (same as SLIP_UPLOADED's edges in orderMachine). */
export const PAYABLE = ['AWAITING_PAYMENT', 'PAYMENT_EXPIRED'] as const;
/** "ขอลิ้งค์ lalamove", "ลิงก์ส่งของ", "ถึงไหนแล้ว", "track" … (deterministic; no AI call). */
export const TRACKING_RE = /(ลิ้?ง(ค์|ก์|ก)|link|lalamove|ลาล่?ามูฟ|ติดตาม|ถึงไหน|ส่งถึง(ยัง|หรือยัง)|ไรเดอร์|rider|track)/i;
/** "สมัครร้านค้า", "บัญชีร้าน", "b2b" … → LIFF account link (deterministic; reply only, never push). */
export const B2B_KEYWORD_RE = /(สมัคร\s*(ร้านค้า|บัญชีร้าน)|ร้านค้า\s*b2b|\bb2b\b|^\s*บัญชี\s*ร้าน(ค้า)?\s*$)/i;
const ACCEPT_RE = /^(ok|โอเค|ตกลง|เอา|รับ|ได้|ได้ค่ะ|ได้ครับ)\s*(ค่ะ|ครับ|คะ|จ้า)?$/i;
const COUNTER_RE = /^\s*(?:ขอ\s*)?(\d{1,3}(?:,\d{3})+|\d{2,6})\s*(?:บาท)?\s*(?:ได้ไหม|ได้มั้ย|ได้ไหมคะ|ได้ไหมครับ|ได้มั้ยคะ|นะคะ|นะครับ)?\s*$/;

// ---------------- small helpers ----------------

export async function reply(deps: Deps, replyToken: string | undefined, messages: LineMessage[]): Promise<void> {
  if (!replyToken || messages.length === 0) return;
  await deps.line.reply(replyToken, messages.slice(0, 5));
}

function knownNames(user: UserRow): string[] {
  return [user.full_name, user.display_name, user.business_name].filter((x): x is string => !!x);
}

function toNewItems(parse: ResolvedOrderParse, products: ProductRow[]): NewOrderItem[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  return parse.items
    .filter((it) => it.qty !== null)
    .map((it) => ({
      product_id: it.product_id,
      raw_text: it.raw_text,
      qty: it.qty!,
      unit: it.unit ?? (it.product_id ? byId.get(it.product_id)?.unit : undefined) ?? 'kg',
      prep_type: it.prep_type,
      note: it.note,
    }));
}

function deliveryText(parse: ResolvedOrderParse | null): string | null {
  if (!parse?.delivery_time.iso) return parse?.delivery_time.raw_text ?? null;
  return `${parse.delivery_time.raw_text ?? ''} (${bangkokHHMM(parse.delivery_time.iso)} น.)`.trim();
}

/**
 * The customer clearly wants to order, but no catalog product matched (e.g. "กุ้ง 2 โล" with no
 * "กุ้ง" alias). Code can't resolve this — flag it so the owner decides (CLAUDE.md §3.1).
 */
function noProductRecognised(parse: ResolvedOrderParse, items: NewOrderItem[]): boolean {
  return ['new_order', 'modify', 'reorder'].includes(parse.intent) && items.length === 0 && parse.missing_fields.includes('product');
}

async function alreadyAlertedUnrecognised(deps: Deps, orderId: string): Promise<boolean> {
  return (await deps.repo.listOrderEvents(orderId)).some((e) => e.event === 'UNRECOGNISED_ALERTED' || (e.event === 'ORDER_CREATED' && (e.payload as { unrecognisedProduct?: boolean } | null)?.unrecognisedProduct));
}

async function alertUnrecognisedProduct(deps: Deps, order: OrderRow, text: string): Promise<void> {
  await logEvent(deps, order, 'system', 'UNRECOGNISED_ALERTED', {});
  const snippet = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  await deps.notifier.notify({ kind: 'NEEDS_REVIEW', orderId: order.id, code: order.code, reason: `no catalog product matched: "${snippet}"` });
}

function asParse(v: unknown): ResolvedOrderParse | null {
  return v && typeof v === 'object' && 'items' in v ? (v as ResolvedOrderParse) : null;
}

function isRecentlyDelivered(deps: Deps, order: OrderRow): boolean {
  if (!order.delivered_at) return false;
  return deps.now().getTime() - new Date(order.delivered_at).getTime() <= deps.cfg.RECENT_ORDER_STATUS_HOURS * 3_600_000;
}

/** Text with the clickable link (or "not yet") + the status card with the tracking button. */
async function trackingReply(deps: Deps, order: OrderRow): Promise<LineMessage[]> {
  const head = order.tracking_url ? flex.textMsg(th.trackingLink(order.code, order.tracking_url)) : flex.textMsg(th.trackingNotYet(order.code));
  return [head, await statusReply(deps, order)];
}

async function statusReply(deps: Deps, order: OrderRow): Promise<LineMessage> {
  // While payable, the customer needs the payment card — the TOTAL_READY push may have been
  // deferred by the Quota Guard (ORDER_CAP), and this free reply is the fallback (CLAUDE.md D2).
  if (order.status === 'AWAITING_PAYMENT') {
    return flex.totalCard(order, deps.cfg.LIFF_ID, { id: deps.cfg.PROMPTPAY_ID, name: deps.cfg.PROMPTPAY_RECEIVER_NAME });
  }
  const [items, products] = await Promise.all([deps.repo.getItems(order.id), deps.repo.listActiveProducts()]);
  return flex.statusCard(order, withNames(items, products), deps.cfg.LIFF_ID, order.owner_reminded_at !== null);
}

async function confirmOrAsk(deps: Deps, order: OrderRow, parse: ResolvedOrderParse): Promise<LineMessage[]> {
  if (parse.missing_fields.length) return [flex.askMissingMessage(parse.clarification_question_th, parse.missing_fields)];
  const [items, products] = await Promise.all([deps.repo.getItems(order.id), deps.repo.listActiveProducts()]);
  return [flex.orderConfirmCard(order, withNames(items, products), deps.cfg.LIFF_ID, deliveryText(parse))];
}

// ---------------- AI parse → order ----------------

async function parseText(deps: Deps, user: UserRow, text: string, previousDraft?: ResolvedOrderParse) {
  const products = await deps.repo.listActiveProducts();
  const last = await deps.repo.lastDeliveredOrder(user.id);
  const lastItems = last ? await deps.repo.getItems(last.id) : [];
  const previousOrderItems = lastItems
    .filter((i) => i.product_id)
    .map((i) => ({ productId: i.product_id!, qty: i.qty, unit: i.unit as 'kg', prepType: i.prep_type }));
  const r = await deps.ai.parseOrder({
    message: text,
    products,
    knownNames: knownNames(user),
    now: deps.now(),
    ...(previousDraft ? { previousDraft } : {}),
    ...(previousOrderItems.length ? { previousOrderItems } : {}),
  });
  return { r, products, sourceOrderId: last?.id ?? null, lastDelivered: last };
}

export async function createOrderFromParse(
  deps: Deps,
  user: UserRow,
  text: string,
  parse: ResolvedOrderParse,
  warnings: string[],
  products: ProductRow[],
  sourceOrderId: string | null,
): Promise<{ order: OrderRow; messages: LineMessage[] }> {
  const items = toNewItems(parse, products);
  const unrecognised = noProductRecognised(parse, items);
  const review = reviewNeeded(parse, items, warnings);
  const order = await deps.repo.createOrder(
    {
      user_id: user.id,
      raw_order_text: text,
      ai_parse: parse,
      needs_owner_review: review.needed,
      channel: 'chat',
      source_order_id: parse.intent === 'reorder' ? sourceOrderId : null,
      requested_delivery_at: parse.delivery_time.iso,
    },
    items,
  );
  await deps.repo.setActiveOrder(user.id, order.id);
  await logEvent(deps, order, 'customer', 'ORDER_CREATED', { intent: parse.intent, warnings, reviewReasons: review.reasons, ...(unrecognised ? { unrecognisedProduct: true } : {}) });
  if (unrecognised) await alertUnrecognisedProduct(deps, order, text);
  return { order, messages: await confirmOrAsk(deps, order, parse) };
}

async function newOrderFromText(deps: Deps, user: UserRow, text: string, replyToken?: string): Promise<void> {
  const { r, products, sourceOrderId, lastDelivered } = await parseText(deps, user, text);
  if (!r.ok) {
    const order = await deps.repo.createOrder(
      { user_id: user.id, raw_order_text: text, ai_parse: null, needs_owner_review: true, channel: 'chat' },
      [],
    );
    await deps.repo.setActiveOrder(user.id, order.id);
    await deps.notifier.notify({ kind: 'NEEDS_REVIEW', orderId: order.id, code: order.code, reason: `AI ${r.error}` });
    return reply(deps, replyToken, [flex.textMsg(th.orderReceivedChecking)]);
  }
  const { parse, warnings } = r.data;
  if (parse.intent === 'not_order' || parse.intent === 'question') {
    // No open order, but one was just delivered → "ของถึงยัง/ขอบคุณค่ะ" gets its status + tracking (free reply).
    const recent = lastDelivered && isRecentlyDelivered(deps, lastDelivered) ? [await statusReply(deps, lastDelivered)] : [];
    const text = parse.intent === 'question' ? th.questionForwarded : recent.length ? null : th.welcome;
    return reply(deps, replyToken, [...recent, ...(text ? [flex.textMsg(text)] : [])]);
  }
  const { messages } = await createOrderFromParse(deps, user, text, parse, warnings, products, sourceOrderId);
  return reply(deps, replyToken, messages);
}

async function editDraft(deps: Deps, user: UserRow, order: OrderRow, text: string, replyToken?: string): Promise<void> {
  const previous = asParse(order.ai_parse);
  const { r, products } = await parseText(deps, user, text, previous ?? undefined);
  if (!r.ok) return reply(deps, replyToken, [await statusReply(deps, order)]);
  const { parse, warnings } = r.data;
  if (parse.intent === 'not_order' || parse.intent === 'question') return reply(deps, replyToken, [await statusReply(deps, order)]);
  const items = toNewItems(parse, products);
  const unrecognised = noProductRecognised(parse, items);
  // Re-evaluated from the whole draft after this edit (not sticky): filling in the missing
  // quantity clears the flag; anything still uncertain keeps it.
  const review = reviewNeeded(parse, items, warnings);
  await deps.repo.replaceItems(order.id, items);
  const res = await applyEvent(deps, order, 'CUSTOMER_EDIT', 'customer', {
    ai_parse: parse,
    needs_owner_review: review.needed,
    requested_delivery_at: parse.delivery_time.iso ?? order.requested_delivery_at,
    raw_order_text: `${order.raw_order_text ?? ''}\n${text}`.trim(),
  });
  if (!res.ok) return reply(deps, replyToken, [await statusReply(deps, order)]);
  if (review.needed !== order.needs_owner_review) {
    await logEvent(deps, res.order, 'system', review.needed ? 'REVIEW_FLAGGED' : 'REVIEW_CLEARED', { reasons: review.reasons });
  }
  // Alert once per order for an unrecognised product (not again on every follow-up).
  if (unrecognised && !(await alreadyAlertedUnrecognised(deps, order.id))) await alertUnrecognisedProduct(deps, res.order, text);
  return reply(deps, replyToken, await confirmOrAsk(deps, res.order, parse));
}

// ---------------- steps ----------------

async function confirmOrder(deps: Deps, user: UserRow, order: OrderRow): Promise<{ order: OrderRow } | { messages: LineMessage[] }> {
  const parse = asParse(order.ai_parse);
  const items = await deps.repo.getItems(order.id);
  if (!items.length || (parse && parse.missing_fields.length)) {
    return { messages: [flex.askMissingMessage(parse?.clarification_question_th ?? null, parse?.missing_fields.length ? parse.missing_fields : ['product'])] };
  }
  const res = await applyEvent(deps, order, 'CUSTOMER_CONFIRM', 'customer');
  if (!res.ok) return { messages: [await statusReply(deps, order)] };
  await deps.repo.setActiveOrder(user.id, order.id);
  return { order: res.order };
}

async function setLocation(
  deps: Deps,
  user: UserRow,
  order: OrderRow,
  loc: { lat: number | null; lng: number | null; addressText: string | null; source: AddressSource },
  replyToken?: string,
): Promise<void> {
  let current = order;
  if (current.status === 'AWAITING_CONFIRMATION') {
    const c = await confirmOrder(deps, user, current);
    if ('messages' in c) return reply(deps, replyToken, c.messages);
    current = c.order;
  }
  if (current.status !== 'AWAITING_LOCATION') return reply(deps, replyToken, [await statusReply(deps, current)]);

  // Recipient comes from the saved profile (repeat customers). LINE display names are not a
  // recipient: the rider needs a real name + phone.
  const hasRecipient = profileHasRecipient(user);
  const address = await deps.repo.insertAddress({
    user_id: user.id,
    recipient_name: hasRecipient ? user.full_name : null,
    recipient_phone: hasRecipient ? user.phone : null,
    address_text: loc.addressText,
    lat: loc.lat,
    lng: loc.lng,
    source: loc.source,
  });
  if (!hasRecipient) {
    // Keep the order out of the shop's queue until the customer fills name + phone in LIFF.
    const held = await patchOrder(deps, current, { address_id: address.id });
    return reply(deps, replyToken, [flex.recipientNeededMessage(held ?? current, deps.cfg.LIFF_ID)]);
  }
  const res = await completeLocation(deps, current, {
    address_id: address.id,
    recipient_name: address.recipient_name,
    recipient_phone: address.recipient_phone,
  });
  if (!res.ok) return reply(deps, replyToken, [await statusReply(deps, current)]);
  return reply(deps, replyToken, [flex.locationReceivedMessage(res.order, deps.cfg.LIFF_ID)]);
}

async function acceptPrice(deps: Deps, order: OrderRow, replyToken?: string): Promise<void> {
  const r = await actions.customerAccept(deps, order);
  if (!r.ok && r.reason === 'DELIVERY_INCOMPLETE') return reply(deps, replyToken, [flex.recipientNeededMessage(order, deps.cfg.LIFF_ID)]);
  if (!r.ok) return reply(deps, replyToken, [flex.textMsg(th.staleAction), await statusReply(deps, order)]);
  return reply(deps, replyToken, [flex.textMsg(th.accepted)]);
}

async function counterOffer(deps: Deps, order: OrderRow, amountSatang: number, replyToken?: string): Promise<void> {
  const r = await actions.customerCounter(deps, order, amountSatang);
  if (!r.ok) {
    if (r.reason === 'COUNTER_TOO_HIGH') return reply(deps, replyToken, [flex.textMsg(th.counterTooHigh)]);
    return reply(deps, replyToken, [await statusReply(deps, order)]);
  }
  return reply(deps, replyToken, [flex.textMsg(th.counterReceived(formatTHB(amountSatang)))]);
}

export async function processSlip(deps: Deps, order: OrderRow, messageId: string, replyToken?: string): Promise<void> {
  const content = await deps.line.getContent(messageId);
  const mime = (['image/png', 'image/webp'].includes(content.contentType) ? content.contentType : 'image/jpeg') as 'image/jpeg';
  const path = await deps.storage.upload('slips', `${order.id}/${crypto.randomUUID()}.${mime.split('/')[1]}`, content.bytes, mime);

  const r = await actions.submitSlip(deps, order, path, content.bytes, mime, { via: 'chat' });
  if (!r.ok) {
    if (r.reason === 'NOT_A_SLIP') return reply(deps, replyToken, [flex.textMsg(th.notASlip)]);
    return reply(deps, replyToken, [await statusReply(deps, order)]);
  }
  // Kept as evidence (CLAUDE.md §3.5); suggest the LIFF screen, whose upload checks the bank QR first.
  return reply(deps, replyToken, [flex.slipViaChatMessage(order, deps.cfg.LIFF_ID)]);
}

// ---------------- router ----------------

export async function handleCustomerEvent(deps: Deps, ev: webhook.Event, lineUserId: string): Promise<void> {
  const replyToken = 'replyToken' in ev ? (ev.replyToken as string | undefined) : undefined;

  if (ev.type === 'unfollow') {
    const u = await deps.repo.upsertUserByLineId(lineUserId);
    return deps.repo.markUserInactive(u.id);
  }
  const user = await deps.repo.upsertUserByLineId(lineUserId);
  if (ev.type === 'follow') return reply(deps, replyToken, [flex.textMsg(th.welcome)]);

  if (ev.type === 'postback') return handlePostback(deps, user, ev, replyToken);
  if (ev.type !== 'message') return;

  const { active, open } = await resolveActiveOrder(deps, user.id, user.active_order_id);
  const msg = ev.message;

  if (msg.type === 'image') {
    const payable = open.filter((o) => (PAYABLE as readonly string[]).includes(o.status));
    if (payable.length === 0) {
      if (active) await logEvent(deps, active, 'customer', 'IMAGE_RECEIVED', { message_id: msg.id });
      return reply(deps, replyToken, [flex.textMsg(th.noPayableOrder)]);
    }
    if (payable.length === 1) return processSlip(deps, payable[0]!, msg.id, replyToken);
    return reply(deps, replyToken, [flex.chooseOrderQuickReply(payable, msg.id)]);
  }

  if (msg.type === 'location') {
    if (active && ['AWAITING_CONFIRMATION', 'AWAITING_LOCATION'].includes(active.status)) {
      return setLocation(deps, user, active, { lat: msg.latitude, lng: msg.longitude, addressText: msg.address ?? msg.title ?? null, source: 'line_pin' }, replyToken);
    }
    return reply(deps, replyToken, [active ? await statusReply(deps, active) : flex.textMsg(th.noOpenOrder)]);
  }

  if (msg.type !== 'text') {
    return reply(deps, replyToken, [active ? await statusReply(deps, active) : flex.textMsg(th.noOpenOrder)]);
  }

  const text = msg.text.trim();
  // Delivery / tracking question: answer for the order that's actually paid or on the way (not
  // necessarily the active one — the customer may already have a newer order open).
  // Exact-match info keywords first: answered from the DB by code (no AI, no push, no order change).
  // Before TRACKING_RE, which would otherwise catch "ขอลิงก์ออเดอร์" ("ลิงก์").
  const info = matchInfoCommand(text);
  if (info) {
    // A delivery question about an order that's paid or on the way gets the same link + status card
    // as TRACKING_RE (even when a newer draft is active); otherwise a text summary.
    const target = info === 'delivery' ? shippingOrder(open) : null;
    if (target) return reply(deps, replyToken, await trackingReply(deps, target));
    return reply(deps, replyToken, [flex.textMsg(await infoReplyText(deps, user, info, { open, active }))]);
  }
  if (TRACKING_RE.test(text)) {
    const target = shippingOrder(open);
    if (target) return reply(deps, replyToken, await trackingReply(deps, target));
  }
  if (B2B_KEYWORD_RE.test(text)) {
    const profile = await deps.repo.getBusinessProfile(user.id);
    const lines = [th.b2bAccountLink(flex.liffUrl(deps.cfg.LIFF_ID, '/account'))];
    if (profile) lines.push(th.b2bStatusLine(profile.status));
    return reply(deps, replyToken, [flex.textMsg(lines.join('\n'))]);
  }
  if (!active) return newOrderFromText(deps, user, text, replyToken);

  switch (active.status) {
    case 'AWAITING_CONFIRMATION':
      return editDraft(deps, user, active, text, replyToken);
    case 'AWAITING_LOCATION': {
      const pin = parseMapsLink(text);
      if (pin || isMapsUrl(text)) {
        return setLocation(deps, user, active, { lat: pin?.lat ?? null, lng: pin?.lng ?? null, addressText: text, source: 'maps_link' }, replyToken);
      }
      if (looksLikeAddress(text)) {
        // TODO: geocode typed addresses (Longdo → OSM). Owner sees the text on the Lalamove card meanwhile.
        return setLocation(deps, user, active, { lat: null, lng: null, addressText: text, source: 'typed' }, replyToken);
      }
      return reply(deps, replyToken, [flex.locationAskMessage(active, deps.cfg.LIFF_ID)]);
    }
    case 'PRICE_QUOTED': {
      if (ACCEPT_RE.test(text)) return acceptPrice(deps, active, replyToken);
      const m = COUNTER_RE.exec(text);
      if (m) return counterOffer(deps, active, bahtToSatang(Number(m[1]!.replace(/,/g, ''))), replyToken);
      break;
    }
    default:
      break;
  }

  // Anything else: maybe a new order while one is open → ask; otherwise pull-on-message status.
  const { r } = await parseText(deps, user, text);
  if (r.ok && (r.data.parse.intent === 'new_order' || r.data.parse.intent === 'reorder') && r.data.parse.items.length > 0) {
    const pending = await logEvent(deps, active, 'customer', 'PENDING_ORDER_TEXT', { text, parse: r.data.parse, warnings: r.data.warnings });
    return reply(deps, replyToken, [flex.newOrAddQuickReply(active, pending.id)]);
  }
  return reply(deps, replyToken, [await statusReply(deps, active)]);
}

async function handlePostback(deps: Deps, user: UserRow, ev: webhook.PostbackEvent, replyToken?: string): Promise<void> {
  const p = new URLSearchParams(ev.postback.data);
  const action = p.get('a');
  const orderId = p.get('o');
  const version = p.get('v');
  const order = orderId ? await deps.repo.getOrder(orderId) : null;
  if (order && order.user_id !== user.id) return; // not this customer's order — ignore silently

  if (action === 'new' || action === 'add') {
    const pending = p.get('e') ? await deps.repo.getEvent(p.get('e')!) : null;
    const payload = pending?.payload as { text: string; parse: ResolvedOrderParse; warnings: string[] } | undefined;
    if (!payload) return reply(deps, replyToken, [flex.textMsg(th.staleAction)]);
    const products = await deps.repo.listActiveProducts();
    if (action === 'add' && order && ['AWAITING_PRICE', 'PRICE_QUOTED', 'NEGOTIATING'].includes(order.status)) {
      const existing = await deps.repo.getItems(order.id);
      const merged: NewOrderItem[] = [
        ...existing.map(({ product_id, raw_text, qty, unit, prep_type, note }) => ({ product_id, raw_text, qty, unit, prep_type, note })),
        ...toNewItems(payload.parse, products),
      ];
      await deps.repo.replaceItems(order.id, merged);
      const res = await applyEvent(deps, order, 'CUSTOMER_EDIT', 'customer', { raw_order_text: `${order.raw_order_text ?? ''}\n${payload.text}`.trim() });
      if (res.ok) {
        await deps.notifier.notify({ kind: 'NEEDS_REVIEW', orderId: order.id, code: order.code, reason: 'customer added items — re-quote' });
        return reply(deps, replyToken, [await statusReply(deps, res.order)]);
      }
    }
    const notice = action === 'add' && order ? [flex.textMsg(th.cannotModify(order.code))] : [];
    const { messages } = await createOrderFromParse(deps, user, payload.text, payload.parse, payload.warnings, products, null);
    return reply(deps, replyToken, [...notice, ...messages]);
  }

  if (!order) return reply(deps, replyToken, [flex.textMsg(th.noOpenOrder)]);
  if (version && Number(version) !== order.version && action !== 'slip_for') {
    // Stale button: show the current state instead of applying (line-liff-architect §3).
    if (!(action === 'confirm' && order.status === 'AWAITING_CONFIRMATION') && !(action === 'accept' && order.status === 'PRICE_QUOTED')) {
      return reply(deps, replyToken, [flex.textMsg(th.staleAction), await statusReply(deps, order)]);
    }
  }

  switch (action) {
    case 'confirm': {
      const c = await confirmOrder(deps, user, order);
      if ('messages' in c) return reply(deps, replyToken, c.messages);
      return reply(deps, replyToken, [flex.locationAskMessage(c.order, deps.cfg.LIFF_ID)]);
    }
    case 'accept':
      return acceptPrice(deps, order, replyToken);
    case 'cancel': {
      const res = await applyEvent(deps, order, 'CUSTOMER_CANCEL', 'customer', { cancelled_at: deps.now().toISOString(), cancel_reason: 'customer' });
      if (res.ok && user.active_order_id === order.id) await deps.repo.setActiveOrder(user.id, null);
      return reply(deps, replyToken, [res.ok ? flex.textMsg(th.cancelled) : await statusReply(deps, order)]);
    }
    case 'slip_for': {
      const messageId = p.get('i');
      if (!messageId || !(PAYABLE as readonly string[]).includes(order.status)) return reply(deps, replyToken, [await statusReply(deps, order)]);
      return processSlip(deps, order, messageId, replyToken);
    }
    default:
      return reply(deps, replyToken, [await statusReply(deps, order)]);
  }
}
