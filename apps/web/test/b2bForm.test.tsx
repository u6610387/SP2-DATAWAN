/** LIFF B2B application form: status banner, Tax ID warning, submit gating (server-rendered markup). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CustomerAccountView } from '@datawan/shared';
import { B2bApplicationForm, type B2bFormValues } from '@/components/B2bApplicationForm';
import { th } from '@/lib/i18n/th';

type B2b = NonNullable<CustomerAccountView['b2b']>;
const b2b = (p: Partial<B2b>): CustomerAccountView => ({
  type: 'B2C',
  b2b: { status: 'PENDING_VERIFICATION', businessName: 'ร้านครัวทดสอบ', businessType: 'restaurant', addressText: '1 ถนนทดสอบ กรุงเทพ', lat: null, lng: null, deliveryWindow: null, taxId: null, rejectionReason: null, needsRereview: false, documents: [], ...p },
});
const render = (account: CustomerAccountView, initialValues?: Partial<B2bFormValues>) =>
  renderToStaticMarkup(<B2bApplicationForm account={account} t={th} busy={false} onSubmit={async () => {}} initialValues={initialValues} />);

describe('B2bApplicationForm', () => {
  it('no application: no banner, submit disabled', () => {
    const html = render({ type: 'B2C', b2b: null });
    expect(html).not.toContain(th.account.statusPending);
    expect(html).not.toContain(th.account.statusRejected);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>ส่งให้ร้านตรวจสอบ<\/button>/);
    expect(html).toContain('id="b2b-consent"');
  });

  it('rejected: banner shows the reason and a reapply button', () => {
    const html = render(b2b({ status: 'REJECTED', rejectionReason: 'ไม่พบหน้าร้าน' }));
    expect(html).toContain('ไม่พบหน้าร้าน');
    expect(html).toContain('สมัครใหม่');
  });

  it('verified + needsRereview: shows verified and the re-review banner', () => {
    const html = render(b2b({ status: 'VERIFIED', needsRereview: true }));
    expect(html).toContain(th.account.statusVerified);
    expect(html).toContain('ส่งให้ร้านตรวจอีกครั้ง');
  });

  it('Tax ID checksum warning appears for a bad ID only', () => {
    expect(render({ type: 'B2C', b2b: null }, { taxId: '0105536000316' })).toContain(th.account.taxIdInvalid);
    expect(render({ type: 'B2C', b2b: null }, { taxId: '0105536000313' })).not.toContain(th.account.taxIdInvalid);
  });

  it('a bad checksum still allows submit once the rest is filled', () => {
    const html = render({ type: 'B2C', b2b: null }, { businessName: 'ร้านครัวทดสอบ', addressText: '1 ถนนทดสอบ กรุงเทพ', taxId: '0105536000316', consent: true });
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>ส่งให้ร้านตรวจสอบ<\/button>/);
  });
});
