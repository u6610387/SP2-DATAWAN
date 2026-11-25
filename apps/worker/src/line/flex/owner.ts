/** Owner-facing LINE replies (free: always via replyToken to the owner's own messages). */
import { formatTHB, th, type AddressRow, type Margin, type OrderItemRow, type OrderRow, type UserRow } from '@datawan/shared';
import type { ResolvedOwnerNote } from '@datawan/ai';
import { mapUrl } from '../../services/location';
import { bangkokHHMM } from '../../util/time';
import { bubble, button, COLORS, flex, itemLine, postback, postbackData, text, textMsg, type Msg } from './common';

const ICON = { GREEN: '🟢', RED: '🔴', GREY: '⚪' } as const;

export function marginText(m: Margin): string {
  if (m.marginSatang === null) return 'ไม่มีข้อมูลต้นทุน ⚪';
  const sign = m.marginSatang >= 0 ? '+' : '';
  const pct = m.marginPct !== null ? ` (${Math.round(m.marginPct * 100)}%)` : '';
  return `กำไร ${sign}${formatTHB(m.marginSatang)}${pct} ${ICON[m.color]}`;
}

export function costText(items: Pick<OrderItemRow, 'cost_satang'>[]): string {
  if (!items.length || items.some((i) => i.cost_satang === null)) return 'ต้นทุน ?';
  return `ต้นทุน ${formatTHB(items.reduce((a, i) => a + (i.cost_satang ?? 0), 0))}`;
}

/** "✅ A12 ราคา ฿1,850 | ต้นทุน ฿1,420 | กำไร +฿430 (23%) 🟢" */
export function priceEcho(order: OrderRow, label: string, amountSatang: number, items: OrderItemRow[], margin: Margin, pushNote: string): Msg {
  return textMsg(`✅ ${order.code} ${label} ${formatTHB(amountSatang)} | ${costText(items)} | ${marginText(margin)}\n${pushNote}`);
}

export function ownerText(t: string): Msg {
  return textMsg(t);
}

/** Copy-ready Lalamove card (step 5): the owner pastes this into the Lalamove app. */
export function lalamoveCardText(order: OrderRow, address: AddressRow | null, user: UserRow | null): string {
  const name = (order.recipient_name ?? user?.full_name ?? '').trim();
  const phone = (order.recipient_phone ?? user?.phone ?? '').trim();
  const map = address ? mapUrl(address.lat, address.lng) : null;
  return [
    `📦 ${order.code} — Lalamove`,
    // Only real values (pasted straight into Lalamove). Older orders created before the recipient
    // step say so explicitly instead of a "-" the owner might paste by mistake.
    ...(name ? [`ผู้รับ: ${name}`] : []),
    ...(phone ? [`โทร: ${phone}`] : []),
    ...(!name || !phone ? ['⚠️ ยังไม่มีชื่อ/เบอร์ผู้รับ — ให้ลูกค้ากรอกในลิงก์ออเดอร์ หรือโทรถามก่อนเรียกไรเดอร์'] : []),
    `ที่อยู่: ${address?.address_text ?? '(ดูจากหมุด)'}`,
    ...(map ? [`แผนที่: ${map}`] : []),
    ...(order.requested_delivery_at ? [`เวลาส่ง: ${bangkokHHMM(order.requested_delivery_at)} น.`] : []),
  ].join('\n');
}

export function shippingEcho(order: OrderRow, card: string, pushNote: string): Msg[] {
  return [
    textMsg(
      `✅ ${order.code} ค่าส่ง ${formatTHB(order.shipping_fee_satang ?? 0)} | ยอดรวม ${formatTHB(order.total_satang ?? 0)}` +
        (order.payment_expires_at ? ` | หมดเวลา ${bangkokHHMM(order.payment_expires_at)} น.` : '') +
        `\n${pushNote}`,
    ),
    textMsg(card),
  ];
}

export function noteDraftMessage(order: OrderRow, draft: ResolvedOwnerNote, eventId: string): Msg {
  return flex(`ร่างข้อความ ${order.code}`, bubble(`ร่างข้อความ ${order.code}`, [
    text(th.owner.noteDraft, { size: 'xs', color: COLORS.muted }),
    text(draft.message_th, { size: 'sm' }),
  ], [button(postback(th.owner.sendButton, postbackData({ a: 'note_send', o: order.id, e: eventId }), th.owner.sendButton))]));
}

export function openOrdersText(orders: (OrderRow & { itemCount: number })[]): Msg {
  if (!orders.length) return textMsg(th.owner.noOpenOrders);
  return textMsg(
    orders
      .slice(0, 30)
      .map((o) => `${o.code} · ${th.status[o.status]}${o.total_satang !== null ? ` · ${formatTHB(o.total_satang)}` : o.product_price_satang !== null ? ` · ${formatTHB(o.product_price_satang)}` : ''} · ${o.itemCount} รายการ`)
      .join('\n'),
  );
}

export function newOrderSummary(order: OrderRow, items: OrderItemRow[]): string {
  return `${order.code}: ${items.map((i) => itemLine(i).replace('• ', '')).join(', ')}`;
}
