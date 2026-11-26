/**
 * The dashboard decodes the slip's bank Mini-QR from pixels (jsQR). Render a real QR (qrcode lib,
 * already used for PromptPay) to RGBA and decode it, so the decoding path is exercised in Node.
 * (Separately verified in-session: jsQR found the Mini-QR on a real 1110×1400 production KBANK slip.)
 */
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { checkSlipQrText, decodeQrFromRgba } from '@/lib/slipQr';
import { th } from '@/lib/i18n/th';

function renderQr(text: string, scale = 4, margin = 4, invert = false) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = (modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const my = Math.floor(y / scale) - margin;
      const dark = Boolean(mx >= 0 && my >= 0 && mx < modules.size && my < modules.size && modules.get(my, mx));
      const v = dark !== invert ? 0 : 255;
      data.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  return { data, size };
}

const SLIP_QR = '004100060000010103014022000111222233344ABCD125102TH910417DF';

describe('decodeQrFromRgba', () => {
  it('reads a bank slip Mini-QR', () => {
    const { data, size } = renderQr(SLIP_QR);
    expect(decodeQrFromRgba(data, size, size)).toBe(SLIP_QR);
  });
  it('reads an inverted (light-on-dark) QR', () => {
    const { data, size } = renderQr(SLIP_QR, 4, 4, true);
    expect(decodeQrFromRgba(data, size, size)).toBe(SLIP_QR);
  });
  it('returns null when there is no QR', () => {
    const size = 200;
    const blank = new Uint8ClampedArray(size * size * 4).fill(255);
    expect(decodeQrFromRgba(blank, size, size)).toBeNull();
  });
});

// Production A10: a chat screenshot was accepted as a slip. The LIFF gate runs on the customer's
// device before anything is uploaded: decode → valid Thai bank slip Mini-QR (format + CRC) or reject.
describe('LIFF slip gate (checkSlipQrText on decoded pixels)', () => {
  const PROMPTPAY = '00020101021129370016A000000677010111011300668123456785802TH530376463041234';
  it('accepts a real bank slip Mini-QR', () => {
    const { data, size } = renderQr(SLIP_QR);
    expect(checkSlipQrText(decodeQrFromRgba(data, size, size))).toEqual({ ok: true, payload: SLIP_QR });
  });
  it('rejects an image whose QR is a PromptPay payment QR (e.g. a chat screenshot with a QR)', () => {
    const { data, size } = renderQr(PROMPTPAY);
    expect(decodeQrFromRgba(data, size, size)).toBe(PROMPTPAY); // a QR is found…
    expect(checkSlipQrText(decodeQrFromRgba(data, size, size)).ok).toBe(false); // …but it isn't a slip QR
  });
  it('rejects an image with no QR at all and a tampered slip QR', () => {
    const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(checkSlipQrText(decodeQrFromRgba(blank, 200, 200)).ok).toBe(false);
    expect(checkSlipQrText(SLIP_QR.slice(0, -4) + '0000').ok).toBe(false);
    expect(checkSlipQrText(null).ok).toBe(false);
  });
  it('shows the exact Thai rejection message', () => {
    expect(th.liff.notSlipQr).toBe('รูปนี้ไม่ใช่สลิปโอนเงิน (ไม่พบ QR Code ธนาคาร) กรุณาอัปโหลดรูปสลิปที่มี QR Code ชัดเจน');
  });
});

