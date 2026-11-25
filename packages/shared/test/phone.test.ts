import { describe, expect, it } from 'vitest';
import { RecipientContactRequest } from '../src/contracts/requests';
import { formatThaiPhone, normalizeThaiPhone } from '../src/phone';


describe('normalizeThaiPhone', () => {
  it.each([
    ['0812345678', '0812345678'],
    ['081-234-5678', '0812345678'],
    ['081 234 5678', '0812345678'],
    ['+66812345678', '0812345678'],
    ['+66 81 234 5678', '0812345678'],
    ['66812345678', '0812345678'],
    ['021234567', '021234567'], // Bangkok landline, 9 digits
    ['๐๘๑๒๓๔๕๖๗๘', '0812345678'], // Thai digits
  ])('%s → %s', (input, out) => expect(normalizeThaiPhone(input)).toBe(out));

  it.each(['', '12345', '812345678', '08123456789', '1812345678', 'abc0812345678', '0812345678x', '+1 415 555 0100'])('rejects %s', (input) => {
    expect(normalizeThaiPhone(input)).toBeNull();
  });

  it('formats for display', () => {
    expect(formatThaiPhone('0812345678')).toBe('081-234-5678');
    expect(formatThaiPhone('021234567')).toBe('02-123-4567');
  });
});

describe('RecipientContactRequest', () => {
  it('normalises the phone and trims the name', () => {
    expect(RecipientContactRequest.parse({ recipientName: '  คุณดา  ', recipientPhone: '081-234-5678', pdpaConsent: true })).toEqual({
      recipientName: 'คุณดา', recipientPhone: '0812345678', pdpaConsent: true,
    });
  });
  it('requires a name, a valid Thai phone and PDPA consent', () => {
    expect(RecipientContactRequest.safeParse({ recipientName: '', recipientPhone: '0812345678', pdpaConsent: true }).success).toBe(false);
    expect(RecipientContactRequest.safeParse({ recipientName: 'ดา', recipientPhone: '12345', pdpaConsent: true }).success).toBe(false);
    expect(RecipientContactRequest.safeParse({ recipientName: 'ดา', recipientPhone: '0812345678', pdpaConsent: false }).success).toBe(false);
    expect(RecipientContactRequest.safeParse({ recipientName: 'ดา', recipientPhone: '0812345678' }).success).toBe(false);
  });
});
