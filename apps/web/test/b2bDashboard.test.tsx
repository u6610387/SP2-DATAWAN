/** Owner B2B review: badge + per-state action set + Tax ID flag. Fake data only. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OwnerB2bDetailView } from '@datawan/shared';
import { B2bBadge } from '@/components/B2bBadge';
import { B2bActions, B2bDetailFields } from '@/components/B2bReview';
import { th } from '@/lib/i18n/th';

const view = (p: Partial<OwnerB2bDetailView>): OwnerB2bDetailView => ({
  userId: 'u-fake', customerName: 'คุณทดสอบ', businessName: 'ร้านครัวทดสอบ', businessType: 'restaurant', status: 'PENDING_VERIFICATION', needsRereview: false,
  submittedAt: '2026-11-27T01:00:00.000Z', phone: '0800000000', addressText: '1 ถนนทดสอบ', lat: null, lng: null, mapUrl: null, deliveryWindow: '06:00-08:00',
  taxId: '0000000000000', taxIdValid: null, rereviewFields: [], rejectionReason: null, decidedAt: null, verifiedAt: null, documents: [], ...p,
});
const actions = (v: OwnerB2bDetailView) => renderToStaticMarkup(<B2bActions view={v} t={th} busy={false} onApprove={async () => {}} onReject={async () => {}} onAcknowledge={async () => {}} onRevoke={async () => {}} />);

describe('B2bBadge', () => {
  it('renders nothing for null', () => expect(renderToStaticMarkup(<B2bBadge b2b={null} />)).toBe(''));
  it('renders the shop name', () => {
    expect(renderToStaticMarkup(<B2bBadge b2b={{ businessName: 'ร้านครัวทดสอบ', deliveryWindow: '06:00-08:00' }} />)).toContain('[B2B - ร้านครัวทดสอบ]');
  });
});

describe('B2bActions', () => {
  it('pending: approve and reject, no acknowledge', () => {
    const html = actions(view({}));
    expect(html).toContain(th.customers.approve);
    expect(html).toContain(th.customers.reject);
    expect(html).not.toContain(th.customers.acknowledge);
    expect(html).not.toContain(th.customers.revoke);
  });
  it('verified with re-review: acknowledge and revoke, no approve', () => {
    const html = actions(view({ status: 'VERIFIED', needsRereview: true }));
    expect(html).toContain(th.customers.acknowledge);
    expect(html).toContain(th.customers.revoke);
    expect(html).not.toContain('>' + th.customers.approve + '<');
  });
  it('verified without re-review: revoke only', () => {
    const html = actions(view({ status: 'VERIFIED' }));
    expect(html).toContain(th.customers.revoke);
    expect(html).not.toContain(th.customers.acknowledge);
  });
  it('rejected: no actions', () => expect(actions(view({ status: 'REJECTED' }))).toBe(''));
});

describe('B2bDetailFields', () => {
  it('flags an invalid Tax ID with a cross', () => {
    expect(renderToStaticMarkup(<B2bDetailFields view={view({ taxIdValid: false })} t={th} />)).toContain('✗');
  });
  it('shows a tick for a valid Tax ID and thumbnails from signed urls', () => {
    const html = renderToStaticMarkup(<B2bDetailFields view={view({ taxIdValid: true, documents: [{ id: 'd1', url: 'https://example.test/doc1' }] })} t={th} />);
    expect(html).toContain('✓');
    expect(html).toContain('src="https://example.test/doc1"');
  });
});
