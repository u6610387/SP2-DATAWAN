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
    delivery: { recipientName: 'คุณทดสอบ ตัวอย่าง', recipientPhone: '0812345678', hasLocation: true, needsRecipient: false, addressText: '99/1 ซ.ทดสอบ ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ', lat: 13.723456, lng: 100.476543, requestedDeliveryAt: null, ...d },
    lalamoveCard: { text: '📦 A12 — Lalamove\nผู้รับ: คุณทดสอบ ตัวอย่าง', mapUrl: 'https://www.google.com/maps/search/?api=1&query=13.723456,100.476543', ...card },
  }) as unknown as OwnerOrderView;

describe('lalamoveFields', () => {
  it('maps to the 4 Lalamove inputs exactly', () => {
    expect(lalamoveFields(order({}))).toEqual({
      pin: '13.723456, 100.476543',
      mapUrl: 'https://www.google.com/maps/search/?api=1&query=13.723456,100.476543',
      name: 'คุณทดสอบ ตัวอย่าง',
      phoneDisplay: '081-234-5678',
      phoneForPlus66: '812345678',
      address: '99/1 ซ.ทดสอบ ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ',
      all: '📦 A12 — Lalamove\nผู้รับ: คุณทดสอบ ตัวอย่าง',
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
    expect(html).toContain('data-copy="13.723456, 100.476543"');
    expect(html).toContain('data-copy="คุณทดสอบ ตัวอย่าง"');
    expect(html).toContain('data-copy="812345678"');
    expect(html).toContain('data-copy="99/1 ซ.ทดสอบ ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ"');
    expect(html).not.toMatch(/data-copy="(ผู้รับ|โทร):/);
    expect(html).toContain(th.orderDetail.lalamoveCopyAll);
  });
  it('shows the readable phone with the +66 box hint and a Google Maps button', () => {
    expect(html).toContain('081-234-5678');
    expect(html).toContain('+66');
    expect(html).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=13.723456,100.476543"');
    for (const label of [th.orderDetail.lalamovePin, th.orderDetail.lalamoveName, th.orderDetail.lalamovePhone, th.orderDetail.lalamoveAddress]) expect(html).toContain(label);
  });
});
