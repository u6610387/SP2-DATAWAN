/** View models — docs/API_AND_AI_CONTRACTS.md §2.1 and §2.3. */
import type { OrderStatus, PrepType, QuotaMode, Unit } from '../db';
import type { SlipReadResult } from './ai';

export interface OrderItemView {
  id: string;
  productId: string | null;
  name: string;
  qty: number;
  unit: Unit;
  prepType: PrepType;
  actualQty: number | null;
}

export interface NegotiationView {
  round: number;
  actor: 'owner' | 'customer';
  action: string;
  amountSatang: number | null;
  message: string | null;
}

/** Customer LIFF view. Never contains cost or margin. */
export interface CustomerOrderView {
  id: string;
  code: string;
  status: OrderStatus;
  version: number;
  items: OrderItemView[];
  productPriceSatang: number | null;
  priceNote: string | null;
  shippingFeeSatang: number | null;
  totalSatang: number | null;
  paymentExpiresAt: string | null;
  promptpayPayload: string | null;
  trackingUrl: string | null;
  negotiation: NegotiationView[];
  delivery: {
    recipientName: string | null;
    /** Normalised Thai phone (own order only; owner view adds it too). */
    recipientPhone: string | null;
    /** A location/address has been received for this order. */
    hasLocation: boolean;
    /** True while the shop can't see the order yet because the recipient name/phone is missing. */
    needsRecipient: boolean;
    addressText: string | null;
    lat: number | null;
    lng: number | null;
    requestedDeliveryAt: string | null;
  };
  realtime: { channel: string };
  ownerDelayed: boolean;
}

export type SlipRule = 'AMOUNT' | 'TIME' | 'RECEIVER' | 'REFERENCE' | 'READABLE';
export type CheckLevel = 'PASS' | 'WARN' | 'FAIL';

export interface SlipCheck {
  rule: SlipRule;
  result: CheckLevel;
  detail: string;
}

export interface PaymentCheckView {
  id: string;
  result: 'PENDING' | CheckLevel;
  checks: SlipCheck[];
  extracted: SlipReadResult | null;
  slipImageUrl: string | null;
}

export type MarginColor = 'GREEN' | 'RED' | 'GREY';

export interface OwnerOrderView extends Omit<CustomerOrderView, 'realtime'> {
  customer: { id: string; type: 'B2C' | 'B2B'; name: string | null; businessName: string | null; phone: string | null };
  rawOrderText: string | null;
  costSatang: number | null;
  suggestedPriceSatang: number | null;
  b2bAnchorPriceSatang: number | null;
  marginSatang: number | null;
  marginColor: MarginColor;
  latestPayment: PaymentCheckView | null;
  lalamoveCard: { text: string; mapUrl: string | null } | null;
  needsOwnerReview: boolean;
  pushCount: number;
  /** Outcome of the tracking-link LINE push after dispatch (null until dispatched). */
  trackingPush: { sent: boolean; reason: string | null } | null;
}

export interface QuotaStatus {
  month: string; // '2027-01'
  limit: number;
  used: number;
  mode: QuotaMode;
  dailyBudgetRemaining: number;
  resetsAt: string;
}

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'ORDER_STATE_INVALID'
  | 'VERSION_CONFLICT'
  | 'QUOTA_SAVER_ACTIVE'
  | 'AI_UNAVAILABLE'
  | 'AI_OUTPUT_INVALID'
  | 'SLIP_REFERENCE_REUSED'
  | 'DELIVERY_INCOMPLETE'
  | 'INTERNAL';

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

/** Realtime broadcast payload on channel `order:{id}:{realtimeToken}`. Never PII. */
export interface OrderUpdatedBroadcast {
  type: 'order_updated';
  version: number;
}
