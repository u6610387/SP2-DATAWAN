/**
 * Background timers (Cron every minute). They only move orders into waiting / locked /
 * pre-payment-cancelled states — never past payment (seafood-domain-rules §1).
 * Customer-facing effects use LIFF Realtime only: NO LINE push (PROJECT_SPEC §6.3).
 */
import type { Deps } from '../deps';
import { applyEvent, patchOrder } from '../services/orders';

/** Shared by the timers of one cron run: how many more orders this run may act on. */
export interface ActionBudget {
  left: number;
}
/** Takes one action from the budget; false = stop, the next minute picks the rest up. */
function take(budget: ActionBudget | undefined): boolean {
  if (!budget) return true;
  if (budget.left <= 0) return false;
  budget.left--;
  return true;
}

const minutesAgo = (deps: Deps, m: number) => new Date(deps.now().getTime() - m * 60_000).toISOString();

/** 15 min without a price → remind owner (Web Push) and flag LIFF reassurance. */
export async function runOwnerReminders(deps: Deps, budget?: ActionBudget): Promise<number> {
  const cutoff = minutesAgo(deps, deps.cfg.OWNER_REMINDER_MINUTES);
  const waiting = await deps.repo.listOpenOrders({ statuses: ['AWAITING_PRICE'] });
  let n = 0;
  for (const o of waiting) {
    if (o.owner_reminded_at || o.updated_at > cutoff) continue;
    if (!take(budget)) break;
    const updated = await patchOrder(deps, o, { owner_reminded_at: deps.now().toISOString() });
    if (!updated) continue;
    await deps.repo.insertEvent({ order_id: o.id, actor: 'system', event: 'OWNER_REMINDED', payload: null });
    await deps.notifier.notify({ kind: 'OWNER_TIMEOUT', orderId: o.id, code: o.code, minutes: deps.cfg.OWNER_REMINDER_MINUTES });
    n++;
  }
  return n;
}

/** Payment window passed → lock (PAYMENT_EXPIRED). Owner re-confirms shipping to reopen. */
export async function runPaymentExpiry(deps: Deps, budget?: ActionBudget): Promise<number> {
  const now = deps.now().toISOString();
  const pending = await deps.repo.listOpenOrders({ statuses: ['AWAITING_PAYMENT'] });
  let n = 0;
  for (const o of pending) {
    if (!o.payment_expires_at || o.payment_expires_at > now) continue;
    if (!take(budget)) break;
    const res = await applyEvent(deps, o, 'PAYMENT_TIMEOUT', 'system');
    if (!res.ok) continue;
    await deps.notifier.notify({ kind: 'PAYMENT_EXPIRED', orderId: o.id, code: o.code });
    n++;
  }
  return n;
}

/** 24 h idle before payment (and not waiting on the owner) → cancel. No money involved. */
export async function runAbandonment(deps: Deps, budget?: ActionBudget): Promise<number> {
  const cutoff = minutesAgo(deps, deps.cfg.ABANDON_HOURS * 60);
  const idle = await deps.repo.listOpenOrders({ statuses: ['AWAITING_CONFIRMATION', 'AWAITING_LOCATION', 'PRICE_QUOTED', 'PAYMENT_EXPIRED'] });
  let n = 0;
  for (const o of idle) {
    if (o.updated_at > cutoff) continue;
    if (!take(budget)) break;
    const res = await applyEvent(deps, o, 'ABANDON_TIMEOUT', 'system', { cancelled_at: deps.now().toISOString(), cancel_reason: 'abandoned' });
    if (!res.ok) continue;
    const user = await deps.repo.getUser(o.user_id);
    if (user?.active_order_id === o.id) await deps.repo.setActiveOrder(user.id, null);
    n++;
  }
  return n;
}
