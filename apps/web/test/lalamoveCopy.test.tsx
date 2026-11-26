/** Lalamove copy card: each value exactly as web.lalamove.com's 4 inputs want it, no prefixes. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OwnerOrderView } from '@datawan/shared';
import { LalamoveCopyCard } from '@/components/LalamoveCopyCard';
import { lalamoveFields } from '@/lib/lalamove';
import { th } from '@/lib/i18n/th';

const order = (d: Partial<OwnerOrderView['delivery']>, card: Partial<NonNullable<OwnerOrderView['lalamoveCard']>> = {}) =>
  ({
    code: 'A12',
    delivery: { recipientName: 'Thanakrit Kodklangdon', recipientPhone: '0933293729', hasLocation: true, needsRecipient: false, addressText: '99/1 ซ.ทดสอบ ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ', lat: 13.613062, lng: 100.836312, requestedDeliveryAt: null, ...d },
    lalamoveCard: { text: '📦 A12 — Lalamove\nผู้รับ: Thanakrit Kodklangdon', mapUrl: 'https://www.google.com/maps/search/?api=1&query=13.613062,100.836312', ...card },
  }) as unknown as OwnerOrderView;

describe('lalamoveFields', () => {
  it('maps to the 4 Lalamove inputs exactly', () => {
    expect(lalamoveFields(order({}))).toEqual({
      pin: '13.613062, 100.836312',
      mapUrl: 'https://www.google.com/maps/search/?api=1&query=13.613062,100.836312',
      name: 'Thanakrit Kodklangdon',
      phoneDisplay: '093-329-3729',
      phoneForPlus66: '933293729',
      address: '99/1 ซ.ทดสอบ ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ',
      all: '📦 A12 — Lalamove\nผู้รับ: Thanakrit Kodklangdon',
    });
  });
  it('phone for +66 drops only the leading 0 (mobile 9 digits, Bangkok landline 8)', () => {
    expect(lalamoveFields(order({ recipientPhone: '081-234-5678' })).phoneForPlus66).toBe('812345678');
    expect(lalamoveFields(order({ recipientPhone: '021234567' })).phoneForPlus66).toBe('21234567');
    expect(lalamoveFields(order({ recipientPhone: '+66812345678' })).phoneForPlus66).toBe('812345678');
  });
  it('pin is 6-decimal "lat, lng" (string coordinates too); map link falls back to Google Maps', () => {
    const f = lalamoveFields(order({ lat: '13.72' as unknown as number, lng: 100.4761 }, { mapUrl: null }));
    expect(f.pin).toBe('13.720000, 100.476100');
    expect(f.mapUrl).toBe('https://www.google.com/maps/search/?api=1&query=13.720000,100.476100');
  });
  it('missing values are null (no "-" placeholders)', () => {
    const f = lalamoveFields(order({ recipientName: null, recipientPhone: 'abc', addressText: '  ', lat: null, lng: null }, { mapUrl: null }));
    expect(f).toMatchObject({ pin: null, mapUrl: null, name: null, phoneDisplay: null, phoneForPlus66: null, address: null });
  });
});

describe('LalamoveCopyCard', () => {
  const html = renderToStaticMarkup(<LalamoveCopyCard order={order({})} t={th} />);
  it('one copy button per field carrying the raw value (no ผู้รับ:/โทร: prefix), plus Copy all', () => {
    expect(html).toContain('data-copy="13.613062, 100.836312"');
    expect(html).toContain('data-copy="Thanakrit Kodklangdon"');
    expect(html).toContain('data-copy="933293729"');
    expect(html).toContain('data-copy="99/1 ซ.ทดสอบ ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ"');
    expect(html).not.toMatch(/data-copy="(ผู้รับ|โทร):/);
    expect(html).toContain(th.orderDetail.lalamoveCopyAll);
  });
  it('shows the readable phone with the +66 box hint and a Google Maps button', () => {
    expect(html).toContain('093-329-3729');
    expect(html).toContain('+66');
    expect(html).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=13.613062,100.836312"');
    for (const label of [th.orderDetail.lalamovePin, th.orderDetail.lalamoveName, th.orderDetail.lalamovePhone, th.orderDetail.lalamoveAddress]) expect(html).toContain(label);
  });
});
