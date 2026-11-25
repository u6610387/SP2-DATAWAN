/**
 * Regression for production order A5: the owner card showed "WARN · READABLE" but no slip image.
 * The worker already returned latestPayment.slipImageUrl (signed, 600 s); the dashboard card
 * never rendered it. The image must show for every check result, since on WARN/FAIL (and on
 * every slip in GEMINI_SLIP_MODE=manual) the owner decides from the picture.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OwnerOrderView, PaymentCheckView } from '@datawan/shared';
import { SlipPaymentCard } from '@/components/SlipPaymentCard';
import { th } from '@/lib/i18n/th';

const URL_ = 'https://example.supabase.co/storage/v1/object/sign/slips/o1/s1.jpeg?token=abc';

function order(payment: Partial<PaymentCheckView>): OwnerOrderView {
  return {
    status: 'PAYMENT_REVIEW',
    latestPayment: { id: 'pay-1', result: 'WARN', checks: [{ rule: 'READABLE', result: 'WARN', detail: 'x' }], extracted: null, slipImageUrl: URL_, ...payment },
  } as unknown as OwnerOrderView;
}

const render = (o: OwnerOrderView) =>
  renderToStaticMarkup(<SlipPaymentCard order={o} t={th} busy={false} onConfirm={() => {}} onReject={() => {}} />);

describe('SlipPaymentCard', () => {
  it.each(['WARN', 'FAIL', 'PASS', 'PENDING'] as const)('shows the slip image on %s, linked to full size', (result) => {
    const html = render(order({ result }));
    const escaped = URL_.replace(/&/g, '&amp;');
    expect(html).toContain(`<img src="${escaped}"`);
    expect(html).toContain(`alt="${th.orderDetail.slipImageAlt}"`);
    expect(html).toContain(`href="${escaped}"`);
    expect(html).toContain('target="_blank"');
  });

  it('WARN with no AI read still shows the check detail next to the image', () => {
    const html = render(order({ checks: [{ rule: 'READABLE', result: 'WARN', detail: 'ตรวจด้วยตนเอง: ระบบไม่ได้อ่านสลิปอัตโนมัติ' }] }));
    expect(html).toContain('<img');
    expect(html).toContain('READABLE: ตรวจด้วยตนเอง');
  });

  it('says so instead of rendering nothing when the URL is missing', () => {
    const html = render(order({ slipImageUrl: null }));
    expect(html).not.toContain('<img');
    expect(html).toContain(th.orderDetail.slipImageMissing);
  });
});
