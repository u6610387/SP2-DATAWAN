/** LIFF recipient card: required form while held, pre-filled summary on repeat orders. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CustomerOrderView } from '@datawan/shared';
import { deliveryReadyView, RecipientCard, showRecipientCard } from '@/components/RecipientCard';
import { th } from '@/lib/i18n/th';

const order = (status: CustomerOrderView['status'], d: Partial<CustomerOrderView['delivery']>) =>
  ({ id: 'o1', status, delivery: { recipientName: null, recipientPhone: null, hasLocation: true, needsRecipient: false, addressText: 'x', lat: null, lng: null, requestedDeliveryAt: null, ...d } }) as unknown as CustomerOrderView;
const render = (o: CustomerOrderView) => renderToStaticMarkup(<RecipientCard order={o} t={th} busy={false} onSave={async () => {}} />);

describe('RecipientCard', () => {
  it('held order: required form with name, tel input, PDPA consent; save disabled until valid', () => {
    const html = render(order('AWAITING_LOCATION', { needsRecipient: true }));
    expect(html).toContain(th.liff.recipientRequiredHint);
    expect(html).toContain('id="recipient-name"');
    expect(html).toMatch(/id="recipient-phone"[^>]*inputMode="tel"|inputMode="tel"[^>]*id="recipient-phone"/);
    expect(html).toContain(th.liff.recipientConsent);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>บันทึกผู้รับ<\/button>/);
  });

  it('repeat order: pre-filled summary with a readable phone and an edit button, no form', () => {
    const html = render(order('AWAITING_PRICE', { recipientName: 'คุณดา', recipientPhone: '0812345678' }));
    expect(html).toContain('คุณดา · โทร 081-234-5678');
    expect(html).toContain(th.liff.recipientEdit);
    expect(html).not.toContain('id="recipient-phone"');
  });

  it('is hidden before a location and once out for delivery', () => {
    expect(showRecipientCard(order('AWAITING_CONFIRMATION', { hasLocation: false }))).toBe(false);
    expect(showRecipientCard(order('AWAITING_LOCATION', { needsRecipient: true }))).toBe(true);
    expect(showRecipientCard(order('PAID', { recipientName: 'คุณดา', recipientPhone: '0812345678' }))).toBe(true);
    expect(showRecipientCard(order('DELIVERING', { recipientName: 'คุณดา', recipientPhone: '0812345678' }))).toBe(false);
  });

  it('PDPA consent: 24×24 px brand-coloured checkbox with a whole-row tap target (≥48 px tall)', () => {
    const html = render(order('AWAITING_LOCATION', { needsRecipient: true }));
    const box = /<input[^>]*id="recipient-consent"[^>]*>/.exec(html)![0];
    expect(box).toContain('type="checkbox"');
    expect(box).toMatch(/\bh-6\b/);
    expect(box).toMatch(/\bw-6\b/);
    expect(box).toContain('accent-[var(--brand)]');
    const label = /<label[^>]*for="recipient-consent"[^>]*>/.exec(html)![0];
    expect(label).toMatch(/\bmin-h-12\b/);
    expect(label).toContain('cursor-pointer');
    // the consent text is inside the label, so tapping the text toggles the box
    expect(html).toMatch(new RegExp(`<label[^>]*for="recipient-consent"[^>]*>[\\s\\S]*${th.liff.recipientConsent.slice(0, 12)}[\\s\\S]*</label>`));
  });

  it('deliveryReadyView: shipping fee only once location + name + phone exist', () => {
    expect(deliveryReadyView(order('AWAITING_SHIPPING_FEE', { recipientName: 'คุณดา', recipientPhone: '0812345678' }))).toBe(true);
    expect(deliveryReadyView(order('AWAITING_SHIPPING_FEE', { recipientName: 'คุณดา', recipientPhone: null }))).toBe(false);
    expect(deliveryReadyView(order('AWAITING_SHIPPING_FEE', { recipientName: null, recipientPhone: '0812345678' }))).toBe(false);
    expect(deliveryReadyView(order('AWAITING_SHIPPING_FEE', { hasLocation: false, recipientName: 'คุณดา', recipientPhone: '0812345678' }))).toBe(false);
  });
});

