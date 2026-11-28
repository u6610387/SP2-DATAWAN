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

/** Data a price suggestion needs, already fetched (one order, or a whole list in batch). */
export interface PriceInputs {
  /** Cost per unit (satang): latest in the last 3 days, else last known; null = unknown. */
  unitCost: (productId: string) => number | null;
  /** The customer's latest sell price per unit in the last 30 days; only asked for a VERIFIED B2B customer. */
  sellUnitPrice: (productId: string) => number | null;
  /** True only when the customer's business profile is VERIFIED (and user_type is B2B). */
  verifiedB2b: boolean;
}

/** Pure suggestion math (PROJECT_SPEC §4.1–4.2): same result for the single-order and the list path. */
export function suggestFrom(items: OrderItemRow[], inputs: PriceInputs, markup: number): PriceSuggestion {
  const costs = items.map((it) => {
    const unit = it.product_id ? inputs.unitCost(it.product_id) : null;
    return unit === null ? null : lineAmount(unit, it.actual_qty ?? it.qty);
  });
  const cost = costs.length > 0 && costs.every((c) => c !== null) ? costs.reduce<number>((a, c) => a + (c ?? 0), 0) : null;
  let anchor: number | null = null;
  if (inputs.verifiedB2b) {
    let sum = 0;
    let all = items.length > 0;
    for (const it of items) {
      const p = it.product_id ? inputs.sellUnitPrice(it.product_id) : null;
      if (p === null) all = false;
      else sum += lineAmount(p, it.qty);
    }
    anchor = all ? sum : null;
  }
  return { costSatang: cost, suggestedSatang: cost === null ? null : suggestedPrice(cost, markup), b2bAnchorSatang: anchor };
}

export const COST_RECENT_DAYS = 3;
export const B2B_ANCHOR_DAYS = 30;
export const sinceDays = (deps: Pick<Deps, 'now'>, days: number) => new Date(deps.now().getTime() - days * DAY).toISOString();

export async function suggestPrice(deps: Deps, order: Pick<OrderRow, 'user_id'>, items: OrderItemRow[]): Promise<PriceSuggestion> {
  const productIds = [...new Set(items.map((i) => i.product_id).filter((x): x is string => !!x))];
  const recent = sinceDays(deps, COST_RECENT_DAYS);
  const unitCosts = new Map<string, number | null>();
  for (const id of productIds) unitCosts.set(id, (await deps.repo.latestUnitCost(id, recent)) ?? (await deps.repo.latestUnitCost(id)));
  const user = await deps.repo.getUser(order.user_id);
  // Both checks: a stale user_type alone must never leak the anchor (owner-verified status is the truth).
  const profile = user?.user_type === 'B2B' ? await deps.repo.getBusinessProfile(user.id) : null;
  const verifiedB2b = Boolean(user && profile?.status === 'VERIFIED');
  const sell = new Map<string, number | null>();
  if (verifiedB2b) {
    const since = sinceDays(deps, B2B_ANCHOR_DAYS);
    for (const id of productIds) sell.set(id, await deps.repo.lastSellUnitPrice(user!.id, id, since));
  }
  return suggestFrom(items, { unitCost: (id) => unitCosts.get(id) ?? null, sellUnitPrice: (id) => sell.get(id) ?? null, verifiedB2b }, deps.cfg.DEFAULT_MARKUP);
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
