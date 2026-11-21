import { describe, expect, it } from 'vitest';
import { OrderParseResult, OwnerNoteResult, SlipReadResult, SupplierBillResult } from '@datawan/shared';
import { createAi } from '../src';
import { mockOrderParse } from '../src/mock/provider';
import { toCatalogRefs } from '../src/catalog';
import { NOW, products } from './fixtures';

const payloads: unknown[] = [];
const ai = createAi({ USE_MOCK_AI: true, GEMINI_SLIP_MODE: 'paid' }, { onPayload: (_t, p) => payloads.push(p) }, () => NOW);
const { catalog } = toCatalogRefs(products);
const parse = (message: string) => mockOrderParse({ message, catalog, nowBangkok: '2027-01-14T09:20:00+07:00' });

describe('mock ORDER_PARSE (rule-based)', () => {
  it('parses the contract example', () => {
    const r = parse('เอากุ้งแม่น้ำเป็นๆ 2 โล กับหอยแครงโลนึง ส่งพรุ่งนี้เช้านะคะ');
    expect(OrderParseResult.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({
      intent: 'new_order',
      items: [
        { product_ref: 'p0', raw_text: 'กุ้งแม่น้ำเป็นๆ 2 โล', qty: 2, unit: 'kg', prep_type: 'live' },
        { product_ref: 'p3', raw_text: 'หอยแครงโลนึง', qty: 1, unit: 'kg' },
      ],
      delivery_time: { iso: '2027-01-15T07:00:00+07:00', raw_text: 'พรุ่งนี้เช้า' },
      missing_fields: [],
    });
  });
  it('handles number words, half kilos, ขีด, size notes and times', () => {
    const r = parse('พรุ่งนี้ 6 โมง เอากุ้งขาวไซส์ 40 สามโล หมึกครึ่งโล ปู 5 ขีด');
    expect(r.items.map((i) => [i.product_ref, i.qty, i.unit])).toEqual([
      ['p1', 3, 'kg'],
      ['p4', 0.5, 'kg'],
      ['p2', 0.5, 'kg'],
    ]);
    expect(r.items[0]!.note).toBe('ไซส์ 40');
    expect(r.delivery_time.iso).toBe('2027-01-15T06:00:00+07:00');
  });
  it('flags missing quantity, questions and non-orders', () => {
    expect(parse('เอาหมึกครับ')).toMatchObject({ intent: 'new_order', missing_fields: ['qty'] });
    expect(parse('วันนี้มีปูไหมคะ').intent).toBe('question');
    expect(parse('ขอบคุณค่ะ').intent).toBe('not_order');
  });
  it('is deterministic', () => {
    const m = 'กุ้งแม่น้ำ 2 โล บ่าย 2 โมง';
    expect(parse(m)).toEqual(parse(m));
    expect(parse(m).delivery_time.iso).toBe('2027-01-14T14:00:00+07:00');
  });
});

describe('AiService pipeline', () => {
  it('strips PII before the provider and maps refs back to UUIDs', async () => {
    payloads.length = 0;
    const r = await ai.parseOrder({ message: 'คุณแดงเอากุ้งขาว 2 โล โทร 0812345678', products, knownNames: [], now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(payloads)).not.toContain('0812345678');
    expect(JSON.stringify(payloads)).not.toContain('uuid-');
    expect(r.data.parse.items[0]).toMatchObject({ product_id: 'uuid-kung-khao', qty: 2 });
    expect(r.meta).toMatchObject({ task: 'ORDER_PARSE', provider: 'mock' });
  });
  it('reorders from the previous order', async () => {
    const r = await ai.parseOrder({
      message: 'สั่งเหมือนอาทิตย์ที่แล้วครับ', products, knownNames: [], now: NOW,
      previousOrderItems: [{ productId: 'uuid-pu-ma', qty: 3, unit: 'kg', prepType: 'live' }],
    });
    expect(r.ok && r.data.parse).toMatchObject({ intent: 'reorder', items: [{ product_id: 'uuid-pu-ma', qty: 3 }] });
  });
  it('owner note → polite message with literal price only', async () => {
    const r = await ai.polishOwnerNote({
      note: 'ปูหมด มีกุ้งแม่น้ำ 900', products, knownNames: [], politeness: 'ค่ะ',
      orderItems: [{ id: 'item-uuid-1', name: 'ปูม้า', qty: 1, unit: 'kg' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(OwnerNoteResult.safeParse(r.data.note).success).toBe(true);
    expect(r.data.note.out_of_stock[0]).toMatchObject({ item_id: 'item-uuid-1' });
    expect(r.data.note.substitutes[0]).toMatchObject({ product_id: 'uuid-kung-maenam', price_baht: 900 });
    expect(r.data.note.message_th).toContain('900 บาท');
    expect(r.data.warnings).toEqual([]);
  });
  it('supplier bill mock is schema-valid and flags arithmetic deterministically', async () => {
    const bytes = new Uint8Array(64).map((_, i) => i * 7);
    const a = await ai.parseSupplierBill({ image: { bytes, mimeType: 'image/jpeg' }, products });
    const b = await ai.parseSupplierBill({ image: { bytes, mimeType: 'image/jpeg' }, products });
    expect(a.ok && b.ok && a.data).toEqual(b.ok && b.data);
    if (!a.ok) return;
    expect(SupplierBillResult.safeParse(a.data.bill).success).toBe(true);
    const mathErr = a.data.bill.lines.some((l) => Math.abs(l.qty! * l.unit_price! - l.line_total!) > 1);
    expect(a.data.flags.some((f) => f.kind === 'LINE_MATH')).toBe(mathErr);
  });
  it('slip mock echoes expected amount only via mockOnly; manual mode skips AI', async () => {
    const image = { bytes: new Uint8Array(32).fill(3), mimeType: 'image/jpeg' as const };
    const r = await ai.parsePaymentSlip({ image, mockOnly: { expectedTotalSatang: 197000 } });
    expect(r.ok && SlipReadResult.parse(r.data)).toMatchObject({ is_slip: true, amount: 1970 });
    const manual = createAi({ USE_MOCK_AI: true, GEMINI_SLIP_MODE: 'manual' });
    expect((await manual.parsePaymentSlip({ image })).ok).toBe(false);
  });
  it('USE_MOCK_AI=false uses the (not yet implemented) Gemini provider and fails safe', async () => {
    const real = createAi({ USE_MOCK_AI: false, GEMINI_SLIP_MODE: 'paid', GEMINI_MODEL: 'x' });
    const r = await real.parseOrder({ message: 'กุ้ง 1 โล', products, knownNames: [], now: NOW });
    expect(r).toMatchObject({ ok: false, error: 'UNAVAILABLE', meta: { provider: 'gemini' } });
  });
});
