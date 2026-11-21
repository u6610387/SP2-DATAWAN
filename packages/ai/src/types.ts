import type {
  AiErrorCode,
  OrderParseInput,
  OwnerNoteInput,
  PaymentSlipInput,
  SupplierBillInput,
} from '@datawan/shared';

/** What a provider returns: raw JSON (validated by the service, never trusted). */
export type ProviderResult =
  | { ok: true; json: unknown; model: string; attempts: number }
  | { ok: false; error: AiErrorCode; model: string; attempts: number };

/**
 * Swap point between mock and Gemini (USE_MOCK_AI). Providers receive inputs that
 * are ALREADY PII-stripped and use catalog refs ('p0', 'item_0'), never UUIDs.
 */
export interface AiProvider {
  readonly name: 'mock' | 'gemini';
  orderParse(input: OrderParseInput): Promise<ProviderResult>;
  ownerNote(input: OwnerNoteInput): Promise<ProviderResult>;
  supplierBill(input: SupplierBillInput): Promise<ProviderResult>;
  paymentSlip(input: PaymentSlipInput): Promise<ProviderResult>;
}

/** Minimal product shape the AI layer needs (a subset of ProductRow). */
export interface CatalogProduct {
  id: string;
  name_th: string;
  aliases: string[];
  unit: import('@datawan/shared').Unit;
  prep_types: import('@datawan/shared').PrepType[];
}

export const PROMPT_VERSIONS = {
  ORDER_PARSE: 'order_parse@v1',
  OWNER_NOTE: 'owner_note@v1',
  SUPPLIER_BILL: 'supplier_bill@v1',
  PAYMENT_SLIP: 'payment_slip@v1',
} as const;
