/**
 * Zero-token info keywords: exact-match chat commands answered from the database by code.
 * They never call the AI parser, never touch an order, and answer by reply (free), never push.
 * Only the whole message counts (optionally with a polite particle), so a sentence that merely
 * contains a keyword ("ดูรายการสินค้าหน่อย", "วิธีสั่งซื้อกุ้ง 2 โล") still goes to the normal order flow.
 */
import { formatTHB, th, type OrderRow, type UserRow } from '@datawan/shared';
import type { Deps } from '../deps';
import * as flex from '../line/flex';

export type InfoCommand = 'catalog' | 'delivery' | 'orderLink' | 'howTo' | 'payment';

const PARTICLE = '(?:\\s*(?:นะ)?(?:ค่ะ|คะ|ครับ|คับ|จ้า|จ้ะ))?';
const LINK = 'ลิ(?:้)?ง(?:ก์|ค์|ก)';
const COMMANDS: [InfoCommand, RegExp][] = [
  ['catalog', new RegExp(`^ดู\\s*รายการ\\s*สินค้า${PARTICLE}$`)],
  ['delivery', new RegExp(`^(?:เช็[คก]\\s*สถานะ\\s*(?:การ)?จัดส่ง|ขอ\\s*${LINK}\\s*lalamove)${PARTICLE}$`, 'i')],
  ['orderLink', new RegExp(`^ขอ\\s*${LINK}\\s*ออเดอร์${PARTICLE}$`)],
  ['howTo', new RegExp(`^วิธี\\s*สั่ง\\s*ซื้อ${PARTICLE}$`)],
  ['payment', new RegExp(`^ช่องทาง\\s*(?:การ)?ชำระ\\s*เงิน${PARTICLE}$`)],
];

/** Orders a delivery question is really about: paid or on the way, one with a tracking link first. */
export function shippingOrder(open: OrderRow[]): OrderRow | null {
  const shipping = open.filter((o) => o.status === 'DELIVERING' || o.status === 'PAID');
  return shipping.find((o) => o.tracking_url) ?? shipping[0] ?? null;
}

/** The command a whole message asks for, or null for anything else (normal flow). */
export function matchInfoCommand(text: string): InfoCommand | null {
  const t = text.trim().replace(/\s+/g, ' ');
  for (const [kind, re] of COMMANDS) if (re.test(t)) return kind;
  return null;
}

/** LINE text messages are capped at 5000 characters; keep well under it. */
const MAX_CHARS = 4500;

async function catalogText(deps: Deps): Promise<string> {
  const [products, categories] = await Promise.all([deps.repo.listActiveProducts(), deps.repo.listActiveCategories()]);
  if (products.length === 0) return th.info.catalogEmpty;
  const byName = (a: { name_th: string }, b: { name_th: string }) => a.name_th.localeCompare(b.name_th, 'th');
  const groups = categories
    .map((c) => ({ name: c.name_th, items: products.filter((p) => p.category_id === c.id).sort(byName) }))
    .filter((g) => g.items.length > 0);
  const known = new Set(categories.map((c) => c.id));
  const other = products.filter((p) => !p.category_id || !known.has(p.category_id)).sort(byName);
  if (other.length) groups.push({ name: th.info.catalogOther, items: other });

  const lines = [th.info.catalogTitle];
  let shown = 0;
  for (const g of groups) {
    const block = ['', g.name, ...g.items.map((p) => `• ${p.name_th} (${th.units[p.unit] ?? p.unit})`)];
    if ([...lines, ...block].join('\n').length > MAX_CHARS) break;
    lines.push(...block);
    shown += g.items.length;
  }
  if (shown < products.length) lines.push('', th.info.catalogMore(products.length - shown));
  lines.push('', th.info.catalogFooter);
  return lines.join('\n');
}

/**
 * Delivery question with nothing paid or on the way (those get the tracking reply in customer.ts):
 * the newest open order, else the last delivered one. Cancelled orders are never open.
 */
async function deliveryOrder(deps: Deps, open: OrderRow[], userId: string): Promise<OrderRow | null> {
  return open[0] ?? (await deps.repo.lastDeliveredOrder(userId));
}

function deliveryText(order: OrderRow): string {
  const lines = [th.info.orderLine(order.code), th.info.statusLine(th.status[order.status])];
  if (order.total_satang !== null) lines.push(th.info.totalLine(formatTHB(order.total_satang)));
  else if (order.product_price_satang !== null) lines.push(th.info.productPriceLine(formatTHB(order.product_price_satang)));
  else lines.push(th.info.notPriced);
  if (order.tracking_url) lines.push(th.info.trackingLine(order.tracking_url));
  else lines.push(order.status === 'DELIVERED' ? th.info.deliveredNoLink : th.info.notBooked);
  return lines.join('\n');
}

/**
 * The reply text for an info command. `open` / `active` come from resolveActiveOrder (newest
 * first), so this adds at most one query (catalog, or the last delivered order).
 */
export async function infoReplyText(
  deps: Deps,
  user: UserRow,
  cmd: InfoCommand,
  orders: { open: OrderRow[]; active: OrderRow | null },
): Promise<string> {
  switch (cmd) {
    case 'catalog':
      return catalogText(deps);
    case 'delivery': {
      const order = await deliveryOrder(deps, orders.open, user.id);
      return order ? deliveryText(order) : th.info.noOrder;
    }
    case 'orderLink': {
      const order = orders.active ?? orders.open[0] ?? null;
      return order ? th.info.orderLink(order.code, flex.orderLiffUrl(deps.cfg.LIFF_ID, order.id)) : th.noOpenOrder;
    }
    case 'howTo':
      return th.info.howTo;
    case 'payment':
      return th.info.payment;
  }
}
