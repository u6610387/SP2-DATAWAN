/**
 * In-memory Repo for tests and offline demos. Mirrors DB behaviour that the code relies on:
 * version bump, generated total_satang, order code assignment (0002), open-code uniqueness,
 * payments.reference_no uniqueness, and the PAID/DELIVERED guards.
 */
import { FINAL_STATUSES, type OrderRow, type ProductRow, type ProductStockRow, type PushSubscriptionRow, type UserRow } from '@datawan/shared';
import type { Repo } from './repo';

type Row = Record<string, unknown>;

export class MemoryRepo implements Repo {
  users: UserRow[] = [];
  products: ProductRow[] = [];
  orders: OrderRow[] = [];
  items: import('@datawan/shared').OrderItemRow[] = [];
  addresses: import('@datawan/shared').AddressRow[] = [];
  negotiations: import('@datawan/shared').NegotiationRow[] = [];
  payments: import('@datawan/shared').PaymentRow[] = [];
  stockLogs: import('@datawan/shared').StockLogRow[] = [];
  priceHistory: import('@datawan/shared').PriceHistoryRow[] = [];
  quotaLogs: import('@datawan/shared').QuotaLogRow[] = [];
  events: import('@datawan/shared').OrderEventRow[] = [];
  pushSubscriptions: PushSubscriptionRow[] = [];
  lineEvents = new Set<string>();
  private seq = 0;
  private tick = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private id(): string {
    return crypto.randomUUID();
  }
  /** Strictly increasing timestamps so "newest first" is stable within one test tick. */
  private ts(): string {
    return new Date(this.now().getTime() + this.tick++).toISOString();
  }

  async markLineEvent(id: string) {
    if (this.lineEvents.has(id)) return false;
    this.lineEvents.add(id);
    return true;
  }

  async upsertUserByLineId(lineUserId: string, displayName?: string | null) {
    let u = this.users.find((x) => x.line_user_id === lineUserId);
    if (!u) {
      const t = this.ts();
      u = {
        id: this.id(), line_user_id: lineUserId, display_name: displayName ?? null, full_name: null, phone: null,
        user_type: 'B2C', business_name: null, default_delivery_window: null, pdpa_consent_at: null,
        active_order_id: null, is_active: true, created_at: t, updated_at: t,
      };
      this.users.push(u);
    } else if (!u.is_active) {
      u.is_active = true;
    }
    return { ...u };
  }
  async getUser(id: string) {
    const u = this.users.find((x) => x.id === id);
    return u ? { ...u } : null;
  }
  async setActiveOrder(userId: string, orderId: string | null) {
    const u = this.users.find((x) => x.id === userId);
    if (u) u.active_order_id = orderId;
  }
  async updateUserContact(userId: string, patch: { full_name: string; phone: string; pdpa_consent_at?: string }) {
    const u = this.users.find((x) => x.id === userId);
    if (u) Object.assign(u, patch);
  }
  async markUserInactive(userId: string) {
    const u = this.users.find((x) => x.id === userId);
    if (u) u.is_active = false;
  }

  async listActiveProducts() {
    return this.products.filter((p) => p.is_active).map((p) => ({ ...p }));
  }

  private isOpen(o: OrderRow) {
    return !FINAL_STATUSES.includes(o.status);
  }
  private assignCode(orderNo: number): string {
    let n = orderNo % 1000;
    for (let i = 0; i < 1000; i++) {
      const code = `A${n}`;
      if (!this.orders.some((o) => this.isOpen(o) && o.code === code)) return code;
      n = (n + 1) % 1000;
    }
    throw new Error('no free order code');
  }

  async createOrder(order: import('./repo').NewOrder, items: import('./repo').NewOrderItem[]) {
    const t = this.ts();
    const orderNo = ++this.seq;
    const row: OrderRow = {
      id: this.id(), order_no: orderNo, code: this.assignCode(orderNo), user_id: order.user_id,
      address_id: null, recipient_name: null, recipient_phone: null, status: 'AWAITING_CONFIRMATION',
      channel: order.channel, source_order_id: order.source_order_id ?? null,
      requested_delivery_at: order.requested_delivery_at ?? null, raw_order_text: order.raw_order_text,
      ai_parse: order.ai_parse, needs_owner_review: order.needs_owner_review, product_price_satang: null,
      price_note: null, shipping_fee_satang: null, total_satang: null, quoted_at: null, payment_expires_at: null,
      paid_at: null, paid_confirmed_by: null, tracking_url: null, dispatched_at: null, delivered_at: null,
      cancelled_at: null, cancel_reason: null, owner_reminded_at: null, customer_last_seen_at: null, push_count: 0,
      realtime_token: crypto.randomUUID().replace(/-/g, ''), version: 1, created_at: t, updated_at: t,
    };
    this.orders.push(row);
    await this.replaceItems(row.id, items);
    return { ...row };
  }
  async getOrder(id: string) {
    const o = this.orders.find((x) => x.id === id);
    return o ? { ...o } : null;
  }
  async getOpenOrderByCode(code: string) {
    const o = this.orders.find((x) => this.isOpen(x) && x.code.toUpperCase() === code.toUpperCase());
    return o ? { ...o } : null;
  }
  async listOpenOrders(filter: { userId?: string; statuses?: import('@datawan/shared').OrderStatus[] } = {}) {
    return this.orders
      .filter((o) => this.isOpen(o) && (!filter.userId || o.user_id === filter.userId) && (!filter.statuses || filter.statuses.includes(o.status)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((o) => ({ ...o }));
  }
  async lastDeliveredOrder(userId: string) {
    const o = this.orders
      .filter((x) => x.user_id === userId && x.status === 'DELIVERED')
      .sort((a, b) => (b.delivered_at ?? '').localeCompare(a.delivered_at ?? ''))[0];
    return o ? { ...o } : null;
  }
  async listDeliveredSince(sinceIso: string) {
    return this.orders.filter((o) => o.status === 'DELIVERED' && (o.delivered_at ?? '') >= sinceIso).map((o) => ({ ...o }));
  }
  async updateOrder(id: string, expectedVersion: number, patch: import('@datawan/shared').OrderPatch) {
    const o = this.orders.find((x) => x.id === id);
    if (!o || o.version !== expectedVersion) return null;
    const next = { ...o, ...patch } as OrderRow;
    // DB guards (0001_init.sql)
    if (next.status === 'PAID' && !next.paid_confirmed_by) throw new Error('paid_needs_owner');
    if (next.status === 'DELIVERING' && !next.paid_confirmed_by) throw new Error('DELIVERING requires owner-confirmed payment');
    if (next.status === 'DELIVERED' && (!next.paid_confirmed_by || !next.dispatched_at)) throw new Error('DELIVERED guard');
    next.total_satang =
      next.product_price_satang !== null && next.shipping_fee_satang !== null ? next.product_price_satang + next.shipping_fee_satang : null;
    next.version = o.version + 1;
    next.updated_at = this.ts();
    Object.assign(o, next);
    return { ...o };
  }

  async getItems(orderId: string) {
    return this.items.filter((i) => i.order_id === orderId).sort((a, b) => a.sort - b.sort).map((i) => ({ ...i }));
  }
  async replaceItems(orderId: string, items: import('./repo').NewOrderItem[]) {
    this.items = this.items.filter((i) => i.order_id !== orderId);
    const rows = items.map((it, sort) => ({ id: this.id(), order_id: orderId, actual_qty: null, cost_satang: null, unit_price_satang: null, sort, ...it }));
    this.items.push(...rows);
    return rows.map((r) => ({ ...r }));
  }
  async updateItemCosts(updates: { id: string; cost_satang: number | null }[]) {
    for (const u of updates) {
      const it = this.items.find((i) => i.id === u.id);
      if (it) it.cost_satang = u.cost_satang;
    }
  }
  async updateItemActualQty(updates: { id: string; actual_qty: number }[]) {
    for (const u of updates) {
      const it = this.items.find((i) => i.id === u.id);
      if (it) it.actual_qty = u.actual_qty;
    }
  }
  async touchCustomerLastSeen(orderId: string, nowIso: string) {
    // Presence only: no version bump, mirroring bump_order_version() in 0004_presence_no_version_bump.sql.
    const o = this.orders.find((x) => x.id === orderId);
    if (o) o.customer_last_seen_at = nowIso;
  }

  async insertAddress(a: import('./repo').NewAddress) {
    const row = { id: this.id(), created_at: this.ts(), label: null, is_default: false, ...a };
    this.addresses.push(row);
    return { ...row };
  }
  async setAddressRecipient(id: string, patch: { recipient_name: string; recipient_phone: string }) {
    const a = this.addresses.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
  }
  async getAddress(id: string) {
    const a = this.addresses.find((x) => x.id === id);
    return a ? { ...a } : null;
  }

  async listNegotiations(orderId: string) {
    return this.negotiations.filter((n) => n.order_id === orderId).sort((a, b) => a.round - b.round).map((n) => ({ ...n }));
  }
  async insertNegotiation(n: import('./repo').NewNegotiation) {
    if (this.negotiations.some((x) => x.order_id === n.order_id && x.round === n.round)) throw new Error('duplicate negotiation round');
    const row = { id: this.id(), created_at: this.ts(), ...n };
    this.negotiations.push(row);
    return { ...row };
  }

  async insertPayment(p: import('./repo').NewPayment) {
    if (p.reference_no && this.payments.some((x) => x.reference_no === p.reference_no)) throw new Error('payments_reference_uidx');
    const row = { id: this.id(), created_at: this.ts(), confirmed_by: null, confirmed_at: null, override_reason: null, ...p };
    this.payments.push(row);
    return { ...row };
  }
  async getPayment(id: string) {
    const p = this.payments.find((x) => x.id === id);
    return p ? { ...p } : null;
  }
  async latestPayment(orderId: string) {
    const p = this.payments.filter((x) => x.order_id === orderId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return p ? { ...p } : null;
  }
  async updatePayment(id: string, patch: import('./repo').PaymentPatch) {
    const p = this.payments.find((x) => x.id === id);
    if (!p) throw new Error('payment not found');
    // DB guard (0001_init.sql payments_reference_uidx)
    if (patch.reference_no && this.payments.some((x) => x.id !== id && x.reference_no === patch.reference_no)) throw new Error('duplicate key value violates unique constraint "payments_reference_uidx"');
    Object.assign(p, patch);
    return { ...p };
  }
  async referenceExists(ref: string) {
    return this.payments.some((p) => p.reference_no === ref);
  }
  async findPaymentByReference(ref: string) {
    const p = this.payments.find((x) => x.reference_no === ref);
    return p ? { ...p } : null;
  }

  async latestUnitCost(productId: string, sinceIso?: string) {
    const r = this.priceHistory
      .filter((h) => h.product_id === productId && h.kind === 'cost' && (!sinceIso || h.recorded_at >= sinceIso))
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
    return r?.unit_price_satang ?? null;
  }
  async lastSellUnitPrice(userId: string, productId: string, sinceIso: string) {
    const r = this.priceHistory
      .filter((h) => h.user_id === userId && h.product_id === productId && h.kind === 'sell' && h.recorded_at >= sinceIso)
      .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
    return r?.unit_price_satang ?? null;
  }

  async insertStockLogs(rows: import('./repo').NewStockLog[]) {
    for (const r of rows) this.stockLogs.push({ id: this.id(), created_at: this.ts(), supplier_bill_id: null, unit_cost_satang: null, note: null, ...r });
  }
  async insertStockLog(row: import('./repo').NewStockLog) {
    const r = { id: this.id(), created_at: this.ts(), supplier_bill_id: null, unit_cost_satang: null, note: null, ...row };
    this.stockLogs.push(r);
    return { ...r };
  }
  async insertPriceHistory(rows: import('./repo').NewPriceHistory[]) {
    for (const r of rows) this.priceHistory.push({ id: this.id(), recorded_at: this.ts(), supplier_bill_id: null, ...r });
  }
  async listProductStock(): Promise<ProductStockRow[]> {
    return this.products.map((p) => ({
      product_id: p.id,
      name_th: p.name_th,
      unit: p.unit,
      on_hand: this.stockLogs.filter((s) => s.product_id === p.id).reduce((a, s) => a + s.qty_delta, 0),
    }));
  }

  async upsertPushSubscription(sub: import('./repo').NewPushSubscription) {
    const existing = this.pushSubscriptions.find((s) => s.endpoint === sub.endpoint);
    if (existing) {
      Object.assign(existing, sub);
      return { ...existing };
    }
    const row: PushSubscriptionRow = { id: this.id(), created_at: this.ts(), user_agent: null, ...sub };
    this.pushSubscriptions.push(row);
    return { ...row };
  }
  async listPushSubscriptions() {
    return this.pushSubscriptions.map((s) => ({ ...s }));
  }
  async deletePushSubscription(endpoint: string) {
    this.pushSubscriptions = this.pushSubscriptions.filter((s) => s.endpoint !== endpoint);
  }

  async latestQuotaLog(month: string) {
    const r = this.quotaLogs.filter((q) => q.month === month).sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
    return r ? { ...r } : null;
  }
  async insertQuotaLog(row: import('./repo').NewQuotaLog) {
    const r = { id: this.id(), checked_at: this.ts(), ...row };
    this.quotaLogs.push(r);
    return { ...r };
  }

  async insertEvent(e: import('./repo').NewOrderEvent) {
    const r = { id: this.id(), created_at: this.ts(), from_status: null, to_status: null, payload: null, ...e };
    this.events.push(r);
    return { ...r };
  }
  async listPushEvents(orderId: string) {
    return this.events
      .filter((e) => e.order_id === orderId && (e.event === 'PUSH_SENT' || e.event === 'PUSH_DEFERRED'))
      .map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.created_at.localeCompare(a.e.created_at) || b.i - a.i)
      .map(({ e }) => ({ ...e }));
  }
  async getEvent(id: string) {
    const e = this.events.find((x) => x.id === id);
    return e ? { ...e } : null;
  }
  async countEventsSince(event: string, sinceIso: string) {
    return this.events.filter((e) => e.event === event && e.created_at >= sinceIso).length;
  }

  // ---- test helpers ----
  seedProducts(rows: Omit<ProductRow, 'created_at' | 'updated_at' | 'is_active'>[]): void {
    const t = this.ts();
    for (const r of rows) this.products.push({ ...r, is_active: true, created_at: t, updated_at: t });
  }
  dump(): Row {
    return { orders: this.orders, items: this.items, events: this.events };
  }
}
