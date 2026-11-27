/**
 * Should the owner double-check this draft? Re-evaluated on creation and on EVERY customer edit
 * (not OR-ed forever), so a follow-up that fills in the missing quantity clears the flag.
 * Code decides from the parse + post-check warnings only; it never approves a price or payment.
 */
import type { ResolvedOrderParse } from '@datawan/ai';

export type ReviewReason =
  | 'NO_ITEMS'
  | 'MISSING_QTY'
  | 'NO_PRODUCT_MATCH'
  | 'MISSING_UNIT'
  | 'MISSING_PREP_TYPE'
  | 'MISSING_PRODUCT'
  | 'MISSING_DELIVERY_TIME'
  | 'CLARIFICATION_PENDING'
  | 'CHECK_WARNING';

/** `itemsKept` = the draft's order lines after toNewItems (items without a quantity are dropped). */
export function reviewNeeded(parse: ResolvedOrderParse, itemsKept: unknown[], warnings: string[]): { needed: boolean; reasons: ReviewReason[] } {
  const reasons = new Set<ReviewReason>();
  if (parse.items.length === 0 || itemsKept.length === 0) reasons.add('NO_ITEMS');
  for (const it of parse.items) {
    if (it.qty === null || !(it.qty > 0)) reasons.add('MISSING_QTY');
    if (!it.product_id) reasons.add('NO_PRODUCT_MATCH');
  }
  if (itemsKept.length < parse.items.length) reasons.add('MISSING_QTY');
  for (const f of parse.missing_fields) {
    reasons.add(f === 'qty' ? 'MISSING_QTY' : f === 'unit' ? 'MISSING_UNIT' : f === 'prep_type' ? 'MISSING_PREP_TYPE' : f === 'product' ? 'MISSING_PRODUCT' : 'MISSING_DELIVERY_TIME');
  }
  if (parse.clarification_question_th) reasons.add('CLARIFICATION_PENDING');
  if (warnings.length) reasons.add('CHECK_WARNING');
  return { needed: reasons.size > 0, reasons: [...reasons] };
}
