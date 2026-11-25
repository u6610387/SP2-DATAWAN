/**
 * REST request bodies — docs/API_AND_AI_CONTRACTS.md §2.2–2.3.
 * One Zod schema per endpoint body; routes validate with these before touching the DB.
 */
import { z } from 'zod';

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
