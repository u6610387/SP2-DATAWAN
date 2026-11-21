/**
 * Data-access interface. Handlers/services depend on this, never on supabase-js directly,
 * so tests run on the in-memory implementation (repo.memory.ts) and production on
 * Supabase (repo.supabase.ts).
 */
import type {
  AddressRow,
  NegotiationRow,
  OrderEventRow,
  OrderItemRow,
  OrderPatch,
  OrderRow,
  OrderStatus,
  PaymentRow,
  PrepType,
  PriceHistoryRow,
  ProductRow,
  ProductStockRow,
  PushSubscriptionRow,
  QuotaLogRow,
  StockLogRow,
  UserRow,
} from '@datawan/shared';

export interface NewOrder {
  user_id: string;
  raw_order_text: string | null;
  ai_parse: unknown;
  needs_owner_review: boolean;
  channel: 'chat' | 'liff';
  source_order_id?: string | null;
  requested_delivery_at?: string | null;
}

export interface NewOrderItem {
  product_id: string | null;
  raw_text: string;
  qty: number;
  unit: string;
  prep_type: PrepType;
  note: string | null;
}

type Insert<T, Auto extends keyof T> = Omit<T, Auto> & Partial<Pick<T, Auto>>;

export type NewAddress = Insert<AddressRow, 'id' | 'created_at' | 'label' | 'is_default'>;
export type NewNegotiation = Insert<NegotiationRow, 'id' | 'created_at'>;
export type NewPayment = Insert<PaymentRow, 'id' | 'created_at' | 'confirmed_by' | 'confirmed_at' | 'override_reason'>;
export type PaymentPatch = Partial<Omit<PaymentRow, 'id' | 'order_id' | 'created_at'>>;
export type NewStockLog = Insert<StockLogRow, 'id' | 'created_at' | 'supplier_bill_id' | 'unit_cost_satang' | 'note'>;
export type NewPriceHistory = Insert<PriceHistoryRow, 'id' | 'recorded_at' | 'supplier_bill_id'>;
export type NewQuotaLog = Insert<QuotaLogRow, 'id' | 'checked_at'>;
export type NewOrderEvent = Insert<OrderEventRow, 'id' | 'created_at' | 'from_status' | 'to_status' | 'payload'>;
export type NewPushSubscription = Insert<PushSubscriptionRow, 'id' | 'created_at' | 'user_agent'>;

export interface Repo {
  /** Returns true the first time a webhookEventId is seen (dedupe). */
  markLineEvent(webhookEventId: string): Promise<boolean>;

  upsertUserByLineId(lineUserId: string, displayName?: string | null): Promise<UserRow>;
  getUser(id: string): Promise<UserRow | null>;
  setActiveOrder(userId: string, orderId: string | null): Promise<void>;
  markUserInactive(userId: string): Promise<void>;

  listActiveProducts(): Promise<ProductRow[]>;

  createOrder(order: NewOrder, items: NewOrderItem[]): Promise<OrderRow>;
  getOrder(id: string): Promise<OrderRow | null>;
  getOpenOrderByCode(code: string): Promise<OrderRow | null>;
  /** Non-final orders, newest first. */
  listOpenOrders(filter?: { userId?: string; statuses?: OrderStatus[] }): Promise<OrderRow[]>;
  /** Most recent DELIVERED order (B2B reorder). */
  lastDeliveredOrder(userId: string): Promise<OrderRow | null>;
  /** DELIVERED orders with delivered_at >= sinceIso (Today's Sales Summary). */
  listDeliveredSince(sinceIso: string): Promise<OrderRow[]>;
  /** Optimistic update: returns null when `expectedVersion` is stale. Bumps version. */
  updateOrder(id: string, expectedVersion: number, patch: OrderPatch): Promise<OrderRow | null>;

  getItems(orderId: string): Promise<OrderItemRow[]>;
  replaceItems(orderId: string, items: NewOrderItem[]): Promise<OrderItemRow[]>;
  updateItemCosts(updates: { id: string; cost_satang: number | null }[]): Promise<void>;
  updateItemActualQty(updates: { id: string; actual_qty: number }[]): Promise<void>;
  /** LIFF presence heartbeat: touches customer_last_seen_at only, no version/broadcast (ARCHITECTURE_AND_DB §1.3). */
  touchCustomerLastSeen(orderId: string, nowIso: string): Promise<void>;

  insertAddress(a: NewAddress): Promise<AddressRow>;
  getAddress(id: string): Promise<AddressRow | null>;

  listNegotiations(orderId: string): Promise<NegotiationRow[]>;
  insertNegotiation(n: NewNegotiation): Promise<NegotiationRow>;

  insertPayment(p: NewPayment): Promise<PaymentRow>;
  getPayment(id: string): Promise<PaymentRow | null>;
  latestPayment(orderId: string): Promise<PaymentRow | null>;
  updatePayment(id: string, patch: PaymentPatch): Promise<PaymentRow>;
  referenceExists(referenceNo: string): Promise<boolean>;

  /** Latest cost-per-unit (satang) from price_history kind='cost', optionally only since a date. */
  latestUnitCost(productId: string, sinceIso?: string): Promise<number | null>;
  /** Latest sell price per unit this customer paid (B2B anchor). */
  lastSellUnitPrice(userId: string, productId: string, sinceIso: string): Promise<number | null>;

  insertStockLogs(rows: NewStockLog[]): Promise<void>;
  /** Single stock-log insert that returns the created row (owner manual stock-in/adjust). */
  insertStockLog(row: NewStockLog): Promise<StockLogRow>;
  insertPriceHistory(rows: NewPriceHistory[]): Promise<void>;
  /** product_stock view: on-hand quantity per active product. */
  listProductStock(): Promise<ProductStockRow[]>;

  upsertPushSubscription(sub: NewPushSubscription): Promise<PushSubscriptionRow>;
  listPushSubscriptions(): Promise<PushSubscriptionRow[]>;
  deletePushSubscription(endpoint: string): Promise<void>;

  latestQuotaLog(month: string): Promise<QuotaLogRow | null>;
  insertQuotaLog(row: NewQuotaLog): Promise<QuotaLogRow>;

  insertEvent(e: NewOrderEvent): Promise<OrderEventRow>;
  getEvent(id: string): Promise<OrderEventRow | null>;
  countEventsSince(event: string, sinceIso: string): Promise<number>;
}
