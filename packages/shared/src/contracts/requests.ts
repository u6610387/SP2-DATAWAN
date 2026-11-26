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
  overrideReason: z.string().max(500).nullable().optional(),
});
export type ConfirmPaymentRequest = z.infer<typeof ConfirmPaymentRequest>;

export const RejectSlipRequest = z.object({
  reason: z.string().max(500),
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

