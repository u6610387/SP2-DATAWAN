'use client';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function PromptPayQR({ payload, size = 240 }: { payload: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(payload, { width: size, margin: 1 }).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [payload, size]);

  if (!src) return <div className="mx-auto h-[240px] w-[240px] animate-pulse rounded-xl bg-black/5" style={{ height: size, width: size }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="PromptPay QR" width={size} height={size} className="mx-auto rounded-xl" />;
}
