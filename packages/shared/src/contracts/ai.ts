/**
 * Gemini Structured Output contracts — docs/API_AND_AI_CONTRACTS.md §6.
 * These Zod schemas are the single source of truth: the real Gemini provider
 * passes z.toJSONSchema(schema) as responseJsonSchema, and every provider's
 * output (mock or real) is validated against them.
 */
import { z } from 'zod';
import { PREP_TYPES, UNITS, type PrepType, type Unit } from '../db';

const UnitEnum = z.enum(UNITS);
const PrepEnum = z.enum(PREP_TYPES);

// ---------- Task 1: ORDER_PARSE ----------
export const OrderParseResult = z.object({
  intent: z.enum(['new_order', 'reorder', 'modify', 'question', 'not_order']),
  items: z.array(
    z.object({
      product_ref: z.string().nullable(),
      raw_text: z.string(),
      qty: z.number().positive().nullable(),
      unit: UnitEnum.nullable(),
      prep_type: PrepEnum,
      note: z.string().nullable(),
    }),
  ),
  delivery_time: z.object({
    iso: z.string().nullable(),
    raw_text: z.string().nullable(),
  }),
  missing_fields: z.array(z.enum(['product', 'qty', 'unit', 'prep_type', 'delivery_time'])),
  clarification_question_th: z.string().nullable(),
});
export type OrderParseResult = z.infer<typeof OrderParseResult>;
export type MissingField = OrderParseResult['missing_fields'][number];

/** Catalog entry as sent to the AI — refs ('p0', 'p1', …) instead of UUIDs. */
export interface CatalogRef {
  productRef: string;
  nameTh: string;
  aliases: string[];
  unit: Unit;
  prepTypes: PrepType[];
}

export interface OrderParseInput {
  /** PII-stripped chat text. */
  message: string;
  previousDraft?: OrderParseResult;
  previousOrder?: { items: { productRef: string; qty: number; unit: Unit; prepType: PrepType }[] };
  catalog: CatalogRef[];
  /** e.g. '2027-01-14T09:20:00+07:00' */
  nowBangkok: string;
}

// ---------- Task 2: OWNER_NOTE ----------
export const OwnerNoteResult = z.object({
  message_th: z.string().max(500),
  out_of_stock: z.array(z.object({ item_ref: z.string().nullable(), raw_text: z.string() })),
  substitutes: z.array(
    z.object({
      product_ref: z.string().nullable(),
      name_th: z.string(),
      qty: z.number().positive().nullable(),
      unit: UnitEnum.nullable(),
      price_baht: z.number().nonnegative().nullable(),
    }),
  ),
});
export type OwnerNoteResult = z.infer<typeof OwnerNoteResult>;

export interface OwnerNoteInput {
  note: string; // PII-stripped
  orderItems: { itemRef: string; name: string; qty: number; unit: Unit }[];
  catalog: CatalogRef[];
  politeness: 'ค่ะ' | 'ครับ';
}

// ---------- Task 3: SUPPLIER_BILL ----------
export const SupplierBillResult = z.object({
  is_bill: z.boolean(),
  supplier_name: z.string().nullable(),
  bill_date: z.string().nullable(),
  lines: z.array(
    z.object({
      name: z.string(),
      product_ref: z.string().nullable(),
      qty: z.number().nullable(),
      unit: z.string().nullable(),
      unit_price: z.number().nullable(),
      line_total: z.number().nullable(),
      legible: z.boolean(),
    }),
  ),
  bill_total: z.number().nullable(),
});
export type SupplierBillResult = z.infer<typeof SupplierBillResult>;

export interface ImageInput {
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface SupplierBillInput {
  image: ImageInput;
  catalog: CatalogRef[];
}

export interface BillFlag {
  lineIndex: number | null;
  kind: 'LINE_MATH' | 'TOTAL_MATH' | 'UNREADABLE' | 'NO_PRODUCT_MATCH';
  detail: string;
}

// ---------- Task 4: PAYMENT_SLIP ----------
export const SlipReadResult = z.object({
  is_slip: z.boolean(),
  bank: z.string().nullable(),
  amount: z.number().nullable(),
  date_time: z.string().nullable(),
  receiver_name_or_id: z.string().nullable(),
  reference_no: z.string().nullable(),
});
export type SlipReadResult = z.infer<typeof SlipReadResult>;

export interface PaymentSlipInput {
  image: ImageInput;
  /**
   * Used ONLY by the mock provider so the happy path can produce a matching slip.
   * The Gemini provider MUST ignore this (sending the expected amount would bias the model).
   */
  mockOnly?: { expectedTotalSatang?: number | null; receiverName?: string };
}

export type AiTask = 'ORDER_PARSE' | 'OWNER_NOTE' | 'SUPPLIER_BILL' | 'PAYMENT_SLIP';

export interface AiCallMeta {
  task: AiTask;
  provider: 'mock' | 'gemini';
  model: string;
  promptVersion: string;
  latencyMs: number;
  attempts: number;
  piiTokens: number;
}

export type AiErrorCode = 'RATE_LIMITED' | 'INVALID_OUTPUT' | 'BLOCKED' | 'UNAVAILABLE';

export type AiResult<T> = { ok: true; data: T; meta: AiCallMeta } | { ok: false; error: AiErrorCode; meta: AiCallMeta };
