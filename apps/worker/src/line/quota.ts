/**
 * LINE Push Quota Guard — PROJECT_SPEC §7, seafood-domain-rules §4.
 * sendPushGuarded() is the ONLY function allowed to send a LINE push.
 */
import type { OrderRow, QuotaMode, QuotaStatus } from '@datawan/shared';
import type { Config } from '../env';
import type { Deps } from '../deps';
import { bangkokMonthStart, daysLeftInMonth, nextBangkokMonthStart, startOfBangkokDay } from '../util/time';
import type { LineMessage } from './api';
import { patchOrder } from '../services/orders';

export type PushPriority = 'P1' | 'P2';
export type DeferReason =
  | 'PRESENT' | 'QUOTA_SAVER' | 'WARNING_P2' | 'ORDER_CAP' | 'DAILY_BUDGET' | 'DAILY_RESERVE' | 'INACTIVE_USER' | 'ALREADY_SENT';

/**
 * The only pushes an order may use (one each, in lifecycle order): price quote, total to pay,
 * Lalamove dispatched. Everything else (counter, hold, owner notes) reaches the customer through
 * LIFF realtime and the free chat reply instead (CLAUDE.md §3.4, D2).
 */
export const LIFECYCLE_PUSHES = ['PRICE_READY', 'TOTAL_READY', 'TRACKING_LINK'] as const;
export type LifecyclePush = (typeof LIFECYCLE_PUSHES)[number];
/**
 * When quota is tight the money and delivery pushes win: the price quote is P2 (skipped at the
 * 80% warning and when today's budget is down to the reserve); total + tracking are P1.
 */
export const PUSH_PRIORITY: Readonly<Record<LifecyclePush, PushPriority>> = { PRICE_READY: 'P2', TOTAL_READY: 'P1', TRACKING_LINK: 'P1' };
/**
 * Pushed even while the customer's LIFF page is open: the payment card and the Lalamove link must
 * land in the LINE chat history (production A19: TRACKING_LINK deferred as PRESENT, never seen in
 * chat). Still once per order and still subject to Quota Saver and the daily budget.
 */
export const PUSH_EVEN_IF_PRESENT: ReadonlySet<LifecyclePush> = new Set(['TOTAL_READY', 'TRACKING_LINK']);

export function quotaMode(used: number, limit: number, cfg: Pick<Config, 'QUOTA_WARN_RATIO' | 'QUOTA_SAVER_RATIO'>): QuotaMode {
  if (limit <= 0) return 'NORMAL'; // 'none' type = unlimited (paid plans)
  if (used >= Math.floor(limit * cfg.QUOTA_SAVER_RATIO)) return 'QUOTA_SAVER';
  if (used >= Math.floor(limit * cfg.QUOTA_WARN_RATIO)) return 'WARNING';
  return 'NORMAL';
}

/** Daily pacing: spread what is left before Quota Saver over the remaining days (incl. today). */
export function dailyBudgetRemaining(args: { used: number; limit: number; saverRatio: number; pushesToday: number; daysLeft: number }): number {
  const ceiling = Math.floor(args.limit * args.saverRatio);
  const leftAtDayStart = Math.max(0, ceiling - (args.used - args.pushesToday));
  const todayBudget = Math.floor(leftAtDayStart / Math.max(1, args.daysLeft));
  return Math.max(0, todayBudget - args.pushesToday);
}

export interface PushDecisionInput {
  priority: PushPriority;
  /** This order already got a push for the same reason (re-quote, fee correction): never twice. */
  alreadySent: boolean;
  /** Today's pushes kept for P1 (total + tracking): a P2 push needs more than this left. */
  dailyReserve: number;
  /** PUSH_EVEN_IF_PRESENT: an open LIFF page doesn't hold this push back. */
  ignorePresence: boolean;
  customerPresent: boolean;
  customerActive: boolean;
  mode: QuotaMode;
  orderPushCount: number;
  maxPerOrder: number;
  dailyRemaining: number;
}

/** Pure decision — order matters: active → once per reason → presence → mode → per-order cap → daily budget → P1 reserve. */
export function decidePush(i: PushDecisionInput): { send: true } | { send: false; reason: DeferReason } {
  if (!i.customerActive) return { send: false, reason: 'INACTIVE_USER' };
  if (i.alreadySent) return { send: false, reason: 'ALREADY_SENT' };
  if (i.customerPresent && !i.ignorePresence) return { send: false, reason: 'PRESENT' };
  if (i.mode === 'QUOTA_SAVER') return { send: false, reason: 'QUOTA_SAVER' };
  if (i.mode === 'WARNING' && i.priority !== 'P1') return { send: false, reason: 'WARNING_P2' };
  if (i.orderPushCount >= i.maxPerOrder) return { send: false, reason: 'ORDER_CAP' };
  if (i.dailyRemaining <= 0) return { send: false, reason: 'DAILY_BUDGET' };
  if (i.priority === 'P2' && i.dailyRemaining <= i.dailyReserve) return { send: false, reason: 'DAILY_RESERVE' };
  return { send: true };
}

export async function getQuotaStatus(deps: Deps): Promise<QuotaStatus> {
  const now = deps.now();
  const month = bangkokMonthStart(now);
  const log = await deps.repo.latestQuotaLog(month);
  const limit = log?.limit_count ?? deps.cfg.LINE_PUSH_MONTHLY_LIMIT;
  const used = Math.max(log?.total_usage ?? 0, log?.local_count ?? 0);
  const pushesToday = await deps.repo.countEventsSince('PUSH_SENT', startOfBangkokDay(now).toISOString());
  return {
    month: month.slice(0, 7),
    limit,
    used,
    mode: quotaMode(used, limit, deps.cfg),
    dailyBudgetRemaining: dailyBudgetRemaining({ used, limit, saverRatio: deps.cfg.QUOTA_SAVER_RATIO, pushesToday, daysLeft: daysLeftInMonth(now) }),
    resetsAt: nextBangkokMonthStart(now).toISOString(),
  };
}

export function isCustomerPresent(order: Pick<OrderRow, 'customer_last_seen_at'>, now: Date, presenceSeconds: number): boolean {
  return !!order.customer_last_seen_at && now.getTime() - Date.parse(order.customer_last_seen_at) <= presenceSeconds * 1000;
}

export interface GuardedPushResult {
  sent: boolean;
  deferredReason?: DeferReason;
  /** The order after push_count was incremented (use this for further updates). */
  order: OrderRow;
}

export async function sendPushGuarded(
  deps: Deps,
  args: { order: OrderRow; messages: LineMessage[]; reason: LifecyclePush },
): Promise<GuardedPushResult> {
  const { order } = args;
  const priority = PUSH_PRIORITY[args.reason];
  const now = deps.now();
  const [user, status, pushEvents] = await Promise.all([
    deps.repo.getUser(order.user_id),
    getQuotaStatus(deps),
    deps.repo.listPushEvents(order.id),
  ]);
  const decision = decidePush({
    priority,
    alreadySent: pushEvents.some((e) => e.event === 'PUSH_SENT' && (e.payload as { why?: string } | null)?.why === args.reason),
    dailyReserve: deps.cfg.PUSH_DAILY_RESERVE_P1,
    ignorePresence: PUSH_EVEN_IF_PRESENT.has(args.reason),
    customerPresent: isCustomerPresent(order, now, deps.cfg.LIFF_PRESENCE_SECONDS),
    customerActive: !!user?.is_active,
    mode: status.mode,
    orderPushCount: order.push_count,
    maxPerOrder: deps.cfg.MAX_PUSH_PER_ORDER,
    dailyRemaining: status.dailyBudgetRemaining,
  });

  if (!decision.send || !user) {
    const reason = decision.send ? 'INACTIVE_USER' : decision.reason;
    await deps.repo.insertEvent({ order_id: order.id, actor: 'system', event: 'PUSH_DEFERRED', payload: { reason, why: args.reason, priority } });
    return { sent: false, deferredReason: reason, order };
  }

  await deps.line.unsafePush(user.line_user_id, args.messages);

  // Count it locally (LINE's consumption figure can lag).
  const month = bangkokMonthStart(now);
  const log = await deps.repo.latestQuotaLog(month);
  const localCount = (log?.local_count ?? 0) + 1;
  const totalUsage = log?.total_usage ?? 0;
  const limit = log?.limit_count ?? deps.cfg.LINE_PUSH_MONTHLY_LIMIT;
  await deps.repo.insertQuotaLog({
    month,
    limit_count: limit,
    total_usage: totalUsage,
    local_count: localCount,
    mode: quotaMode(Math.max(totalUsage, localCount), limit, deps.cfg),
  });
  await deps.repo.insertEvent({ order_id: order.id, actor: 'system', event: 'PUSH_SENT', payload: { why: args.reason, priority } });
  // Versioned + broadcast (patchOrder): push_count bumps orders.version, so LIFF must hear about it
  // or its next If-Match is stale (409 on the customer's next tap).
  const updated = (await patchOrder(deps, order, { push_count: order.push_count + 1 })) ?? order;
  return { sent: true, order: updated };
}

/** Cron: refresh LINE's own numbers into quota_logs; alert owner on threshold crossings. */
export async function refreshQuota(deps: Deps): Promise<QuotaStatus> {
  const now = deps.now();
  const month = bangkokMonthStart(now);
  const [quota, consumption, prev] = await Promise.all([deps.line.getQuota(), deps.line.getConsumption(), deps.repo.latestQuotaLog(month)]);
  const limit = quota.type === 'limited' && quota.value ? quota.value : quota.type === 'none' ? 0 : deps.cfg.LINE_PUSH_MONTHLY_LIMIT;
  const local = prev?.local_count ?? 0;
  const used = Math.max(consumption.totalUsage, local);
  const mode = quotaMode(used, limit, deps.cfg);
  await deps.repo.insertQuotaLog({ month, limit_count: limit, total_usage: consumption.totalUsage, local_count: local, mode });
  if (prev && prev.mode !== mode && mode !== 'NORMAL') await deps.notifier.notify({ kind: 'QUOTA_WARNING', used, limit, mode });
  return getQuotaStatus(deps);
}
