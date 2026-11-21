/**
 * The 4 public AI functions. Pipeline for every call:
 *   stripPII → refs instead of UUIDs → assertNoPII → provider → Zod → code checks → restore refs/PII
 * Swapping mock ↔ Gemini only changes the provider; callers never change.
 */
import {
  OrderParseResult,
  OwnerNoteResult,
  SlipReadResult,
  SupplierBillResult,
  type AiCallMeta,
  type AiResult,
  type AiTask,
  type BillFlag,
  type ImageInput,
  type PrepType,
  type Unit,
} from '@datawan/shared';
import type { z } from 'zod';
import { allAliases, toCatalogRefs } from './catalog';
import { checkOrderParse, checkOwnerNote, checkSupplierBill } from './checks';
import { assertNoPII, restorePII, stripPII } from './pii/strip';
import { PROMPT_VERSIONS, type AiProvider, type CatalogProduct, type ProviderResult } from './types';

// ---------- public input/output types ----------

export interface ParseOrderArgs {
  message: string;
  products: CatalogProduct[];
  /** Names to mask: customer's full/display/business name, saved recipients. */
  knownNames: string[];
  now: Date;
  previousDraft?: ResolvedOrderParse;
  previousOrderItems?: { productId: string; qty: number; unit: Unit; prepType: PrepType }[];
}

export type ResolvedOrderItem = OrderParseResult['items'][number] & { product_id: string | null };
export type ResolvedOrderParse = Omit<OrderParseResult, 'items'> & { items: ResolvedOrderItem[] };

export interface PolishNoteArgs {
  note: string;
  orderItems: { id: string; name: string; qty: number; unit: Unit }[];
  products: CatalogProduct[];
  knownNames: string[];
  politeness: 'ค่ะ' | 'ครับ';
}
export type ResolvedOwnerNote = Omit<OwnerNoteResult, 'out_of_stock' | 'substitutes'> & {
  out_of_stock: (OwnerNoteResult['out_of_stock'][number] & { item_id: string | null })[];
  substitutes: (OwnerNoteResult['substitutes'][number] & { product_id: string | null })[];
};

export interface ParseBillArgs {
  image: ImageInput;
  products: CatalogProduct[];
}
export interface ResolvedBill {
  bill: Omit<SupplierBillResult, 'lines'> & { lines: (SupplierBillResult['lines'][number] & { product_id: string | null })[] };
  flags: BillFlag[];
}

export interface ParseSlipArgs {
  image: ImageInput;
  /** Only the mock provider reads this (see PaymentSlipInput.mockOnly). */
  mockOnly?: { expectedTotalSatang?: number | null; receiverName?: string };
}

export type WithWarnings<T> = T & { warnings: string[] };

export interface AiService {
  readonly provider: 'mock' | 'gemini';
  parseOrder(args: ParseOrderArgs): Promise<AiResult<WithWarnings<{ parse: ResolvedOrderParse }>>>;
  polishOwnerNote(args: PolishNoteArgs): Promise<AiResult<WithWarnings<{ note: ResolvedOwnerNote }>>>;
  parseSupplierBill(args: ParseBillArgs): Promise<AiResult<ResolvedBill>>;
  parsePaymentSlip(args: ParseSlipArgs): Promise<AiResult<SlipReadResult>>;
}

export interface AiServiceOptions {
  /** GEMINI_SLIP_MODE. 'manual' = never send slips to any provider. */
  slipMode: 'paid' | 'manual' | 'redacted';
  /** Called with every outgoing text payload (eval hooks / metrics). */
  onPayload?: (task: AiTask, payload: unknown) => void;
  /** Called with call metadata (no content) for logging. */
  onMeta?: (meta: AiCallMeta) => void;
}

// ---------- implementation ----------

function toBangkokIso(d: Date): string {
  return `${new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 19)}+07:00`;
}

export function createAiService(provider: AiProvider, opts: AiServiceOptions): AiService {
  async function run<S extends z.ZodTypeAny>(
    task: AiTask,
    schema: S,
    piiTokens: number,
    call: () => Promise<ProviderResult>,
  ): Promise<AiResult<z.infer<S>>> {
    const started = Date.now();
    const meta = (r: { model: string; attempts: number }): AiCallMeta => ({
      task,
      provider: provider.name,
      model: r.model,
      promptVersion: PROMPT_VERSIONS[task],
      latencyMs: Date.now() - started,
      attempts: r.attempts,
      piiTokens,
    });
    let res: ProviderResult;
    try {
      res = await call();
    } catch {
      const m = meta({ model: 'unknown', attempts: 1 });
      opts.onMeta?.(m);
      return { ok: false, error: 'UNAVAILABLE', meta: m };
    }
    const m = meta(res);
    opts.onMeta?.(m);
    if (!res.ok) return { ok: false, error: res.error, meta: m };
    const parsed = schema.safeParse(res.json);
    if (!parsed.success) return { ok: false, error: 'INVALID_OUTPUT', meta: m };
    return { ok: true, data: parsed.data, meta: m };
  }

  return {
    provider: provider.name,

    async parseOrder(args) {
      const { catalog, refToId, idToRef } = toCatalogRefs(args.products);
      const pii = { knownNames: args.knownNames, productAliases: allAliases(args.products) };
      const { text, map, count } = stripPII(args.message, pii);
      const toRefs = (d: ResolvedOrderParse): OrderParseResult => ({
        ...d,
        items: d.items.map(({ product_id, ...it }) => ({ ...it, product_ref: product_id ? idToRef.get(product_id) ?? null : null })),
      });
      const payload = {
        message: text,
        catalog,
        nowBangkok: toBangkokIso(args.now),
        ...(args.previousDraft ? { previousDraft: stripPIIDeep(toRefs(args.previousDraft), pii) } : {}),
        ...(args.previousOrderItems
          ? {
              previousOrder: {
                items: args.previousOrderItems
                  .filter((i) => idToRef.has(i.productId))
                  .map((i) => ({ productRef: idToRef.get(i.productId)!, qty: i.qty, unit: i.unit, prepType: i.prepType })),
              },
            }
          : {}),
      };
      assertNoPII(payload, pii);
      opts.onPayload?.('ORDER_PARSE', payload);

      const r = await run('ORDER_PARSE', OrderParseResult, count, () => provider.orderParse(payload));
      if (!r.ok) return r;
      const { result, warnings } = checkOrderParse(r.data, { strippedMessage: text, catalog });
      const resolved: ResolvedOrderParse = restorePII(
        { ...result, items: result.items.map((it) => ({ ...it, product_id: it.product_ref ? refToId.get(it.product_ref) ?? null : null })) },
        map,
      );
      return { ...r, data: { parse: resolved, warnings } };
    },

    async polishOwnerNote(args) {
      const { catalog, refToId } = toCatalogRefs(args.products);
      const pii = { knownNames: args.knownNames, productAliases: allAliases(args.products) };
      const { text, map, count } = stripPII(args.note, pii);
      const itemRefToId = new Map(args.orderItems.map((it, i) => [`item_${i}`, it.id]));
      const payload = {
        note: text,
        orderItems: args.orderItems.map((it, i) => ({ itemRef: `item_${i}`, name: it.name, qty: it.qty, unit: it.unit })),
        catalog,
        politeness: args.politeness,
      };
      assertNoPII(payload, pii);
      opts.onPayload?.('OWNER_NOTE', payload);

      const r = await run('OWNER_NOTE', OwnerNoteResult, count, () => provider.ownerNote(payload));
      if (!r.ok) return r;
      const { result, warnings } = checkOwnerNote(r.data, text);
      const note: ResolvedOwnerNote = restorePII(
        {
          ...result,
          out_of_stock: result.out_of_stock.map((o) => ({ ...o, item_id: o.item_ref ? itemRefToId.get(o.item_ref) ?? null : null })),
          substitutes: result.substitutes.map((s) => ({ ...s, product_id: s.product_ref ? refToId.get(s.product_ref) ?? null : null })),
        },
        map,
      );
      return { ...r, data: { note, warnings } };
    },

    async parseSupplierBill(args) {
      const { catalog, refToId } = toCatalogRefs(args.products);
      // Images are not text-stripped; EXIF stripping/resizing happens before upload (LIFF/dashboard).
      const r = await run('SUPPLIER_BILL', SupplierBillResult, 0, () => provider.supplierBill({ image: args.image, catalog }));
      if (!r.ok) return r;
      const { result, flags } = checkSupplierBill(r.data);
      return {
        ...r,
        data: {
          bill: { ...result, lines: result.lines.map((l) => ({ ...l, product_id: l.product_ref ? refToId.get(l.product_ref) ?? null : null })) },
          flags,
        },
      };
    },

    async parsePaymentSlip(args) {
      if (opts.slipMode === 'manual') {
        const m: AiCallMeta = { task: 'PAYMENT_SLIP', provider: provider.name, model: 'none', promptVersion: PROMPT_VERSIONS.PAYMENT_SLIP, latencyMs: 0, attempts: 0, piiTokens: 0 };
        return { ok: false, error: 'UNAVAILABLE', meta: m };
      }
      const input = provider.name === 'mock' ? { image: args.image, ...(args.mockOnly ? { mockOnly: args.mockOnly } : {}) } : { image: args.image };
      return run('PAYMENT_SLIP', SlipReadResult, 0, () => provider.paymentSlip(input));
    },
  };
}

function stripPIIDeep<T>(value: T, pii: { knownNames: string[]; productAliases: string[] }): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return stripPII(v, pii).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
