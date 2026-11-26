/** LIFF tracking button + owner push notice (production A7: the customer never saw the link). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TrackingButton, trackingPushNotice } from '@/components/TrackingButton';
import { th } from '@/lib/i18n/th';

const U = 'https://share.lalamove.com/?TH1&lang=th_TH';

describe('TrackingButton', () => {
  it('renders a prominent "ติดตามการจัดส่ง (Lalamove)" link that opens the tracking page', () => {
    const html = renderToStaticMarkup(<TrackingButton url={U} t={th} />);
    expect(html).toContain(`href="${U.replace(/&/g, '&amp;')}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('ติดตามการจัดส่ง (Lalamove)');
    expect(html).toMatch(/class="[^"]*\bmin-h-14\b[^"]*\bw-full\b/);
  });
  it('generic label for other couriers; nothing without a safe link', () => {
    expect(renderToStaticMarkup(<TrackingButton url="https://courier.example.co.th/t/1" t={th} />)).toContain('>ติดตามการจัดส่ง<');
    expect(renderToStaticMarkup(<TrackingButton url={null} t={th} />)).toBe('');
    expect(renderToStaticMarkup(<TrackingButton url="javascript:alert(1)" t={th} />)).toBe('');
  });
});

describe('trackingPushNotice', () => {
  it('says whether the customer got the LINE push, and why not', () => {
    expect(trackingPushNotice(th, null)).toBeNull();
    expect(trackingPushNotice(th, { sent: true, reason: null })).toEqual({ tone: 'ok', text: th.orderDetail.trackingPushSent });
    expect(trackingPushNotice(th, { sent: false, reason: 'ORDER_CAP' })!.text).toContain('ใช้สิทธิ์ส่ง LINE ของออเดอร์นี้ไปแล้ว');
  });
});
