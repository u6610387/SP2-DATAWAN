/**
 * Delivery recipient (name + Thai phone) — needed on the Lalamove card the owner pastes.
 *
 * An order only reaches the shop (LOCATION_SET → AWAITING_PRICE, owner notified) once it has a
 * location AND a recipient. Repeat customers are pre-filled from their saved profile; first-time
 * customers get a (free) reply with the LIFF link and fill the form there. PII stays in Supabase
 * (users / addresses / orders.recipient_*) and is never logged or sent to Gemini (CLAUDE.md §3.3).
 */
import type { OrderPatch, OrderRow, OrderStatus, UserRow } from '@datawan/shared';
import type { Deps } from '../deps';
import * as flex from '../line/flex';
import { withNames } from './itemNames';
import { applyEvent, logEvent, patchOrder, type ApplyResult } from './orders';
import { suggestPrice } from './pricing';

/** Recipient may be set/edited until the order is out for delivery. */
const EDITABLE: readonly OrderStatus[] = [
  'AWAITING_CONFIRMATION', 'AWAITING_LOCATION', 'AWAITING_PRICE', 'PRICE_QUOTED', 'NEGOTIATING',
  'AWAITING_SHIPPING_FEE', 'AWAITING_PAYMENT', 'PAYMENT_EXPIRED', 'PAYMENT_REVIEW', 'PAID',
];

export function profileHasRecipient(user: Pick<UserRow, 'full_name' | 'phone'>): boolean {
  return Boolean(user.full_name?.trim() && user.phone?.trim());
}

/** Location + recipient name + phone: what the rider (and the Lalamove quote) needs. */
export function deliveryReady(order: Pick<OrderRow, 'address_id' | 'recipient_name' | 'recipient_phone'>): boolean {
  return order.address_id !== null && Boolean(order.recipient_name?.trim() && order.recipient_phone?.trim());
}

/** The customer must still fill the recipient (held new order, or an older order without one). */
export function orderNeedsRecipient(order: Pick<OrderRow, 'status' | 'address_id' | 'recipient_name' | 'recipient_phone'>): boolean {
  return EDITABLE.includes(order.status) && order.address_id !== null && !deliveryReady(order);
}

/** LOCATION_SET + owner NEW_ORDER alert. Caller guarantees location + recipient are present. */
export async function completeLocation(deps: Deps, order: OrderRow, patch: OrderPatch = {}): Promise<ApplyResult> {
  const res = await applyEvent(deps, order, 'LOCATION_SET', 'customer', patch);
  if (!res.ok) return res;
  const items = await deps.repo.getItems(res.order.id);
  const s = await suggestPrice(deps, res.order, items);
  await deps.notifier.notify({
    kind: 'NEW_ORDER',
    orderId: res.order.id,
    code: res.order.code,
    summary: flex.newOrderSummary(res.order, withNames(items, await deps.repo.listActiveProducts())),
    suggestedPriceSatang: s.b2bAnchorSatang ?? s.suggestedSatang,
  });
  return res;
}

export type SetRecipientResult =
  | { ok: true; order: OrderRow; submitted: boolean }
  | { ok: false; reason: 'INVALID_FROM_STATE' | 'VERSION_CONFLICT' | 'WRONG_ACTOR'; order: OrderRow };

/** Customer saves the recipient: to the order, its address and their profile (pre-fill next time). */
export async function setRecipient(deps: Deps, order: OrderRow, user: UserRow, contact: { name: string; phone: string }): Promise<SetRecipientResult> {
  if (!EDITABLE.includes(order.status)) return { ok: false, reason: 'INVALID_FROM_STATE', order };
  const now = deps.now().toISOString();
  await deps.repo.updateUserContact(user.id, { full_name: contact.name, phone: contact.phone, ...(user.pdpa_consent_at ? {} : { pdpa_consent_at: now }) });
  if (order.address_id) await deps.repo.setAddressRecipient(order.address_id, { recipient_name: contact.name, recipient_phone: contact.phone });

  const recipient = { recipient_name: contact.name, recipient_phone: contact.phone };
  // Still waiting for the recipient with a location already in → submit the order to the shop now.
  if (order.status === 'AWAITING_LOCATION' && order.address_id) {
    const res = await completeLocation(deps, order, recipient);
    if (!res.ok) return res;
    await logEvent(deps, res.order, 'customer', 'RECIPIENT_SET', { submitted: true });
    return { ok: true, order: res.order, submitted: true };
  }
  const updated = await patchOrder(deps, order, recipient);
  if (!updated) return { ok: false, reason: 'VERSION_CONFLICT', order };
  await logEvent(deps, updated, 'customer', 'RECIPIENT_SET', { submitted: false });
  return { ok: true, order: updated, submitted: false };
}
