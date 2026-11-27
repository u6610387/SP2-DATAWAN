/**
 * Pure mappers from DB rows to the REST view models (docs/API_AND_AI_CONTRACTS.md §2.1).
 * Kept free of I/O (no Deps, no Repo calls) so routes fetch everything first — easy to
 * unit-test and impossible to accidentally leak an extra DB round-trip into a response.
 */
import {
  computeMargin,
  type AddressRow,
  type CustomerOrderView,
  type CustomerAccountView,
  type BusinessProfileRow,
  type BusinessDocumentRow,
  type MarginColor,
  type NegotiationRow,
  type OrderItemRow,
  type OrderRow,
  type OrderItemView,
  type OwnerOrderView,
  type OwnerB2bSummaryView,
  type OwnerB2bDetailView,
  isValidThaiTaxId,
  type PaymentCheckView,
  type PaymentRow,
  type ProductRow,
  type SlipCheck,
  type SlipReadResult,
  type OrderStatus,
  type UserRow,
} from '@datawan/shared';
import { lalamoveCardText } from '../line/flex';
import { mapUrl } from './location';
import { orderNeedsRecipient } from './recipient';
import { orderChannel } from './realtime';
import { buildPromptPayPayload } from './promptpay';
import { withNames } from './itemNames';

const LALAMOVE_CARD_STATES = new Set<OrderStatus>(['AWAITING_SHIPPING_FEE', 'AWAITING_PAYMENT', 'PAYMENT_EXPIRED', 'PAYMENT_REVIEW', 'PAID', 'DELIVERING']);

function toItemView(items: OrderItemRow[], products: ProductRow[]): OrderItemView[] {
  return withNames(items, products).map((it) => ({
    id: it.id,
    productId: it.product_id,
    name: it.name ?? it.raw_text,
    qty: it.qty,
    unit: it.unit as OrderItemView['unit'],
    prepType: it.prep_type,
    actualQty: it.actual_qty,
  }));
}

function toNegotiationViews(rows: NegotiationRow[]): CustomerOrderView['negotiation'] {
  return rows.map((n) => ({ round: n.round, actor: n.actor, action: n.action, amountSatang: n.amount_satang, message: n.message }));
}

function promptpayPayload(order: OrderRow, promptpayId: string): string | null {
  return order.total_satang !== null && order.total_satang > 0 ? buildPromptPayPayload(promptpayId, order.total_satang) : null;
}

export interface CustomerViewArgs {
  order: OrderRow;
  items: OrderItemRow[];
  products: ProductRow[];
  negotiations: NegotiationRow[];
  address: AddressRow | null;
  promptpayId: string;
}

export function toCustomerOrderView(args: CustomerViewArgs): CustomerOrderView {
  const { order, items, products, negotiations, address } = args;
  return {
    id: order.id,
    code: order.code,
    status: order.status,
    version: order.version,
    items: toItemView(items, products),
    productPriceSatang: order.product_price_satang,
    priceNote: order.price_note,
    shippingFeeSatang: order.shipping_fee_satang,
    totalSatang: order.total_satang,
    paymentExpiresAt: order.payment_expires_at,
    promptpayPayload: promptpayPayload(order, args.promptpayId),
    trackingUrl: order.tracking_url,
    negotiation: toNegotiationViews(negotiations),
    delivery: {
      recipientName: order.recipient_name,
      recipientPhone: order.recipient_phone,
      hasLocation: order.address_id !== null,
      needsRecipient: orderNeedsRecipient(order),
      addressText: address?.address_text ?? null,
      lat: address?.lat ?? null,
      lng: address?.lng ?? null,
      requestedDeliveryAt: order.requested_delivery_at,
    },
    realtime: { channel: orderChannel(order) },
    ownerDelayed: order.owner_reminded_at !== null,
  };
}

function marginOf(order: OrderRow, items: OrderItemRow[]): { satang: number | null; pct: number | null; color: MarginColor } {
  if (order.product_price_satang === null) return { satang: null, pct: null, color: 'GREY' };
  const m = computeMargin(order.product_price_satang, items.map((i) => i.cost_satang));
  return { satang: m.marginSatang, pct: m.marginPct, color: m.color };
}

export function toPaymentCheckView(payment: PaymentRow | null, slipImageUrl: string | null): PaymentCheckView | null {
  if (!payment) return null;
  const details = payment.check_details as { checks?: SlipCheck[] } | null;
  return {
    id: payment.id,
    result: payment.check_result,
    checks: details?.checks ?? [],
    extracted: (payment.ai_extract as SlipReadResult | null) ?? null,
    slipImageUrl,
  };
}

export interface OwnerViewArgs extends CustomerViewArgs {
  user: UserRow;
  b2bProfile: BusinessProfileRow | null;
  costSatang: number | null;
  suggestedPriceSatang: number | null;
  b2bAnchorPriceSatang: number | null;
  latestPayment: PaymentRow | null;
  slipImageUrl: string | null;
  needsOwnerReview: boolean;
  pushCount: number;
  trackingPush: { sent: boolean; reason: string | null } | null;
}

export function toOwnerOrderView(args: OwnerViewArgs): OwnerOrderView {
  const { order, items, user, address } = args;
  const margin = marginOf(order, items);
  const { realtime: _realtime, ...rest } = toCustomerOrderView(args);
  return {
    ...rest,
    customer: {
      id: user.id,
      type: user.user_type,
      name: user.full_name ?? user.display_name,
      businessName: user.business_name,
      phone: user.phone,
      b2b:
        args.b2bProfile?.status === 'VERIFIED'
          ? { businessName: user.business_name ?? args.b2bProfile.business_name, deliveryWindow: user.default_delivery_window }
          : null,
    },
    rawOrderText: order.raw_order_text,
    costSatang: args.costSatang,
    suggestedPriceSatang: args.suggestedPriceSatang,
    b2bAnchorPriceSatang: args.b2bAnchorPriceSatang,
    marginSatang: margin.satang,
    marginColor: margin.color,
    latestPayment: toPaymentCheckView(args.latestPayment, args.slipImageUrl),
    // From "ร้านกำลังเช็กค่าส่ง" on: the owner needs the address + pin to get a Lalamove quote BEFORE typing the fee.
    lalamoveCard: address && LALAMOVE_CARD_STATES.has(order.status)
      ? { text: lalamoveCardText(order, address, user), mapUrl: mapUrl(address.lat, address.lng) }
      : null,
    needsOwnerReview: args.needsOwnerReview,
    pushCount: args.pushCount,
    trackingPush: args.trackingPush,
  };
}

/** Account view for the LIFF: documents are ids only (never paths or URLs); the reason shows only when REJECTED. */
export function toCustomerAccountView(user: UserRow, profile: BusinessProfileRow | null, documents: BusinessDocumentRow[]): CustomerAccountView {
  return {
    type: user.user_type,
    b2b: profile && {
      status: profile.status,
      businessName: profile.business_name,
      businessType: profile.business_type,
      addressText: profile.address_text,
      lat: profile.lat,
      lng: profile.lng,
      deliveryWindow: profile.default_delivery_window,
      taxId: profile.tax_id,
      rejectionReason: profile.status === 'REJECTED' ? profile.rejection_reason : null,
      needsRereview: profile.needs_rereview,
      documents: documents.map((d) => ({ id: d.id })),
    },
  };
}

export function toOwnerB2bSummaryView(profile: BusinessProfileRow, user: UserRow | null): OwnerB2bSummaryView {
  return {
    userId: profile.user_id,
    customerName: user ? (user.full_name ?? user.display_name) : null,
    businessName: profile.business_name,
    businessType: profile.business_type,
    status: profile.status,
    needsRereview: profile.needs_rereview,
    submittedAt: profile.submitted_at,
  };
}

/** Owner review view. phone and taxId are owner-only data; taxIdValid is a checksum flag, never an approval. */
export function toOwnerB2bDetailView(profile: BusinessProfileRow, user: UserRow | null, docs: { id: string; url: string }[]): OwnerB2bDetailView {
  return {
    ...toOwnerB2bSummaryView(profile, user),
    phone: user?.phone ?? null,
    addressText: profile.address_text,
    lat: profile.lat,
    lng: profile.lng,
    mapUrl: mapUrl(profile.lat, profile.lng),
    deliveryWindow: profile.default_delivery_window,
    taxId: profile.tax_id,
    taxIdValid: profile.tax_id ? isValidThaiTaxId(profile.tax_id) : null,
    rereviewFields: profile.rereview_fields,
    rejectionReason: profile.rejection_reason,
    decidedAt: profile.decided_at,
    verifiedAt: profile.verified_at,
    updatedAt: profile.updated_at,
    documents: docs,
  };
}
