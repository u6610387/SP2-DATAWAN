/** Customer-facing cards (CUSTOMER never sees cost or margin). API_AND_AI_CONTRACTS §4.3 */
import { formatTHB, th, type MissingField, type OrderItemRow, type OrderRow } from '@datawan/shared';
import { bangkokHHMM } from '../../util/time';
import {
  bubble, button, COLORS, flex, itemLine, orderLiffUrl, postback, postbackData, quickReply, row, separator, text, textMsg, uri, type Msg,
} from './common';

type NamedItem = OrderItemRow & { name?: string };

export function orderConfirmCard(order: OrderRow, items: NamedItem[], liffId: string, deliveryText: string | null): Msg {
  const body = [
    ...items.map((it) => text(itemLine(it), { size: 'sm' })),
    ...(deliveryText ? [separator(), row('ส่ง', deliveryText)] : []),
    text(th.statusUpdatesHere, { size: 'xs', color: COLORS.muted, margin: 'md' }),
  ];
  return flex(th.confirmTitle(order.code), bubble(th.confirmTitle(order.code), body, [
    button(postback(th.confirmButton, postbackData({ a: 'confirm', o: order.id, v: order.version }), th.confirmButton)),
    button(uri(th.editButton, orderLiffUrl(liffId, order.id)), 'secondary'),
  ]));
}

export function askMissingMessage(question: string | null, missing: MissingField[]): Msg {
  const q = question ?? missing.map((m) => th.askMissing[m]).join(' ');
  return textMsg(q);
}

export function locationAskMessage(order: OrderRow, liffId: string): Msg {
  return textMsg(th.askLocation, quickReply([
    { type: 'location', label: th.shareLocation },
    uri(th.savedAddresses, orderLiffUrl(liffId, order.id)),
  ]));
}

/** Location in, recipient missing: ask for name + phone in LIFF (reply, free). */
export function recipientNeededMessage(order: OrderRow, liffId: string): Msg {
  return textMsg(`${th.recipientNeeded}\n${orderLiffUrl(liffId, order.id)}`);
}

/** Chat slip saved; button to the LIFF payment screen (its upload checks the bank QR on the device). */
export function slipViaChatMessage(order: OrderRow, liffId: string): Msg {
  return flex(th.slipViaChat, bubble(`ออเดอร์ ${order.code}`, [text(th.slipViaChat, { size: 'sm' })], [button(uri(th.uploadViaLiff, orderLiffUrl(liffId, order.id)), 'secondary')]));
}

export function locationReceivedMessage(order: OrderRow, liffId: string): Msg {
  return textMsg(`${th.locationReceived}\n${orderLiffUrl(liffId, order.id)}`);
}

export function priceCard(order: OrderRow, items: NamedItem[], liffId: string, heading?: string): Msg {
  const price = order.product_price_satang ?? 0;
  const body = [
    ...(heading ? [text(heading, { size: 'sm', weight: 'bold' as const })] : []),
    ...items.map((it) => text(itemLine(it), { size: 'sm' })),
    separator(),
    row('ราคาสินค้า', formatTHB(price), true),
    ...(order.price_note ? [text(`หมายเหตุ: ${order.price_note}`, { size: 'xs', color: COLORS.muted })] : []),
    text('ค่าส่งจะแจ้งหลังกดตกลง', { size: 'xs', color: COLORS.muted }),
  ];
  return flex(`${th.priceTitle(order.code)}: ${formatTHB(price)}`, bubble(th.priceTitle(order.code), body, [
    button(postback(th.acceptButton, postbackData({ a: 'accept', o: order.id, v: order.version }), th.acceptButton)),
    button(uri(th.negotiateButton, orderLiffUrl(liffId, order.id)), 'secondary'),
  ]));
}

export interface PromptPayInfo { id: string; name: string }

/** Payment card: breakdown + PromptPay + slip instructions. Sent as the TOTAL_READY push, and as the
 * free pull-on-message reply while AWAITING_PAYMENT (so a capped/deferred push loses nothing). */
export function totalCard(order: OrderRow, liffId: string, promptpay: PromptPayInfo): Msg {
  const body = [
    row('ค่าสินค้า', formatTHB(order.product_price_satang ?? 0)),
    row('ค่าส่ง', formatTHB(order.shipping_fee_satang ?? 0)),
    separator(),
    row('ยอดรวม', formatTHB(order.total_satang ?? 0), true),
    ...(order.payment_expires_at ? [text(th.payWithin(bangkokHHMM(order.payment_expires_at)), { size: 'xs', color: COLORS.red })] : []),
    text(th.promptpayTo(promptpay.id, promptpay.name), { size: 'sm', margin: 'md' }),
    text(th.payInstructions, { size: 'xs', color: COLORS.muted }),
  ];
  return flex(`${th.totalTitle(order.code)}: ${formatTHB(order.total_satang ?? 0)}`, bubble(th.totalTitle(order.code), body, [
    button(uri(th.payButton, orderLiffUrl(liffId, order.id))),
  ]));
}

/** Pull-on-message: whatever the customer writes, show where their order stands (free reply). */
export function statusCard(order: OrderRow, items: NamedItem[], liffId: string, ownerDelayed: boolean): Msg {
  const body = [
    text(th.status[order.status], { weight: 'bold' as const, size: 'md' }),
    ...(ownerDelayed && order.status === 'AWAITING_PRICE' ? [text(th.ownerDelayed, { size: 'sm', color: COLORS.muted })] : []),
    ...items.map((it) => text(itemLine(it), { size: 'sm' })),
    ...(order.product_price_satang !== null ? [separator(), row('ราคาสินค้า', formatTHB(order.product_price_satang))] : []),
    ...(order.shipping_fee_satang !== null ? [row('ค่าส่ง', formatTHB(order.shipping_fee_satang))] : []),
    ...(order.total_satang !== null ? [row('ยอดรวม', formatTHB(order.total_satang), true)] : []),
    ...(order.status === 'AWAITING_PAYMENT' && order.payment_expires_at ? [text(th.payWithin(bangkokHHMM(order.payment_expires_at)), { size: 'xs', color: COLORS.red })] : []),
  ];
  // LINE rejects the whole reply if a URI action is not http(s); both owner paths already enforce it.
  const tracking = order.tracking_url && /^https?:\/\//i.test(order.tracking_url) ? order.tracking_url : null;
  const footer = [
    ...(tracking ? [button(uri(th.trackButton, tracking))] : []),
    button(uri(th.openOrderRoom, orderLiffUrl(liffId, order.id)), tracking ? 'secondary' : 'primary'),
  ];
  if (order.status === 'PRICE_QUOTED') footer.unshift(button(postback(th.acceptButton, postbackData({ a: 'accept', o: order.id, v: order.version }), th.acceptButton)));
  return flex(`${order.code}: ${th.status[order.status]}`, bubble(`ออเดอร์ ${order.code}`, body, footer));
}

export function chooseOrderQuickReply(orders: OrderRow[], messageId: string): Msg {
  return textMsg(th.chooseOrder, quickReply(
    orders.slice(0, 13).map((o) => postback(`${o.code} ${formatTHB(o.total_satang ?? 0)}`.slice(0, 20), postbackData({ a: 'slip_for', o: o.id, i: messageId }), o.code)),
  ));
}

export function newOrAddQuickReply(order: OrderRow, pendingEventId: string): Msg {
  return textMsg(th.newOrAdd(order.code), quickReply([
    postback(th.addToOrder(order.code).slice(0, 20), postbackData({ a: 'add', o: order.id, e: pendingEventId }), th.addToOrder(order.code)),
    postback(th.newOrder, postbackData({ a: 'new', e: pendingEventId }), th.newOrder),
  ]));
}

export function dispatchedMessage(order: OrderRow): Msg {
  return textMsg(th.dispatched(order.tracking_url ?? ''));
}
