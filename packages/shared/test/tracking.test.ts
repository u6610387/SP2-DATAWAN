import { describe, expect, it } from 'vitest';
import { DispatchRequest } from '../src/contracts/requests';
import { extractTrackingUrl } from '../src/tracking';

describe('extractTrackingUrl', () => {
  it.each([
    ['https://share.lalamove.com/?TH1234&sign=abc', 'https://share.lalamove.com/?TH1234&sign=abc'],
    ['  https://share.lalamove.com/?TH1234  ', 'https://share.lalamove.com/?TH1234'],
    ['ติดตามสถานะการจัดส่ง: https://share.lalamove.com/?TH1234&lang=th_TH', 'https://share.lalamove.com/?TH1234&lang=th_TH'],
    ['share.lalamove.com/?TH1234', 'https://share.lalamove.com/?TH1234'],
    ['http://share.lalamove.com/?TH1234', 'https://share.lalamove.com/?TH1234'],
    ['ลิงก์ (https://share.lalamove.com/?TH1234).', 'https://share.lalamove.com/?TH1234'],
    ['first https://share.lalamove.com/?A then https://example.com/b', 'https://share.lalamove.com/?A'],
    ['https://track.example-courier.co.th/abc', 'https://track.example-courier.co.th/abc'],
  ])('%s', (input, out) => expect(extractTrackingUrl(input)).toBe(out));

  it.each(['', 'ไม่มีลิงก์', 'javascript:alert(1)', 'ftp://share.lalamove.com/x', 'https://', 'lalamove'])('rejects %s', (input) => {
    expect(extractTrackingUrl(input)).toBeNull();
  });
});

describe('DispatchRequest', () => {
  it('accepts pasted share text and stores only the clean https link', () => {
    expect(DispatchRequest.parse({ trackingUrl: 'ติดตาม: share.lalamove.com/?TH9' })).toEqual({ trackingUrl: 'https://share.lalamove.com/?TH9' });
  });
  it('rejects text without a link', () => {
    expect(DispatchRequest.safeParse({ trackingUrl: 'ส่งแล้ว' }).success).toBe(false);
  });
});
