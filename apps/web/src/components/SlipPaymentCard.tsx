'use client';
/**
 * Owner dashboard: latest payment slip + code check + confirm / reject.
 * The slip image is shown for EVERY result (PASS / WARN / FAIL / PENDING): on WARN or FAIL the
 * owner decides from the picture, and in GEMINI_SLIP_MODE=manual every slip is WARN.
 */
import { useRef, useState } from 'react';
import type { OwnerOrderView } from '@datawan/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { Dictionary } from '@/lib/i18n/dictionary';

const RESULT_COLOR = {
  PASS: 'bg-[var(--green-bg)] text-[var(--green)]',
  WARN: 'bg-[var(--yellow-bg)] text-[var(--yellow)]',
  FAIL: 'bg-[var(--red-bg)] text-[var(--red)]',
  PENDING: 'bg-black/5',
} as const;

/** Worker signs slip URLs for 600 s; reuse one per payment for 8 min so the 10 s refresh doesn't re-download it. */
const SIGNED_URL_REUSE_MS = 8 * 60_000;

function useStableSignedUrl(key: string, url: string | null): string | null {
  const ref = useRef<{ key: string; url: string; at: number } | null>(null);
  const now = Date.now();
  if (url && (ref.current?.key !== key || now - ref.current.at > SIGNED_URL_REUSE_MS)) ref.current = { key, url, at: now };
  return ref.current?.key === key ? ref.current.url : null;
}

export function SlipImage({ paymentId, url, t }: { paymentId: string; url: string | null; t: Dictionary }) {
  const src = useStableSignedUrl(paymentId, url);
  const [failed, setFailed] = useState<string | null>(null);
  if (!src) return <p className="mt-2 rounded-lg bg-black/5 p-3 text-xs text-[var(--muted)]">{t.orderDetail.slipImageMissing}</p>;
  if (failed === src) return <p className="mt-2 rounded-lg bg-[var(--red-bg)] p-3 text-xs text-[var(--red)]">{t.orderDetail.slipImageError}</p>;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="mt-2 block" aria-label={t.orderDetail.slipOpenFull}>
      {/* eslint-disable-next-line @next/next/no-img-element -- private signed URL; no next/image on OpenNext */}
      <img src={src} alt={t.orderDetail.slipImageAlt} className="max-h-[70vh] w-full rounded-xl border border-black/10 bg-white object-contain" onError={() => setFailed(src)} />
      <span className="mt-1 block text-center text-xs text-[var(--brand)] underline">{t.orderDetail.slipOpenFull}</span>
    </a>
  );
}

export function SlipPaymentCard({
  order,
  t,
  busy,
  onConfirm,
  onReject,
}: {
  order: OwnerOrderView;
  t: Dictionary;
  busy: boolean;
  onConfirm: (overrideReason: string | null) => void;
  onReject: (reason: string) => void;
}) {
  const payment = order.latestPayment!;
  const [reason, setReason] = useState('');
  const needsOverride = payment.result !== 'PASS';

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>{t.orderDetail.paymentTitle}</CardTitle>
        <Badge className={RESULT_COLOR[payment.result]}>{payment.result}</Badge>
      </div>
      <SlipImage paymentId={payment.id} url={payment.slipImageUrl} t={t} />
      <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
        {payment.checks.map((c, i) => (
          <li key={i}>
            {c.rule}: {c.detail}
          </li>
        ))}
      </ul>
      {payment.extracted?.amount != null && <p className="mt-2 text-sm">{t.orderDetail.slipAmount(`฿${payment.extracted.amount}`)}</p>}
      {needsOverride && <Input className="mt-3" placeholder={t.orderDetail.overrideReasonPlaceholder} value={reason} onChange={(e) => setReason(e.target.value)} />}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button disabled={busy || order.status !== 'PAYMENT_REVIEW' || (needsOverride && !reason)} onClick={() => onConfirm(needsOverride ? reason : null)}>
          {t.orderDetail.confirmPayment}
        </Button>
        <Button variant="danger" disabled={busy || order.status !== 'PAYMENT_REVIEW'} onClick={() => onReject(reason || t.orderDetail.rejectReasonFallback)}>
          {t.orderDetail.rejectSlip}
        </Button>
      </div>
    </Card>
  );
}
