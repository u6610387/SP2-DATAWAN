/**
 * Pure mappers from DB rows to the REST view models (docs/API_AND_AI_CONTRACTS.md §2.1).
 * Kept free of I/O (no Deps, no Repo calls) so routes fetch everything first — easy to
 * unit-test and impossible to accidentally leak an extra DB round-trip into a response.
 */
import {
  computeMargin,
  type AddressRow,
  type CustomerOrderView,
  type MarginColor,
  type NegotiationRow,
  type OrderItemRow,
  type OrderRow,
  type OrderItemView,
  type OwnerOrderView,
  type PaymentCheckView,
  type PaymentRow,
  type ProductRow,
  type SlipCheck,
  type SlipReadResult,
  type UserRow,
} from '@datawan/shared';
import { lalamoveCardText } from '../line/flex';
import { mapUrl } from './location';
import { orderChannel } from './realtime';
import { buildPromptPayPayload } from './promptpay';
import { withNames } from './itemNames';

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
  costSatang: number | null;
  suggestedPriceSatang: number | null;
  b2bAnchorPriceSatang: number | null;
  latestPayment: PaymentRow | null;
  slipImageUrl: string | null;
  needsOwnerReview: boolean;
  pushCount: number;
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
    },
    rawOrderText: order.raw_order_text,
    costSatang: args.costSatang,
    suggestedPriceSatang: args.suggestedPriceSatang,
    b2bAnchorPriceSatang: args.b2bAnchorPriceSatang,
    marginSatang: margin.satang,
    marginColor: margin.color,
    latestPayment: toPaymentCheckView(args.latestPayment, args.slipImageUrl),
    lalamoveCard: order.shipping_fee_satang !== null
      ? { text: lalamoveCardText(order, address, user), mapUrl: address ? mapUrl(address.lat, address.lng) : null }
      : null,
    needsOwnerReview: args.needsOwnerReview,
    pushCount: args.pushCount,
  };
}
