/**
 * Every order status change goes through applyEvent(): state machine check → optimistic
 * update (version) → audit row (order_events) → realtime ping. No raw status updates elsewhere.
 */
import { transition, type EventActor, type OrderEvent, type OrderPatch, type OrderRow } from '@datawan/shared';
import type { Deps } from '../deps';

export type ApplyResult =
  | { ok: true; order: OrderRow }
  | { ok: false; reason: 'INVALID_FROM_STATE' | 'WRONG_ACTOR' | 'VERSION_CONFLICT'; order: OrderRow };

export async function applyEvent(
  deps: Deps,
  order: OrderRow,
  event: OrderEvent,
  actor: EventActor,
  patch: OrderPatch = {},
  payload: Record<string, unknown> | null = null,
): Promise<ApplyResult> {
  const t = transition(order.status, event, actor);
  if (!t.ok) return { ok: false, reason: t.reason, order };
  const updated = await deps.repo.updateOrder(order.id, order.version, { ...patch, status: t.to });
  if (!updated) return { ok: false, reason: 'VERSION_CONFLICT', order };
  await deps.repo.insertEvent({ order_id: order.id, actor, event, from_status: t.from, to_status: t.to, payload });
  await deps.realtime.orderUpdated(updated);
  return { ok: true, order: updated };
}

/** Non-status update (e.g. owner_reminded_at). Still versioned + broadcast. */
export async function patchOrder(deps: Deps, order: OrderRow, patch: OrderPatch): Promise<OrderRow | null> {
  if ('status' in patch) throw new Error('use applyEvent() to change status');
  const updated = await deps.repo.updateOrder(order.id, order.version, patch);
  if (updated) await deps.realtime.orderUpdated(updated);
  return updated;
}

export async function logEvent(deps: Deps, order: OrderRow, actor: EventActor, event: string, payload: Record<string, unknown> | null = null) {
  return deps.repo.insertEvent({ order_id: order.id, actor, event, payload });
}

/** The order chat input should go to: users.active_order_id if still open, else newest open order. */
export async function resolveActiveOrder(deps: Deps, userId: string, activeOrderId: string | null): Promise<{ active: OrderRow | null; open: OrderRow[] }> {
  const open = await deps.repo.listOpenOrders({ userId });
  const active = open.find((o) => o.id === activeOrderId) ?? open[0] ?? null;
  return { active, open };
}
