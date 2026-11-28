/**
 * REST request bodies — docs/API_AND_AI_CONTRACTS.md §2.2–2.3.
 * One Zod schema per endpoint body; routes validate with these before touching the DB.
 */
import { z } from 'zod';
import { PREP_TYPES, UNITS } from '../db';
import { normalizeThaiPhone } from '../phone';
import { extractTrackingUrl } from '../tracking';

export const SetPriceRequest = z.object({
  amountSatang: z.number().int().positive(),
  note: z.string().max(500).nullable().optional(),
});
export type SetPriceRequest = z.infer<typeof SetPriceRequest>;

export const NegotiationRequest = z.object({
  action: z.enum(['accept', 'counter', 'hold']),
  amountSatang: z.number().int().positive().optional(),
});
export type NegotiationRequest = z.infer<typeof NegotiationRequest>;

export const ShippingRequest = z.object({
  feeSatang: z.number().int().nonnegative(),
});
export type ShippingRequest = z.infer<typeof ShippingRequest>;

export const CounterOfferRequest = z.object({
  amountSatang: z.number().int().positive(),
  message: z.string().max(500).nullable().optional(),
});
export type CounterOfferRequest = z.infer<typeof CounterOfferRequest>;

export const ConfirmPaymentRequest = z.object({
  /** Required only when a slip check FAILed (duplicate / tampered QR, AI-read mismatch). */
  overrideReason: z.string().max(500).nullable().optional(),
});
export type ConfirmPaymentRequest = z.infer<typeof ConfirmPaymentRequest>;

/** Rejecting a slip always needs the owner's reason (it goes into the audit trail). */
export const RejectSlipRequest = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RejectSlipRequest = z.infer<typeof RejectSlipRequest>;

/** Owner pastes the courier link (or the app's share text containing it); stored as a clean https URL. */
export const DispatchRequest = z.object({
  trackingUrl: z.string().max(2000).transform((v, ctx) => {
    const url = extractTrackingUrl(v);
    if (!url) {
      ctx.addIssue({ code: 'custom', message: 'trackingUrl must contain an https link (e.g. https://share.lalamove.com/…)' });
      return z.NEVER;
    }
    return url;
  }),
});
export type DispatchRequest = z.infer<typeof DispatchRequest>;

export const DeliveredRequest = z.object({
  actualQty: z.array(z.object({ itemId: z.string().uuid(), actualQty: z.number().positive() })).optional(),
});
export type DeliveredRequest = z.infer<typeof DeliveredRequest>;

/** Owner cancels an order before payment is confirmed. The reason goes into the audit trail. */
export const CancelOrderRequest = z.object({
  reason: z.string().trim().min(1).max(200),
});
export type CancelOrderRequest = z.infer<typeof CancelOrderRequest>;

/**
 * Customer sets the delivery recipient (LIFF). Required before an order reaches the shop when
 * the profile has no name/phone; saved to the profile so repeat orders are pre-filled.
 */
export const RecipientContactRequest = z.object({
  recipientName: z.string().trim().min(1).max(100),
  recipientPhone: z.string().max(32).transform((v, ctx) => {
    const n = normalizeThaiPhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'recipientPhone must be a Thai phone number (9–10 digits starting with 0)' });
      return z.NEVER;
    }
    return n;
  }),
  pdpaConsent: z.literal(true),
});
export type RecipientContactRequest = z.infer<typeof RecipientContactRequest>;

/** Text of the Mini-QR the owner's device decoded from the stored slip image; null = no QR found. */
export const SlipQrRequest = z.object({
  payload: z.string().max(512).nullable(),
});
export type SlipQrRequest = z.infer<typeof SlipQrRequest>;

export const SlipUploadUrlRequest = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export type SlipUploadUrlRequest = z.infer<typeof SlipUploadUrlRequest>;

/**
 * LIFF slip submit. `qrPayload` is the bank Mini-QR text the customer's browser decoded from the
 * image before uploading; the Worker re-validates it (format + CRC) — no image decoding on Workers.
 */
export const SlipSubmitRequest = z.object({
  path: z.string().min(1),
  qrPayload: z.string().min(1).max(512),
});
export type SlipSubmitRequest = z.infer<typeof SlipSubmitRequest>;

export const StockAdjustRequest = z.object({
  productId: z.string().min(1),
  reason: z.enum(['stock_in', 'sale', 'waste', 'adjust']),
  qtyDelta: z.number().refine((v) => v !== 0, 'qtyDelta must not be zero'),
  unitCostSatang: z.number().int().nonnegative().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});
export type StockAdjustRequest = z.infer<typeof StockAdjustRequest>;

export const PushSubscriptionRequest = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequest>;

/** Owner: new category for the สต็อก tab (names are unique among active categories). */
export const CategoryCreateRequest = z.object({
  nameTh: z.string().trim().min(1).max(60),
});
export type CategoryCreateRequest = z.infer<typeof CategoryCreateRequest>;

/**
 * Owner: new product. `aliases` are extra words customers use (the name itself is always added,
 * so the order parser recognises the product on the very next message). Aliases < 2 chars are dropped.
 */
export const ProductCreateRequest = z.object({
  nameTh: z.string().trim().min(1).max(80),
  unit: z.enum(UNITS),
  prepTypes: z.array(z.enum(PREP_TYPES)).min(1).max(PREP_TYPES.length).default(['any']),
  aliases: z.array(z.string().trim().max(40)).max(20).default([]),
  categoryId: z.string().uuid().nullable().default(null),
});
export type ProductCreateRequest = z.infer<typeof ProductCreateRequest>;

/** Owner: edit an existing product from the สต็อก list (any subset; at least one field). */
export const ProductUpdateRequest = z
  .object({
    nameTh: z.string().trim().min(1).max(80).optional(),
    unit: z.enum(UNITS).optional(),
    prepTypes: z.array(z.enum(PREP_TYPES)).min(1).max(PREP_TYPES.length).optional(),
    aliases: z.array(z.string().trim().max(40)).max(20).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to update' });
export type ProductUpdateRequest = z.infer<typeof ProductUpdateRequest>;

// ---- B2B account (docs/API_AND_AI_CONTRACTS.md §2.3a) ----
const DELIVERY_WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

export const B2bApplyRequest = z
  .object({
    businessName: z.string().trim().min(1).max(100),
    businessType: z.enum(['restaurant', 'reseller', 'hotel', 'other']),
    addressText: z.string().trim().min(5).max(300),
    lat: z.number().min(5).max(21).nullable(),
    lng: z.number().min(97).max(106).nullable(),
    deliveryWindow: z.string().regex(DELIVERY_WINDOW_RE).nullable(),
    taxId: z.string().regex(/^\d{13}$/).nullable(),
    documentPaths: z.array(z.string().max(300)).max(3),
    pdpaConsent: z.literal(true),
  })
  .refine((v) => (v.lat === null) === (v.lng === null), { message: 'lat and lng must both be set or both null' });
export type B2bApplyRequest = z.infer<typeof B2bApplyRequest>;

export const B2bDocUploadUrlRequest = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export type B2bDocUploadUrlRequest = z.infer<typeof B2bDocUploadUrlRequest>;

/**
 * Owner approve / acknowledge. `expectedUpdatedAt` is the profile `updatedAt` the owner's detail
 * view showed: a customer edit since then makes the decision 409 INVALID_FROM_STATE (CLAUDE.md §3.1).
 */
export const OwnerB2bDecisionRequest = z.object({
  expectedUpdatedAt: z.string().min(1),
});
export type OwnerB2bDecisionRequest = z.infer<typeof OwnerB2bDecisionRequest>;

/** Owner reject / revoke reason (plus the same `expectedUpdatedAt` guard). */
export const OwnerB2bReasonRequest = z.object({
  reason: z.string().trim().min(1).max(200),
  expectedUpdatedAt: z.string().min(1),
});
export type OwnerB2bReasonRequest = z.infer<typeof OwnerB2bReasonRequest>;

/**
 * LIFF one-tap reorder: copies a DELIVERED order's items (no AI parse, no prices) into a new
 * order in AWAITING_CONFIRMATION. The owner still quotes the price (CLAUDE.md §3.1).
 */
export const ReorderRequest = z.object({
  sourceOrderId: z.string().uuid(),
  requestedDeliveryAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type ReorderRequest = z.infer<typeof ReorderRequest>;

/** LIFF: deliver to one of the customer's own saved addresses (e.g. the reordered order's). */
export const OrderAddressRequest = z.object({
  addressId: z.string().uuid(),
});
export type OrderAddressRequest = z.infer<typeof OrderAddressRequest>;

export const OrderHistoryScope = z.enum(['history', 'open']);
export type OrderHistoryScope = z.infer<typeof OrderHistoryScope>;
