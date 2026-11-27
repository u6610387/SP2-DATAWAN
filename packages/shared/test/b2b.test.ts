import { describe, expect, it } from 'vitest';
import { B2bApplyRequest } from '../src/contracts/requests';
import { isValidThaiTaxId } from '../src/taxId';

describe('isValidThaiTaxId', () => {
  it('accepts valid ids', () => {
    expect(isValidThaiTaxId('0105536000313')).toBe(true);
    expect(isValidThaiTaxId('3101700000016')).toBe(true);
  });
  it('rejects bad check digit, wrong length, non-digits', () => {
    expect(isValidThaiTaxId('0105536000316')).toBe(false);
    expect(isValidThaiTaxId('010553600031')).toBe(false);
    expect(isValidThaiTaxId('01055360003a5')).toBe(false);
  });
});

const valid = {
  businessName: ' ร้านทดสอบ ',
  businessType: 'restaurant',
  addressText: '99 ถนนทดสอบ กรุงเทพ',
  lat: null,
  lng: null,
  deliveryWindow: null,
  taxId: null,
  documentPaths: [] as string[],
  pdpaConsent: true,
};

describe('B2bApplyRequest', () => {
  it('accepts a minimal body and trims businessName', () => {
    const r = B2bApplyRequest.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.businessName).toBe('ร้านทดสอบ');
  });
  it.each([
    ['blank name', { businessName: '   ' }],
    ['no consent', { pdpaConsent: false }],
    ['lat outside Thailand', { lat: 40, lng: 100 }],
    ['bad window', { deliveryWindow: '25:00-08:00' }],
    ['4 docs', { documentPaths: ['a', 'b', 'c', 'd'] }],
  ])('rejects %s', (_n, patch) => {
    expect(B2bApplyRequest.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
