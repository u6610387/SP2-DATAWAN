/**
 * Row types mirroring supabase/migrations/0001_init.sql (+0002).
 * Keep in sync with the migration; money columns are integer satang.
 */

export const ORDER_STATUSES = [
  'AWAITING_CONFIRMATION',
  'AWAITING_LOCATION',
  'AWAITING_PRICE',
  'PRICE_QUOTED',
  'NEGOTIATING',
  'AWAITING_SHIPPING_FEE',
  'AWAITING_PAYMENT',
  'PAYMENT_EXPIRED',
  'PAYMENT_REVIEW',
  'PAID',
  'DELIVERING',
  'DELIVERED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const FINAL_STATUSES: readonly OrderStatus[] = ['DELIVERED', 'CANCELLED'];

export const PREP_TYPES = ['live', 'chilled', 'frozen', 'cooked', 'any'] as const;
export type PrepType = (typeof PREP_TYPES)[number];

export const UNITS = ['kg', 'piece', 'box', 'tray', 'set'] as const;
export type Unit = (typeof UNITS)[number];

export type UserType = 'B2C' | 'B2B';
export type SlipCheckResult = 'PENDING' | 'PASS' | 'WARN' | 'FAIL';
export type EventActor = 'owner' | 'customer' | 'system' | 'ai';
export type NegotiationAction = 'quote' | 'counter' | 'accept' | 'hold' | 'reject';
export type StockReason = 'stock_in' | 'sale' | 'waste' | 'adjust';
export type QuotaMode = 'NORMAL' | 'WARNING' | 'QUOTA_SAVER';
export type AddressSource = 'line_pin' | 'typed' | 'maps_link' | 'saved';

export interface UserRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
  full_name: string | null;
  phone: string | null;
  user_type: UserType;
  business_name: string | null;
  default_delivery_window: string | null;
  pdpa_consent_at: string | null;
  active_order_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AddressRow {
  id: string;
  user_id: string;
  label: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  source: AddressSource;
  is_default: boolean;
  created_at: string;
}

export interface ProductRow {
  id: string;
  name_th: string;
  aliases: string[];
  unit: Unit;
  prep_types: PrepType[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrderRow {
  id: string;
  order_no: number;
  code: string;
  user_id: string;
  address_id: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  status: OrderStatus;
  channel: 'chat' | 'liff';
  source_order_id: string | null;
  requested_delivery_at: string | null;
  raw_order_text: string | null;
  ai_parse: unknown | null;
  needs_owner_review: boolean;
  product_price_satang: number | null;
  price_note: string | null;
  shipping_fee_satang: number | null;
  /** Generated column: product + shipping (null if either is null). */
  total_satang: number | null;
  quoted_at: string | null;
  payment_expires_at: string | null;
  paid_at: string | null;
  paid_confirmed_by: string | null;
  tracking_url: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  owner_reminded_at: string | null;
  customer_last_seen_at: string | null;
  push_count: number;
  realtime_token: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/** Columns the application may write on an order (generated/managed columns excluded). */
export type OrderPatch = Partial<
  Omit<OrderRow, 'id' | 'order_no' | 'code' | 'user_id' | 'total_satang' | 'realtime_token' | 'version' | 'created_at' | 'updated_at'>
>;

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  raw_text: string;
  qty: number;
  unit: string;
  prep_type: PrepType;
  actual_qty: number | null;
  cost_satang: number | null;
  unit_price_satang: number | null;
  note: string | null;
  sort: number;
}

export interface NegotiationRow {
  id: string;
  order_id: string;
  round: number;
  actor: 'owner' | 'customer';
  action: NegotiationAction;
  amount_satang: number | null;
  margin_satang: number | null;
  message: string | null;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  slip_path: string | null;
  ai_extract: unknown | null;
  amount_satang: number | null;
  slip_time: string | null;
  receiver_text: string | null;
  reference_no: string | null;
  check_result: SlipCheckResult;
  check_details: unknown | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  override_reason: string | null;
  created_at: string;
}

export interface StockLogRow {
  id: string;
  product_id: string;
  reason: StockReason;
  qty_delta: number;
  unit_cost_satang: number | null;
  order_id: string | null;
  supplier_bill_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PriceHistoryRow {
  id: string;
  product_id: string;
  kind: 'cost' | 'sell';
  unit_price_satang: number;
  source: 'supplier_bill' | 'order' | 'manual';
  user_id: string | null;
  order_id: string | null;
  supplier_bill_id: string | null;
  recorded_at: string;
}

export interface QuotaLogRow {
  id: string;
  month: string; // 'YYYY-MM-01'
  limit_count: number;
  total_usage: number;
  local_count: number;
  mode: QuotaMode;
  checked_at: string;
}

export interface OrderEventRow {
  id: string;
  order_id: string;
  actor: EventActor;
  event: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus | null;
  payload: unknown | null;
  created_at: string;
}
