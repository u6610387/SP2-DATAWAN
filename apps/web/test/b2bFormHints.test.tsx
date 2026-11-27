/** /liff/account business form: say why submit is disabled (inline hints + a summary list). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CustomerAccountView } from '@datawan/shared';
import { B2bApplicationForm, missingRequirements, type B2bFormValues } from '@/components/B2bApplicationForm';
import { en } from '@/lib/i18n/en';
import { th } from '@/lib/i18n/th';

const empty: CustomerAccountView = { type: 'B2C', b2b: null };
const filled: B2bFormValues = { businessName: 'ร้านครัวทดสอบ', businessType: 'restaurant', addressText: '1 ถนนทดสอบ กรุงเทพ', windowFrom: '', windowTo: '', taxId: '', consent: true };
const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const render = (v: Partial<B2bFormValues>, t = th) =>
  renderToStaticMarkup(<B2bApplicationForm account={empty} t={t} busy={false} onSubmit={async () => true} initialValues={{ ...filled, ...v }} />);
const submitDisabled = (html: string) => new RegExp(`<button[^>]*disabled=""[^>]*>${th.account.submit}<`).test(html);

describe('missingRequirements', () => {
  it('a complete form has nothing missing', () => expect(missingRequirements(filled)).toEqual([]));
  it.each<[Partial<B2bFormValues>, string]>([
    [{ businessName: '   ' }, 'businessName'],
    [{ addressText: '' }, 'address'],
    [{ addressText: '12 3' }, 'address'],
    [{ taxId: '010553600031' }, 'taxIdLength'],
    [{ windowFrom: '06:00' }, 'deliveryWindow'],
    [{ consent: false }, 'consent'],
  ])('%o → %s', (v, reason) => expect(missingRequirements({ ...filled, ...v })).toEqual([reason]));
  it('an empty tax ID and an invalid checksum are not blocking (warning only)', () => {
    expect(missingRequirements({ ...filled, taxId: '' })).toEqual([]);
    expect(missingRequirements({ ...filled, taxId: '0105536000316' })).toEqual([]);
  });
  it('lists every reason in form order', () =>
    expect(missingRequirements({ ...filled, businessName: '', addressText: '', taxId: '123', consent: false })).toEqual(['businessName', 'address', 'taxIdLength', 'consent']));
});

describe('B2bApplicationForm hints', () => {
  it('a complete form: submit enabled, no "why disabled" summary', () => {
    const html = render({});
    expect(submitDisabled(html)).toBe(false);
    expect(html).not.toContain(th.account.hints.title);
  });

  it('a fresh form: submit disabled and the summary names shop name, address and consent', () => {
    const html = render({ businessName: '', addressText: '', consent: false });
    expect(submitDisabled(html)).toBe(true);
    expect(html).toContain(th.account.hints.title);
    for (const k of ['businessName', 'address', 'consent'] as const) expect(html).toContain(esc(th.account.hints[k]));
    expect(html).not.toContain(esc(th.account.hints.taxIdLength(0)));
  });

  it('a 12-digit tax ID shows an inline hint with the digit count, and blocks submit', () => {
    const html = render({ taxId: '010553600031' });
    expect(html).toContain(esc(th.account.hints.taxIdLength(12)));
    expect(html).toMatch(/id="b2b-taxid"[^>]*aria-invalid="true"/);
    expect(submitDisabled(html)).toBe(true);
  });

  it('a short address and a half-filled delivery window show inline hints', () => {
    expect(render({ addressText: 'ab' })).toContain(esc(th.account.hints.addressShort));
    expect(render({ windowTo: '08:00' })).toContain(esc(th.account.hints.deliveryWindow));
  });

  it('required fields are marked', () => {
    const html = render({});
    for (const id of ['b2b-name', 'b2b-address']) expect(html).toMatch(new RegExp(`for="${id}"[^>]*>[^<]*<span[^>]*>\\*</span>`));
  });

  it('English copy', () => {
    const html = render({ businessName: '', consent: false }, en);
    expect(html).toContain(esc(en.account.hints.title));
    expect(html).toContain(esc(en.account.hints.businessName));
    expect(html).toContain(esc(en.account.hints.consent));
  });
});
