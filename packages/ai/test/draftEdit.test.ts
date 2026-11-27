/**
 * Draft edits (production A12: "เอาปลาทับทิม" → "5" → "5 โล"). The anti-hallucination check
 * compared items carried over from the previous draft with the NEW message only, so every
 * follow-up raised "raw_text not found in message" and kept the order flagged for review.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogRef, OrderParseResult } from '@datawan/shared';
import { checkOrderParse } from '../src/checks';

const catalog: CatalogRef[] = [{ productRef: 'p0', nameTh: 'ปลาทับทิม', aliases: ['ปลาทับทิม', 'ทับทิม'], unit: 'kg', prepTypes: ['any'] } as CatalogRef];
const parse = (raw: string, qty: number | null = 5): OrderParseResult => ({
  intent: 'modify',
  items: [{ raw_text: raw, product_ref: 'p0', qty, unit: qty === null ? null : 'kg', prep_type: 'any', note: null }],
  delivery_time: { raw_text: null, iso: null },
  missing_fields: qty === null ? ['qty'] : [],
  clarification_question_th: null,
} as OrderParseResult);

describe('checkOrderParse on draft edits', () => {
  it('accepts a raw_text carried over exactly from the previous draft', () => {
    const { warnings } = checkOrderParse(parse('ปลาทับทิม'), { strippedMessage: '5 โล', catalog, draftRawTexts: ['ปลาทับทิม'] });
    expect(warnings).toEqual([]);
  });
  it('still flags a raw_text that is in neither the message nor the previous draft', () => {
    const { warnings } = checkOrderParse(parse('ปลาทับทิมแดง'), { strippedMessage: '5 โล', catalog, draftRawTexts: ['ปลาทับทิม'] });
    expect(warnings).toEqual(['raw_text not found in message: "ปลาทับทิมแดง"']);
  });
  it('without a previous draft the original rule applies', () => {
    expect(checkOrderParse(parse('ปลาทับทิม'), { strippedMessage: '5 โล', catalog }).warnings).toHaveLength(1);
    expect(checkOrderParse(parse('ปลาทับทิม'), { strippedMessage: 'เอาปลาทับทิม 5 โล', catalog }).warnings).toEqual([]);
  });
});
