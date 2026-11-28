/**
 * LIFF order history + one-tap reorder (docs/API_AND_AI_CONTRACTS.md §2.2).
 *
 * Reorder copies a DELIVERED order's items — product, qty, unit, prep — with no Gemini call and
 * no prices: the new order starts in AWAITING_CONFIRMATION and goes through the normal owner
 * price-quote flow (CLAUDE.md §3.1). No LINE push is sent (§3.4); the customer continues in the
 * LIFF order room (confirm → same address) or in chat (the order becomes their active order, §3.5).
 */
import { th, type OrderRow, type ProductRow, type UserRow } from '@datawan/shared';
import type { Deps } from '../deps';
import { applyEvent, logEvent, patchOrder, type ApplyResult } from './orders';
import { completeLocation, profileHasRecipient } from './recipient';
import type { NewOrderItem } from './repo';
import type { OrderItemRow } from '@datawan/shared';

/** Items of `source` that can be copied now (active product), and the names of those that can't. */
export function reorderableItems(items: OrderItemRow[], products: ProductRow[]): { copy: NewOrderItem[]; skipped: string[] } {
  const active = new Map(products.filter((p) => p.is_active).map((p) => [p.id, p]));
  const copy: NewOrderItem[] = [];
  const skipped: string[] = [];
  for (const it of [...items].sort((a, b) => a.sort - b.sort)) {
    const p = it.product_id ? active.get(it.product_id) : undefined;
    if (!p) {
      skipped.push(it.raw_text);
      continue;
    }
    // 'any' (customer didn't say) always stays valid; a prep the shop no longer offers falls back to 'any'.
    const prep = it.prep_type === 'any' || p.prep_types.includes(it.prep_type) ? it.prep_type : 'any';
    copy.push({ product_id: p.id, raw_text: p.name_th, qty: it.qty, unit: it.unit, prep_type: prep, note: it.note });
  }
  return { copy, skipped };
}

export type ReorderResult =
  | { ok: true; order: OrderRow; skipped: string[]; deduped: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'INVALID_FROM_STATE' | 'NOTHING_TO_REORDER' };

export async function reorder(deps: Deps, user: UserRow, sourceOrderId: string, requestedDeliveryAt: string | null): Promise<ReorderResult> {
  const source = await deps.repo.getOrder(sourceOrderId);
  // Another customer's order is indistinguishable from a missing one (no IDOR oracle).
  if (!source || source.user_id !== user.id) return { ok: false, reason: 'NOT_FOUND' };
  if (source.status !== 'DELIVERED') return { ok: false, reason: 'INVALID_FROM_STATE' };

  const [items, products] = await Promise.all([deps.repo.getItems(source.id), deps.repo.listActiveProducts()]);
  const { copy, skipped } = reorderableItems(items, products);
  if (!copy.length) return { ok: false, reason: 'NOTHING_TO_REORDER' };

  // Double tap / reopened page: an unconfirmed reorder of the same order is returned, not duplicated.
  const drafts = await deps.repo.listOpenOrders({ userId: user.id, statuses: ['AWAITING_CONFIRMATION'] });
  const existing = drafts.find((o) => o.source_order_id === source.id);
  if (existing) {
    await deps.repo.setActiveOrder(user.id, existing.id);
    return { ok: true, order: existing, skipped, deduped: true };
  }

  const order = await deps.repo.createOrder(
    {
      user_id: user.id,
      raw_order_text: th.reorderRawText(source.code),
      ai_parse: null,
      // Something from last time couldn't be copied: the owner should see that before quoting.
      needs_owner_review: skipped.length > 0,
      channel: 'liff',
      source_order_id: source.id,
      requested_delivery_at: requestedDeliveryAt,
    },
    copy,
  );
  await deps.repo.setActiveOrder(user.id, order.id);
  await logEvent(deps, order, 'customer', 'ORDER_CREATED', {
    intent: 'reorder',
    via: 'liff_reorder',
    sourceOrderId: source.id,
    skippedCount: skipped.length,
    ...(skipped.length ? { reviewReasons: ['reorder_items_skipped'] } : {}),
  });
  return { ok: true, order, skipped, deduped: false };
}

export type ConfirmResult = ApplyResult | { ok: false; reason: 'NO_ITEMS'; order: OrderRow };

/** LIFF "ยืนยันรายการ": same rule as the chat confirm button (needs items, no open questions). */
export async function confirmFromLiff(deps: Deps, user: UserRow, order: OrderRow): Promise<ConfirmResult> {
  const items = await deps.repo.getItems(order.id);
  const parse = order.ai_parse as { missing_fields?: string[] } | null;
  if (!items.length || (parse?.missing_fields?.length ?? 0) > 0) return { ok: false, reason: 'NO_ITEMS', order };
  const res = await applyEvent(deps, order, 'CUSTOMER_CONFIRM', 'customer');
  if (res.ok) await deps.repo.setActiveOrder(user.id, order.id);
  return res;
}

export type AddressResult =
  | { ok: true; order: OrderRow; submitted: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'INVALID_FROM_STATE' | 'VERSION_CONFLICT' | 'WRONG_ACTOR'; order: OrderRow };

/**
 * LIFF "ส่งที่อยู่เดิม": attach one of the customer's own saved addresses. Like a chat location:
 * with a recipient (address or profile) the order goes to the shop (LOCATION_SET, owner alerted);
 * without one it is held for the RecipientCard.
 */
export async function setOrderAddress(deps: Deps, user: UserRow, order: OrderRow, addressId: string): Promise<AddressResult> {
  const address = await deps.repo.getAddress(addressId);
  if (!address || address.user_id !== user.id) return { ok: false, reason: 'NOT_FOUND', order };
  if (order.status !== 'AWAITING_LOCATION') return { ok: false, reason: 'INVALID_FROM_STATE', order };

  const name = address.recipient_name?.trim() ? address.recipient_name : profileHasRecipient(user) ? user.full_name : null;
  const phone = address.recipient_phone?.trim() ? address.recipient_phone : profileHasRecipient(user) ? user.phone : null;
  if (!name || !phone) {
    const held = await patchOrder(deps, order, { address_id: address.id });
    if (!held) return { ok: false, reason: 'VERSION_CONFLICT', order };
    await logEvent(deps, held, 'customer', 'ADDRESS_REUSED', { submitted: false });
    return { ok: true, order: held, submitted: false };
  }
  const res = await completeLocation(deps, order, { address_id: address.id, recipient_name: name, recipient_phone: phone });
  if (!res.ok) return res;
  await logEvent(deps, res.order, 'customer', 'ADDRESS_REUSED', { submitted: true });
  return { ok: true, order: res.order, submitted: true };
}

/** The address the order room offers to reuse: the reordered order's own address, if it is still this user's. */
export async function reuseAddressFor(deps: Deps, order: OrderRow): Promise<{ id: string; addressText: string | null } | null> {
  if (order.status !== 'AWAITING_LOCATION' || order.address_id || !order.source_order_id) return null;
  const source = await deps.repo.getOrder(order.source_order_id);
  if (!source?.address_id || source.user_id !== order.user_id) return null;
  const address = await deps.repo.getAddress(source.address_id);
  if (!address || address.user_id !== order.user_id) return null;
  return { id: address.id, addressText: address.address_text };
}
