/**
 * Owner board list (GET /api/owner/orders) built from a fixed number of batch queries.
 *
 * Every Supabase call from the Worker is a subrequest, and Workers Free allows 50 per request.
 * Building each order's view on its own cost ~10 calls per order, so 5 open orders returned
 * 500 "Too many subrequests" (production, 2026-11-28). Here the count doesn't grow with the
 * number of orders: ~11 repo calls for 1 order or for 100. Values match the single-order view
 * (same toOwnerOrderView + suggestFrom); only the slip image URL is left to the detail page,
 * because signing it is one Storage call per slip.
 */
import type { OrderEventRow, OrderRow, OwnerOrderView } from '@datawan/shared';
import type { Deps } from '../deps';
import { B2B_ANCHOR_DAYS, COST_RECENT_DAYS, sinceDays, suggestFrom } from './pricing';
import { toOwnerOrderView } from './views';

/** Outcome of the tracking-link push, from the order's push events (newest first). */
export function trackingPushFrom(order: Pick<OrderRow, 'tracking_url'>, pushEvents: OrderEventRow[]): OwnerOrderView['trackingPush'] {
  if (!order.tracking_url) return null;
  const ev = pushEvents.find((e) => (e.payload as { why?: string } | null)?.why === 'TRACKING_LINK');
  if (!ev) return null;
  return { sent: ev.event === 'PUSH_SENT', reason: ev.event === 'PUSH_SENT' ? null : ((ev.payload as { reason?: string }).reason ?? null) };
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

export async function buildOwnerListViews(deps: Deps, orders: OrderRow[]): Promise<OwnerOrderView[]> {
  if (!orders.length) return [];
  const orderIds = orders.map((o) => o.id);
  const userIds = [...new Set(orders.map((o) => o.user_id))];
  const addressIds = [...new Set(orders.map((o) => o.address_id).filter((x): x is string => !!x))];

  const [items, products, negotiations, users, payments, profiles, addresses, pushEvents] = await Promise.all([
    deps.repo.getItemsForOrders(orderIds),
    deps.repo.listActiveProducts(),
    deps.repo.listNegotiationsForOrders(orderIds),
    deps.repo.getUsers(userIds),
    deps.repo.latestPaymentsForOrders(orderIds),
    deps.repo.getBusinessProfiles(userIds),
    deps.repo.getAddresses(addressIds),
    deps.repo.listPushEventsForOrders(orderIds),
  ]);

  const usersById = new Map(users.map((u) => [u.id, u]));
  const profilesByUser = new Map(profiles.map((p) => [p.user_id, p]));
  // Same rule as suggestPrice: user_type B2B AND an owner-VERIFIED profile.
  const verified = new Set(users.filter((u) => u.user_type === 'B2B' && profilesByUser.get(u.id)?.status === 'VERIFIED').map((u) => u.id));

  const productIds = [...new Set(items.map((i) => i.product_id).filter((x): x is string => !!x))];
  const [recentCosts, sell] = await Promise.all([
    deps.repo.latestUnitCosts(productIds, sinceDays(deps, COST_RECENT_DAYS)),
    deps.repo.lastSellUnitPrices([...verified], productIds, sinceDays(deps, B2B_ANCHOR_DAYS)),
  ]);
  // Products with no cost in the last 3 days fall back to their last known cost (one query).
  const olderCosts = await deps.repo.latestUnitCosts(productIds.filter((id) => !recentCosts.has(id)));

  const itemsByOrder = groupBy(items, (i) => i.order_id);
  const negotiationsByOrder = groupBy(negotiations, (n) => n.order_id);
  const pushByOrder = groupBy(pushEvents, (e) => e.order_id);
  const paymentByOrder = new Map(payments.map((p) => [p.order_id, p]));
  const addressById = new Map(addresses.map((a) => [a.id, a]));

  return orders.map((order) => {
    const user = usersById.get(order.user_id);
    if (!user) throw new Error(`order ${order.id} has no user`);
    const orderItems = (itemsByOrder.get(order.id) ?? []).sort((a, b) => a.sort - b.sort);
    const s = suggestFrom(
      orderItems,
      {
        unitCost: (id) => recentCosts.get(id) ?? olderCosts.get(id) ?? null,
        sellUnitPrice: (id) => sell.get(`${user.id}:${id}`) ?? null,
        verifiedB2b: verified.has(user.id),
      },
      deps.cfg.DEFAULT_MARKUP,
    );
    const payment = paymentByOrder.get(order.id) ?? null;
    return toOwnerOrderView({
      order,
      items: orderItems,
      products,
      negotiations: (negotiationsByOrder.get(order.id) ?? []).sort((a, b) => a.round - b.round),
      address: order.address_id ? (addressById.get(order.address_id) ?? null) : null,
      user,
      b2bProfile: profilesByUser.get(user.id) ?? null,
      promptpayId: deps.cfg.PROMPTPAY_ID,
      costSatang: s.costSatang,
      suggestedPriceSatang: s.suggestedSatang,
      b2bAnchorPriceSatang: s.b2bAnchorSatang,
      latestPayment: payment,
      slipImageUrl: null,
      needsOwnerReview: order.needs_owner_review,
      pushCount: order.push_count,
      trackingPush: trackingPushFrom(order, pushByOrder.get(order.id) ?? []),
    });
  });
}
