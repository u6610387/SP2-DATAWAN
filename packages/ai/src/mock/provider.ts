/**
 * Deterministic mock provider (USE_MOCK_AI=true).
 * Same inputs → same outputs. Output JSON must satisfy the Zod contracts; the
 * service validates it exactly like real Gemini output.
 *
 * ORDER_PARSE / OWNER_NOTE are rule-based so real Thai chat works end-to-end.
 * SUPPLIER_BILL / PAYMENT_SLIP return fixtures derived from the image bytes.
 */
import type {
  OrderParseInput,
  OrderParseResult,
  OwnerNoteInput,
  OwnerNoteResult,
  PaymentSlipInput,
  SlipReadResult,
  SupplierBillInput,
  SupplierBillResult,
  MissingField,
} from '@datawan/shared';
import type { AiProvider, ProviderResult } from '../types';
import { detectNote, detectPrep, extractNumbers, findProducts, findQuantity, fnv1a, parseDeliveryTime } from './thaiText';

const MODEL = 'mock-deterministic-v1';
const ok = (json: unknown): ProviderResult => ({ ok: true, json, model: MODEL, attempts: 1 });

const REORDER_RE = /เหมือนเดิม|เหมือนอาทิตย์ที่แล้ว|เหมือนครั้งก่อน|เหมือนรอบก่อน|สั่งซ้ำ/;
const ORDER_VERB_RE = /เอา|สั่ง|ขอ(?!บคุณ|โทษ)|ส่ง|อยากได้/;
const QUESTION_RE = /ไหม|มั้ย|เท่าไหร่|เท่าไร|กี่บาท|\?/;

const ASK: Record<MissingField, string> = {
  product: 'ต้องการสินค้าอะไรคะ',
  qty: 'ต้องการจำนวนเท่าไหร่คะ',
  unit: 'หน่วยเป็นกิโลหรือตัวคะ',
  prep_type: 'ต้องการแบบเป็นหรือแช่เย็นคะ',
  delivery_time: 'ต้องการให้ส่งวันไหน เวลาไหนคะ',
};

export function mockOrderParse(input: OrderParseInput): OrderParseResult {
  const text = input.message;
  const delivery_time = parseDeliveryTime(text, input.nowBangkok);
  const reorder = REORDER_RE.exec(text);

  if (reorder) {
    const items = (input.previousOrder?.items ?? []).map((it) => ({
      product_ref: it.productRef,
      raw_text: reorder[0],
      qty: it.qty,
      unit: it.unit,
      prep_type: it.prepType,
      note: null,
    }));
    const missing: MissingField[] = items.length ? [] : ['product'];
    return { intent: 'reorder', items, delivery_time, missing_fields: missing, clarification_question_th: question(missing) };
  }

  const hits = findProducts(text, input.catalog);
  const items = hits.map((h, i) => {
    const segEnd = Math.min(hits[i + 1]?.start ?? text.length, h.end + 30);
    const seg = text.slice(h.end, segEnd);
    const q = findQuantity(seg, h.end);
    const end = q ? q.end : h.end;
    return {
      product_ref: h.ref.productRef,
      raw_text: text.slice(h.start, end),
      qty: q?.qty ?? null,
      unit: q?.unit ?? null,
      prep_type: detectPrep(text.slice(h.start, segEnd)),
      note: detectNote(seg),
    };
  });

  let intent: OrderParseResult['intent'];
  if (items.length && QUESTION_RE.test(text) && items.every((i) => i.qty === null)) intent = 'question';
  else if (items.length) intent = input.previousDraft ? 'modify' : 'new_order';
  else if (QUESTION_RE.test(text)) intent = 'question';
  else if (ORDER_VERB_RE.test(text) || findQuantity(text, 0)) intent = 'new_order';
  else intent = 'not_order';

  // Editing an existing draft without naming products: keep the previous items, and let a bare
  // quantity ("2 โล") answer the first item that is still missing one.
  let finalItems: OrderParseResult["items"] = items;
  if (!items.length && input.previousDraft && input.previousDraft.items.length) {
    finalItems = input.previousDraft.items.map((it) => ({ ...it }));
    const q = findQuantity(text, 0);
    const idx = finalItems.findIndex((it) => it.qty === null);
    if (q && idx >= 0) finalItems[idx] = { ...finalItems[idx]!, qty: q.qty, unit: q.unit };
    intent = 'modify';
  }

  const missing = new Set<MissingField>();
  if ((intent === 'new_order' || intent === 'modify') && finalItems.length === 0) missing.add('product');
  if (intent !== 'question' && finalItems.some((i) => i.qty === null)) missing.add('qty');
  const missing_fields = [...missing];
  return {
    intent,
    items: intent === 'question' || intent === 'not_order' ? [] : finalItems,
    delivery_time,
    missing_fields,
    clarification_question_th: question(missing_fields),
  };
}

function question(missing: MissingField[]): string | null {
  return missing.length ? missing.map((m) => ASK[m]).join(' และ') : null;
}

export function mockOwnerNote(input: OwnerNoteInput): OwnerNoteResult {
  const note = input.note;
  const p = input.politeness;
  const q = p === 'ค่ะ' ? 'คะ' : 'ครับ';
  const hits = findProducts(note, input.catalog);
  const out_of_stock: OwnerNoteResult['out_of_stock'] = [];
  const substitutes: OwnerNoteResult['substitutes'] = [];

  const subStart = /(มี|แทน|เปลี่ยนเป็น)/.exec(note)?.index ?? Infinity;
  for (const [i, h] of hits.entries()) {
    const after = note.slice(h.end, hits[i + 1]?.start ?? note.length);
    if (/^\s*หมด/.test(after) || (h.start < subStart && /หมด/.test(after))) {
      const item = input.orderItems.find((it) => h.ref.aliases.some((a) => it.name.includes(a)) || it.name === h.ref.nameTh);
      out_of_stock.push({ item_ref: item?.itemRef ?? null, raw_text: h.alias });
    } else if (h.start > subStart || /\d/.test(after)) {
      const qm = findQuantity(after, 0);
      const rest = qm ? after.slice(qm.end) : after;
      const price = extractNumbers(rest)[0] ?? null;
      substitutes.push({
        product_ref: h.ref.productRef,
        name_th: h.ref.nameTh,
        qty: qm?.qty ?? null,
        unit: qm?.unit ?? null,
        price_baht: price,
      });
    }
  }

  let message_th: string;
  if (out_of_stock.length || substitutes.length) {
    const oos = out_of_stock.map((o) => o.raw_text).join(' ');
    const subs = substitutes
      .map((s) => `${s.name_th}${s.qty ? ` ${s.qty} ${s.unit === 'kg' ? 'กก.' : s.unit ?? ''}` : ''}${s.price_baht !== null ? ` ราคา ${s.price_baht} บาท` : ''}`)
      .join(' และ');
    message_th =
      `ขออภัย${p} ` +
      (oos ? `วันนี้${oos}หมดแล้ว ` : '') +
      (subs ? `ทางร้านมี${subs}แทนได้${p} สนใจรับแทนไหม${q}` : `ร้านจะแจ้งรายการแทนให้อีกครั้งนะ${q}`);
  } else {
    message_th = `แจ้งจากร้าน: ${note.trim()} ${p}`;
  }
  return { message_th: message_th.slice(0, 500), out_of_stock, substitutes };
}

export function mockSupplierBill(input: SupplierBillInput): SupplierBillResult {
  const h = fnv1a(input.image.bytes);
  if (input.image.bytes.length === 0 || input.catalog.length === 0) {
    return { is_bill: input.image.bytes.length > 0, supplier_name: null, bill_date: null, lines: [], bill_total: null };
  }
  const n = Math.min(3, input.catalog.length);
  const lines = Array.from({ length: n }, (_, i) => {
    const ref = input.catalog[(h + i) % input.catalog.length]!;
    const qty = 1 + ((h >>> (3 + i)) % 5);
    const unit_price = 100 * (2 + ((h >>> (5 + i)) % 8));
    // Odd fingerprint → first line has a deliberate arithmetic error to exercise LINE_MATH flags.
    const line_total = qty * unit_price + (i === 0 && h % 2 === 1 ? 10 : 0);
    return { name: ref.nameTh, product_ref: ref.productRef, qty, unit: ref.unit === 'kg' ? 'กก.' : ref.unit, unit_price, line_total, legible: true };
  });
  return {
    is_bill: true,
    supplier_name: 'แพปลาตัวอย่าง (mock)',
    bill_date: '2027-01-14',
    lines,
    bill_total: lines.reduce((a, l) => a + (l.line_total ?? 0), 0),
  };
}

export function mockPaymentSlip(input: PaymentSlipInput, now: () => Date = () => new Date()): SlipReadResult {
  if (input.image.bytes.length < 16) {
    return { is_slip: false, bank: null, amount: null, date_time: null, receiver_name_or_id: null, reference_no: null };
  }
  const expected = input.mockOnly?.expectedTotalSatang;
  const t = new Date(now().getTime() + 7 * 3600_000).toISOString().slice(0, 19);
  return {
    is_slip: true,
    bank: 'KBANK',
    amount: expected != null ? expected / 100 : null,
    date_time: `${t}+07:00`,
    receiver_name_or_id: input.mockOnly?.receiverName ?? null,
    reference_no: `MOCK${fnv1a(input.image.bytes).toString(16).toUpperCase().padStart(8, '0')}`,
  };
}

export function createMockProvider(opts: { now?: () => Date } = {}): AiProvider {
  return {
    name: 'mock',
    orderParse: async (i) => ok(mockOrderParse(i)),
    ownerNote: async (i) => ok(mockOwnerNote(i)),
    supplierBill: async (i) => ok(mockSupplierBill(i)),
    paymentSlip: async (i) => ok(mockPaymentSlip(i, opts.now)),
  };
}
