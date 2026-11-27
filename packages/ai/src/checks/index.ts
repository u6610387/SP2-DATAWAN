/**
 * Deterministic post-checks (gemini-structured-pipeline §4). They may flag or
 * downgrade AI output, never approve anything.
 */
import type { BillFlag, CatalogRef, MissingField, OrderParseResult, OwnerNoteResult, SupplierBillResult } from '@datawan/shared';
import { extractNumbers } from '../mock/thaiText';

const MAX_QTY: Record<string, number> = { kg: 50, piece: 200, box: 50, tray: 50, set: 50 };

export function checkOrderParse(
  r: OrderParseResult,
  ctx: {
    strippedMessage: string;
    catalog: CatalogRef[];
    allowDraftItems?: boolean;
    /**
     * raw_text spans of the previous draft (PII-stripped). On an edit, an item may keep a span the
     * customer wrote in an EARLIER message, but only exactly as it was; anything new must be in this message.
     */
    draftRawTexts?: string[];
  },
): { result: OrderParseResult; warnings: string[] } {
  const warnings: string[] = [];
  const missing = new Set<MissingField>(r.missing_fields);
  const refs = new Map(ctx.catalog.map((c) => [c.productRef, c]));
  const items = r.items.map((it) => {
    const out = { ...it };
    if (out.product_ref !== null && !refs.has(out.product_ref)) {
      warnings.push(`unknown product_ref ${out.product_ref}`);
      out.product_ref = null;
    }
    const prod = out.product_ref ? refs.get(out.product_ref) : undefined;
    if (out.qty !== null && out.unit && out.qty > (MAX_QTY[out.unit] ?? 50)) {
      warnings.push(`qty out of range: ${out.qty} ${out.unit}`);
      out.qty = null;
      missing.add('qty');
    }
    if (out.qty !== null && out.unit === null) missing.add('unit');
    if (prod && out.unit && out.unit !== prod.unit) {
      warnings.push(`unit ${out.unit} differs from catalog unit ${prod.unit} for ${prod.nameTh}`);
      missing.add('unit');
    }
    if (prod && out.prep_type !== 'any' && !prod.prepTypes.includes(out.prep_type) && !prod.prepTypes.includes('any')) {
      warnings.push(`prep ${out.prep_type} not offered for ${prod.nameTh}`);
      missing.add('prep_type');
    }
    // Anti-hallucination: the span must exist in what the customer actually wrote.
    if (!ctx.allowDraftItems && r.intent !== 'reorder' && !ctx.strippedMessage.includes(out.raw_text) && !(ctx.draftRawTexts ?? []).includes(out.raw_text)) {
      warnings.push(`raw_text not found in message: "${out.raw_text}"`);
    }
    return out;
  });
  return { result: { ...r, items, missing_fields: [...missing] }, warnings };
}

/** Prices the AI returns must appear literally in the owner's note (the AI may not invent prices). */
export function checkOwnerNote(r: OwnerNoteResult, note: string): { result: OwnerNoteResult; warnings: string[] } {
  const warnings: string[] = [];
  const nums = new Set(extractNumbers(note));
  const substitutes = r.substitutes.map((s) => {
    if (s.price_baht !== null && !nums.has(s.price_baht)) {
      warnings.push(`invented price ${s.price_baht} removed`);
      return { ...s, price_baht: null };
    }
    return s;
  });
  for (const s of substitutes) {
    if (s.price_baht !== null && !extractNumbers(r.message_th).includes(s.price_baht)) {
      warnings.push(`message does not mention price ${s.price_baht}`);
    }
  }
  return { result: { ...r, substitutes }, warnings };
}

/** Arithmetic & legibility flags for supplier bills (AI_EVALUATION math-flag recall must be 100%). */
export function checkSupplierBill(r: SupplierBillResult): { result: SupplierBillResult; flags: BillFlag[] } {
  const flags: BillFlag[] = [];
  let bill_date = r.bill_date;
  if (bill_date && /^\d{4}-\d{2}-\d{2}$/.test(bill_date)) {
    const y = Number(bill_date.slice(0, 4));
    if (y > 2400) bill_date = `${y - 543}${bill_date.slice(4)}`; // พ.ศ. → ค.ศ.
  }
  r.lines.forEach((l, i) => {
    if (!l.legible || l.qty === null || l.unit_price === null || l.line_total === null) {
      flags.push({ lineIndex: i, kind: 'UNREADABLE', detail: `บรรทัด ${i + 1} อ่านไม่ครบ` });
    } else if (Math.abs(l.qty * l.unit_price - l.line_total) > 1) {
      flags.push({ lineIndex: i, kind: 'LINE_MATH', detail: `${l.qty} × ${l.unit_price} ≠ ${l.line_total}` });
    }
    if (l.product_ref === null) flags.push({ lineIndex: i, kind: 'NO_PRODUCT_MATCH', detail: `ไม่พบสินค้า "${l.name}"` });
  });
  if (r.bill_total !== null) {
    const sum = r.lines.reduce((a, l) => a + (l.line_total ?? 0), 0);
    if (Math.abs(sum - r.bill_total) > 1) flags.push({ lineIndex: null, kind: 'TOTAL_MATH', detail: `รวมบรรทัด ${sum} ≠ ยอดบิล ${r.bill_total}` });
  }
  return { result: { ...r, bill_date }, flags };
}
