/**
 * needs_owner_review is re-evaluated on every draft edit (production A12: "เอาปลาทับทิม" → "5" →
 * "5 โล" stayed flagged after the quantity was filled in, because the flag was OR-ed forever).
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedOrderParse } from '@datawan/ai';
import { reviewNeeded } from '../src/services/review';
import { makeHarness } from './harness';

const parse = (items: { product_id: string | null; qty: number | null }[], extra: Partial<ResolvedOrderParse> = {}): ResolvedOrderParse =>
  ({ intent: 'new_order', items: items.map((i) => ({ raw_text: 'x', unit: i.qty === null ? null : 'kg', prep_type: 'any', note: null, ...i })), delivery_time: { raw_text: null, iso: null }, missing_fields: [], clarification_question_th: null, ...extra }) as ResolvedOrderParse;
const items = (n: number) => Array.from({ length: n }, () => ({}));

describe('reviewNeeded', () => {
  it('false only when every item has a product and a positive quantity, with no open signals', () => {
    expect(reviewNeeded(parse([{ product_id: 'p1', qty: 5 }]), items(1), [])).toEqual({ needed: false, reasons: [] });
  });
  it.each([
    ['no items at all', parse([]), items(0), [], 'NO_ITEMS'],
    ['item without a quantity (dropped from the draft)', parse([{ product_id: 'p1', qty: null }], { missing_fields: ['qty'] }), items(0), [], 'MISSING_QTY'],
    ['item without a product match', parse([{ product_id: null, qty: 2 }]), items(1), [], 'NO_PRODUCT_MATCH'],
    ['open missing field', parse([{ product_id: 'p1', qty: 2 }], { missing_fields: ['prep_type'] }), items(1), [], 'MISSING_PREP_TYPE'],
    ['clarification question pending', parse([{ product_id: 'p1', qty: 2 }], { clarification_question_th: 'ตัวเล็กหรือตัวใหญ่คะ' }), items(1), [], 'CLARIFICATION_PENDING'],
    ['post-check warning', parse([{ product_id: 'p1', qty: 2 }]), items(1), ['qty out of range: 999 kg'], 'CHECK_WARNING'],
  ])('true when %s', (_n, p, it_, w, reason) => {
    const r = reviewNeeded(p, it_, w);
    expect(r.needed).toBe(true);
    expect(r.reasons).toContain(reason);
  });
});

describe('multi-message drafts', () => {
  const seed = (h: ReturnType<typeof makeHarness>) =>
    h.repo.seedProducts([{ id: 'p-tub', name_th: 'ปลาทับทิม', aliases: ['ปลาทับทิม', 'ทับทิม'], unit: 'kg', prep_types: ['any'] }]);
  const flagAfter = async (h: ReturnType<typeof makeHarness>, msgs: string[]) => {
    const out: boolean[] = [];
    for (const m of msgs) {
      await h.customerText(m);
      out.push(h.repo.orders.at(-1)!.needs_owner_review);
    }
    return out;
  };

  it('A12: no quantity → flagged; quantity filled in later → cleared, with one product line', async () => {
    const h = makeHarness(); seed(h);
    expect(await flagAfter(h, ['เอาปลาทับทิม', '5', '5 โล'])).toEqual([true, true, false]);
    const o = h.repo.orders.at(-1)!;
    expect(h.repo.items.filter((i) => i.order_id === o.id).map((i) => [i.product_id, i.qty])).toEqual([['p-tub', 5]]);
    const ev = h.repo.events.filter((e) => e.order_id === o.id && e.event === 'REVIEW_CLEARED');
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0]!.payload)).not.toContain('ปลาทับทิม'); // reason codes only, no customer text
  });

  it('still incomplete after the follow-up → stays flagged', async () => {
    const h = makeHarness(); seed(h);
    expect(await flagAfter(h, ['เอาปลาทับทิม', 'ขอตัวสวยๆ นะคะ'])).toEqual([true, true]);
  });

  it('unrecognised product stays flagged until the customer names a real one', async () => {
    const h = makeHarness(); seed(h);
    expect(await flagAfter(h, ['กุ้งมังกร 2 โล', 'กุ้งมังกรตัวใหญ่ 2 โล', 'ปลาทับทิม 2 โล'])).toEqual([true, true, false]);
    expect(h.notifier.alerts.filter((a) => a.kind === 'NEEDS_REVIEW')).toHaveLength(1); // alert once per order
  });

  it('out-of-range quantity (post-check warning) keeps the flag; a sane quantity clears it', async () => {
    const h = makeHarness(); seed(h);
    expect(await flagAfter(h, ['ปลาทับทิม 999 โล', 'ปลาทับทิม 3 โล'])).toEqual([true, false]);
  });

  it('a complete first message is never flagged', async () => {
    const h = makeHarness(); seed(h);
    expect(await flagAfter(h, ['ปลาทับทิม 2 โล'])).toEqual([false]);
  });
});
