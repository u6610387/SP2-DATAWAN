/** View models — docs/API_AND_AI_CONTRACTS.md §2.1 and §2.3. */
import type { B2bStatus, BusinessType, OrderStatus, PrepType, QuotaMode, Unit } from '../db';
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
  /** Set when this order was created by a LIFF reorder. */
  sourceOrderId?: string | null;
  /**
   * The customer's own address the order room offers as "ส่งที่อยู่เดิม" while the order waits
   * for a location (the reordered order's address). Null otherwise.
   */
  reuseAddress?: { id: string; addressText: string | null } | null;
  /** Latest owner-approved note for this order (LIFF only; notes are never pushed). */
  shopNote?: { text: string; at: string } | null;
}

/** Row in the LIFF order list (GET /api/liff/orders). Never contains cost or margin. */
export interface CustomerOrderSummary {
  id: string;
  code: string;
  status: OrderStatus;
  createdAt: string;
  deliveredAt: string | null;
  /** First 3 items. */
  itemsPreview: { name: string; qty: number; unit: Unit }[];
  itemCount: number;
  totalSatang: number | null;
  /** DELIVERED with at least one item whose product is still active. */
  reorderable: boolean;
}

/** POST /api/liff/reorder response: the new order plus the items that couldn't be copied. */
export interface ReorderResponse extends CustomerOrderView {
  /** Names of source items not copied (product no longer sold, or never matched a product). */
  skippedItems: string[];
  /** True when an unconfirmed reorder of the same source already existed (double tap). */
  deduped: boolean;
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
  /** Order creation time (slip checklist: a transfer before this is an old slip). */
  createdAt: string;
  customer: { id: string; type: 'B2C' | 'B2B'; name: string | null; businessName: string | null; phone: string | null;
    b2b: { businessName: string; deliveryWindow: string | null } | null;
  };
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
  | 'NOT_A_SLIP'
  | 'DUPLICATE'
  | 'INVALID_FROM_STATE'
  | 'TOO_MANY_DOCUMENTS'
  | 'NOTHING_TO_REORDER'
  | 'INTERNAL';

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

/** Realtime broadcast payload on channel `order:{id}:{realtimeToken}`. Never PII. */
export interface OrderUpdatedBroadcast {
  type: 'order_updated';
  version: number;
}

// ---- B2B account views ----
export interface CustomerAccountView {
  type: 'B2C' | 'B2B';
  b2b: null | {
    status: B2bStatus;
    businessName: string;
    businessType: BusinessType;
    addressText: string;
    lat: number | null;
    lng: number | null;
    deliveryWindow: string | null;
    taxId: string | null;
    rejectionReason: string | null;
    needsRereview: boolean;
    documents: { id: string }[];
  };
}

export interface OwnerB2bSummaryView {
  userId: string;
  customerName: string | null;
  businessName: string;
  businessType: BusinessType;
  status: B2bStatus;
  needsRereview: boolean;
  submittedAt: string;
}

export interface OwnerB2bDetailView extends OwnerB2bSummaryView {
  phone: string | null;
  addressText: string;
  lat: number | null;
  lng: number | null;
  mapUrl: string | null;
  deliveryWindow: string | null;
  taxId: string | null;
  /** Checksum result only; null when no Tax ID. Flags, never approves. */
  taxIdValid: boolean | null;
  rereviewFields: string[];
  rejectionReason: string | null;
  decidedAt: string | null;
  verifiedAt: string | null;
  /** The profile's `updated_at`; sent back as `expectedUpdatedAt` with every owner decision. */
  updatedAt: string;
  documents: { id: string; url: string }[];
}
