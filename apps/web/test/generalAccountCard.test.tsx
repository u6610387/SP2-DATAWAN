/** /liff/account: the "ลูกค้าทั่วไป" tab shows a status card instead of a blank area. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CustomerAccountView } from '@datawan/shared';
import { B2bApplicationForm, GeneralAccountCard } from '@/components/B2bApplicationForm';
import { en } from '@/lib/i18n/en';
import { th } from '@/lib/i18n/th';

const b2c: CustomerAccountView = { type: 'B2C', b2b: null };
const verified: CustomerAccountView = {
  type: 'B2B',
  b2b: { status: 'VERIFIED', businessName: 'ร้านครัวทดสอบ', businessType: 'restaurant', addressText: '1 ถนนทดสอบ กรุงเทพ', lat: null, lng: null, deliveryWindow: null, taxId: null, rejectionReason: null, needsRereview: false, documents: [] },
};
const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const card = (account: CustomerAccountView, t = th) => renderToStaticMarkup(<GeneralAccountCard account={account} t={t} onSwitchToBusiness={() => {}} />);

describe('GeneralAccountCard', () => {
  it('B2C (TH): badge title, order-in-chat note, pin-per-order note, switch button', () => {
    const html = card(b2c);
    expect(html).toContain(th.account.generalTitle);
    expect(th.account.generalTitle).toBe('บัญชีลูกค้าทั่วไป');
    expect(html).toContain(esc(th.account.generalOrderNote));
    expect(html).toContain(th.account.generalPinNote);
    expect(html).toContain(th.account.switchToBusiness);
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  it('B2C (EN): the same card in English', () => {
    const html = card(b2c, en);
    expect(html).toContain('General customer account');
    expect(html).toContain(esc(en.account.generalOrderNote));
    expect(html).toContain(en.account.switchToBusiness);
    expect(html).not.toContain(th.account.generalTitle);
  });

  it('a verified shop sees that it is a shop account, not "general customer"', () => {
    const html = card(verified);
    expect(html).not.toContain(th.account.generalTitle);
    expect(html).toContain(th.account.verifiedShopNote);
    expect(html).toContain(th.account.viewShopDetails);
  });
});

describe('B2bApplicationForm: the general tab is never blank', () => {
  it('collapsed (rejected application) shows the general card where the form was', () => {
    const rejected: CustomerAccountView = { type: 'B2C', b2b: { ...verified.b2b!, status: 'REJECTED', rejectionReason: 'ไม่พบหน้าร้าน' } };
    const html = renderToStaticMarkup(<B2bApplicationForm account={rejected} t={th} busy={false} onSubmit={async () => true} />);
    expect(html).toContain(th.account.generalTitle);
    expect(html).not.toContain('id="b2b-name"');
  });

  it('the business tab is unchanged: form shown, no general card', () => {
    const html = renderToStaticMarkup(<B2bApplicationForm account={b2c} t={th} busy={false} onSubmit={async () => true} />);
    expect(html).toContain('id="b2b-name"');
    expect(html).not.toContain(th.account.generalTitle);
  });
});
