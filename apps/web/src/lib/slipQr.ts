/**
 * Decode the bank's Mini-QR from the stored slip image, on the owner's own device (free; no bank
 * API, no third party — CLAUDE.md §3.2 / D1). The Worker then checks the CRC and whether the
 * transRef was used before. Decoding runs here, not in the Worker, because decoding a ~250 KB
 * JPEG in JS doesn't fit the Workers Free CPU budget.
 */
import jsQR from 'jsqr';

/** Pure core (testable in Node): RGBA pixels → QR text, or null if none found. */
export function decodeQrFromRgba(data: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

/**
 * Browser only. Needs CORS on the image (Supabase Storage signed URLs send
 * `Access-Control-Allow-Origin: *`), otherwise the canvas is tainted and getImageData throws.
 */
export async function decodeQrFromImageUrl(url: string, maxSide = 1600): Promise<string | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2d not available');
  ctx.drawImage(img, 0, 0, w, h);
  return decodeQrFromRgba(ctx.getImageData(0, 0, w, h).data, w, h);
}
