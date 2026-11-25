/**
 * REST request bodies — docs/API_AND_AI_CONTRACTS.md §2.2–2.3.
 * One Zod schema per endpoint body; routes validate with these before touching the DB.
 */
import { z } from 'zod';
import { normalizeThaiPhone } from '../phone';

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

export const DispatchRequest = z.object({
  trackingUrl: z.string().url(),
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

export const SlipSubmitRequest = z.object({
  path: z.string().min(1),
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
