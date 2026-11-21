/**
 * Deterministic pricing math (PROJECT_SPEC §4.1–4.2). Never AI.
 */
import { computeMargin, lineAmount, suggestedPrice, type Margin, type OrderItemRow, type OrderRow } from '@datawan/shared';
import type { Deps } from '../deps';

const DAY = 86_400_000;

/** Snapshot cost per item: latest stock-in cost in the last 3 days, else last known. */
export async function costItems(deps: Deps, items: OrderItemRow[]): Promise<{ id: string; cost_satang: number | null }[]> {
  const since = new Date(deps.now().getTime() - 3 * DAY).toISOString();
  return Promise.all(
    items.map(async (it) => {
      if (!it.product_id) return { id: it.id, cost_satang: null };
      const unit = (await deps.repo.latestUnitCost(it.product_id, since)) ?? (await deps.repo.latestUnitCost(it.product_id));
      return { id: it.id, cost_satang: unit === null ? null : lineAmount(unit, it.actual_qty ?? it.qty) };
    }),
  );
}

export interface PriceSuggestion {
  costSatang: number | null;
  suggestedSatang: number | null;
  b2bAnchorSatang: number | null;
}

export async function suggestPrice(deps: Deps, order: Pick<OrderRow, 'user_id'>, items: OrderItemRow[]): Promise<PriceSuggestion> {
  const costs = await costItems(deps, items);
  const known = costs.every((c) => c.cost_satang !== null) && costs.length > 0;
  const cost = known ? costs.reduce((a, c) => a + (c.cost_satang ?? 0), 0) : null;
  const user = await deps.repo.getUser(order.user_id);
  let anchor: number | null = null;
  if (user?.user_type === 'B2B') {
    const since = new Date(deps.now().getTime() - 30 * DAY).toISOString();
    let sum = 0;
    let all = items.length > 0;
    for (const it of items) {
      const p = it.product_id ? await deps.repo.lastSellUnitPrice(user.id, it.product_id, since) : null;
      if (p === null) all = false;
      else sum += lineAmount(p, it.qty);
    }
    anchor = all ? sum : null;
  }
  return { costSatang: cost, suggestedSatang: cost === null ? null : suggestedPrice(cost, deps.cfg.DEFAULT_MARKUP), b2bAnchorSatang: anchor };
}

export function marginFor(offerSatang: number, items: Pick<OrderItemRow, 'cost_satang'>[]): Margin {
  return computeMargin(offerSatang, items.map((i) => i.cost_satang));
}

/**
 * Split a lump-sum product price across items for price_history (B2B anchoring).
 * Proportional to cost when all costs are known; otherwise only for single-item orders.
 */
export function allocateUnitPrices(priceSatang: number, items: OrderItemRow[]): { item: OrderItemRow; unitSatang: number }[] {
  const qty = (i: OrderItemRow) => i.actual_qty ?? i.qty;
  if (items.length === 1) return [{ item: items[0]!, unitSatang: Math.round(priceSatang / qty(items[0]!)) }];
  if (items.length === 0 || items.some((i) => i.cost_satang === null || i.cost_satang === 0)) return [];
  const totalCost = items.reduce((a, i) => a + (i.cost_satang ?? 0), 0);
  return items.map((i) => ({ item: i, unitSatang: Math.round(((priceSatang * (i.cost_satang ?? 0)) / totalCost) / qty(i)) }));
}
