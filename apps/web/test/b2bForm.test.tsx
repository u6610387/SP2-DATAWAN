/** LIFF B2B application form: status banner, Tax ID warning, submit gating (server-rendered markup). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CustomerAccountView } from '@datawan/shared';
import { accountErrorMessage, B2bApplicationForm, maxNewPhotos, submitAndReset, UploadError, type B2bFormValues } from '@/components/B2bApplicationForm';
import { ApiRequestError } from '@/lib/api';
import { en } from '@/lib/i18n/en';
import { th } from '@/lib/i18n/th';

type B2b = NonNullable<CustomerAccountView['b2b']>;
const b2b = (p: Partial<B2b>): CustomerAccountView => ({
  type: 'B2C',
  b2b: { status: 'PENDING_VERIFICATION', businessName: 'ร้านครัวทดสอบ', businessType: 'restaurant', addressText: '1 ถนนทดสอบ กรุงเทพ', lat: null, lng: null, deliveryWindow: null, taxId: null, rejectionReason: null, needsRereview: false, documents: [], ...p },
});
const render = (account: CustomerAccountView, initialValues?: Partial<B2bFormValues>) =>
  renderToStaticMarkup(<B2bApplicationForm account={account} t={th} busy={false} onSubmit={async () => true} initialValues={initialValues} />);

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

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}` }));
const fileInput = (html: string) => /<input type="file"[^>]*>/.exec(html)?.[0] ?? '';

describe('B2bApplicationForm photo cap (I2)', () => {
  it('counts documents already on file: 1 existing → 2 more; 3 existing → 0 and adding is disabled', () => {
    expect(maxNewPhotos(b2b({ documents: docs(1) }))).toBe(2);
    expect(maxNewPhotos(b2b({ status: 'VERIFIED', documents: docs(3) }))).toBe(0);
    const one = render(b2b({ documents: docs(1) }));
    expect(one).toContain(th.account.photosRemaining(2));
    expect(fileInput(one)).not.toContain('disabled');
    const full = render(b2b({ status: 'VERIFIED', documents: docs(3) }));
    expect(full).toContain(th.account.photosRemaining(0));
    expect(fileInput(full)).toContain('disabled=""');
  });

  it('REJECTED or no profile → the full 3 (a rejected application\'s documents are purged on re-apply)', () => {
    expect(maxNewPhotos(b2b({ status: 'REJECTED', documents: docs(3) }))).toBe(3);
    expect(maxNewPhotos({ type: 'B2C', b2b: null })).toBe(3);
    expect(render({ type: 'B2C', b2b: null })).toContain(th.account.photosRemaining(3));
  });
});

describe('submitAndReset (I3)', () => {
  it('clears photos and consent only after a successful submit', async () => {
    const reset = vi.fn();
    await submitAndReset(async () => true, reset);
    expect(reset).toHaveBeenCalledTimes(1);
    await submitAndReset(async () => false, reset);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('accountErrorMessage (M2)', () => {
  it('maps API codes to dictionary copy and never shows the server message', () => {
    const err = (code: string) => new ApiRequestError(code === 'TOO_MANY_DOCUMENTS' || code === 'INVALID_FROM_STATE' ? 409 : 400, code, 'english server text');
    expect(accountErrorMessage(err('VALIDATION_FAILED'), th)).toBe(th.account.errors.validation);
    expect(accountErrorMessage(err('INVALID_FROM_STATE'), th)).toBe(th.account.errors.invalidState);
    expect(accountErrorMessage(err('TOO_MANY_DOCUMENTS'), th)).toBe(th.account.errors.tooManyDocuments);
    expect(accountErrorMessage(err('SOMETHING_ELSE'), th)).toBe(th.account.errors.generic);
    expect(accountErrorMessage(new UploadError('upload failed'), th)).toBe(th.account.errors.uploadFailed);
    expect(accountErrorMessage(new TypeError('Failed to fetch'), en)).toBe(en.account.errors.generic);
    for (const code of ['VALIDATION_FAILED', 'INVALID_FROM_STATE', 'TOO_MANY_DOCUMENTS', 'X']) {
      expect(accountErrorMessage(err(code), th)).not.toContain('english');
    }
  });
});
