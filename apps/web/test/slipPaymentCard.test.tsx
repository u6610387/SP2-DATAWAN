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
    expect(html).toMatch(/อ่านสลิป · ต้องตรวจ<\/span>: ตรวจด้วยตนเอง/);
  });

  // Production A19: a 105 THB slip to another shop showed a green "REFERENCE · PASS" on a 1 THB order.
  it('REFERENCE · PASS says it did NOT check amount, receiver or time; those show as not checked', () => {
    const html = render(order({ checks: [
      { rule: 'READABLE', result: 'WARN', detail: 'manual' },
      { rule: 'REFERENCE', result: 'PASS', detail: 'QR ธนาคารถูกต้อง' },
    ] }));
    expect(html).toContain(`เลขอ้างอิง (QR) · ${th.orderDetail.slipReferencePass}`);
    expect(html).not.toMatch(/REFERENCE · PASS/);
    for (const rule of ['ยอดเงิน', 'ผู้รับ', 'เวลาโอน']) expect(html).toContain(`${rule} · ${th.orderDetail.slipNotChecked}`);
  });

  it('manual mode: no inputs needed — ยืนยันรับเงิน is enabled; ปฏิเสธ waits for a reason', () => {
    const html = render(order({ checks: [{ rule: 'READABLE', result: 'WARN', detail: 'manual' }, { rule: 'REFERENCE', result: 'PASS', detail: 'qr ok' }] }));
    expect(html).not.toContain('type="datetime-local"');
    expect(html).not.toContain('type="checkbox"');
    const button = (label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`))?.[0] ?? '';
    expect(button(th.orderDetail.confirmPayment)).not.toContain('disabled=""');
    expect(button(th.orderDetail.rejectSlip)).toContain('disabled=""');
    expect(html).toContain(th.orderDetail.rejectNeedsReason);
  });

  it('a duplicate / tampered QR (FAIL): red banner, and confirm needs a reason', () => {
    const html = render(order({ result: 'FAIL', checks: [{ rule: 'REFERENCE', result: 'FAIL', detail: 'สลิปซ้ำ: เคยใช้กับออเดอร์ A3 แล้ว' }] }));
    expect(html).toContain(th.orderDetail.slipMismatchBanner);
    expect(html).toContain('เลขอ้างอิง (QR): สลิปซ้ำ');
    expect(html).toContain(th.orderDetail.slipOverrideRequired);
    const confirm = html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${th.orderDetail.confirmPayment}`))?.[0] ?? '';
    expect(confirm).toContain('disabled=""');
  });

  it('AI already read the amount (paid mode): no checklist; stored FAILs get the red banner', () => {
    const html = render(order({ result: 'FAIL', checks: [
      { rule: 'READABLE', result: 'PASS', detail: 'อ่านครบ' },
      { rule: 'AMOUNT', result: 'FAIL', detail: 'สลิป ฿105.00 ≠ ยอด ฿1.00' },
    ] }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(th.orderDetail.slipMismatchBanner);
    expect(html).toContain('ยอดเงิน: สลิป ฿105.00 ≠ ยอด ฿1.00');
    expect(html).toContain(th.orderDetail.slipOverrideRequired);
  });

  it('says so instead of rendering nothing when the URL is missing', () => {
    const html = render(order({ slipImageUrl: null }));
    expect(html).not.toContain('<img');
    expect(html).toContain(th.orderDetail.slipImageMissing);
  });
});
