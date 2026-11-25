/**
 * The dashboard decodes the slip's bank Mini-QR from pixels (jsQR). Render a real QR (qrcode lib,
 * already used for PromptPay) to RGBA and decode it, so the decoding path is exercised in Node.
 * (Separately verified in-session: jsQR found the Mini-QR on a real 1110×1400 production KBANK slip.)
 */
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { decodeQrFromRgba } from '@/lib/slipQr';

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
