/** Attach product names to order items for display (LINE Flex and REST views alike). */
import type { OrderItemRow, ProductRow } from '@datawan/shared';

export function withNames(items: OrderItemRow[], products: ProductRow[]): (OrderItemRow & { name?: string })[] {
  const byId = new Map(products.map((p) => [p.id, p.name_th]));
  return items.map((it) => {
    const name = it.product_id ? byId.get(it.product_id) : undefined;
    return name ? { ...it, name } : it;
  });
}
