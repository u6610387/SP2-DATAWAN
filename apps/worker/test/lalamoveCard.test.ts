/** Lalamove copy card: real ผู้รับ / โทร lines only; never a "-" the owner could paste. */
import { describe, expect, it } from 'vitest';
import type { AddressRow, OrderRow } from '@datawan/shared';
import { lalamoveCardText } from '../src/line/flex';

const order = (o: Partial<OrderRow>) => ({ code: 'A9', recipient_name: null, recipient_phone: null, requested_delivery_at: null, ...o }) as OrderRow;
const address = { address_text: '99/1 ถ.ทดสอบ', lat: 13.72, lng: 100.47 } as AddressRow;

describe('lalamoveCardText', () => {
  it('shows saved recipient name and phone cleanly', () => {
    const lines = lalamoveCardText(order({ recipient_name: 'คุณดา', recipient_phone: '0812345678' }), address, null).split('\n');
    expect(lines).toEqual(expect.arrayContaining(['ผู้รับ: คุณดา', 'โทร: 0812345678', 'ที่อยู่: 99/1 ถ.ทดสอบ']));
    expect(lines.join('\n')).not.toContain('⚠️');
  });

  it('older order without a recipient (A5/A7): explicit warning, no "-" placeholder lines', () => {
    const text = lalamoveCardText(order({}), address, null);
    expect(text).not.toMatch(/ผู้รับ: -|โทร: -/);
    expect(text.split('\n').some((l) => /:\s*-\s*$/.test(l))).toBe(false);
    expect(text).toContain('⚠️ ยังไม่มีชื่อ/เบอร์ผู้รับ');
  });

  it('does not use the LINE display name as the recipient', () => {
    const text = lalamoveCardText(order({}), address, { full_name: null, phone: null, display_name: 'LINE nickname' } as never);
    expect(text).not.toContain('LINE nickname');
  });
});
