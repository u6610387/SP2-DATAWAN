'use client';
/**
 * Owner dashboard: latest payment slip + code check + confirm / reject.
 * The slip image is shown for EVERY result (PASS / WARN / FAIL / PENDING): on WARN or FAIL the
 * owner decides from the picture, and in GEMINI_SLIP_MODE=manual every slip is WARN.
 */
import { useEffect, useRef, useState } from 'react';
import type { OwnerOrderView, SlipCheck } from '@datawan/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { decodeQrFromImageUrl } from '@/lib/slipQr';

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

const LEVEL_COLOR = { PASS: 'text-[var(--green)]', WARN: 'text-[var(--yellow)]', FAIL: 'text-[var(--red)]' } as const;

/**
 * Decodes the slip's Mini-QR once per payment while it awaits review and hands the text to the
 * Worker (which flags duplicates / tampering). The owner can re-run it. Never confirms anything.
 */
function useSlipQrCheck(order: OwnerOrderView, src: string | null, onQrDecoded?: (payload: string | null) => Promise<void>) {
  const payment = order.latestPayment!;
  const attempted = useRef<string | null>(null);
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');
  const run = async () => {
    if (!src || !onQrDecoded) return;
    setState('running');
    try {
      const payload = await decodeQrFromImageUrl(src);
      await onQrDecoded(payload);
      setState('idle');
    } catch {
      setState('error'); // image load / CORS / network: leave the check to the owner's eyes
    }
  };
  const hasReference = payment.checks.some((c) => c.rule === 'REFERENCE');
  useEffect(() => {
    if (order.status !== 'PAYMENT_REVIEW' || hasReference || !src || attempted.current === payment.id) return;
    attempted.current = payment.id;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.status, hasReference, src, payment.id]);
  return { state, run, canRun: Boolean(onQrDecoded && src && order.status === 'PAYMENT_REVIEW') };
}

export function SlipImage({ paymentId, url, t }: { paymentId: string; url: string | null; t: Dictionary }) {
  const src = useStableSignedUrl(paymentId, url);
  const [failed, setFailed] = useState<string | null>(null);
  if (!src) return <p className="mt-2 rounded-lg bg-black/5 p-3 text-xs text-[var(--muted)]">{t.orderDetail.slipImageMissing}</p>;
  if (failed === src) return <p className="mt-2 rounded-lg bg-[var(--red-bg)] p-3 text-xs text-[var(--red)]">{t.orderDetail.slipImageError}</p>;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="mt-2 block" aria-label={t.orderDetail.slipOpenFull}>
      {/* eslint-disable-next-line @next/next/no-img-element -- private signed URL; no next/image on OpenNext */}
      <img src={src} crossOrigin="anonymous" alt={t.orderDetail.slipImageAlt} className="max-h-[70vh] w-full rounded-xl border border-black/10 bg-white object-contain" onError={() => setFailed(src)} />
      <span className="mt-1 block text-center text-xs text-[var(--brand)] underline">{t.orderDetail.slipOpenFull}</span>
    </a>
  );
}

/** What the bank Mini-QR can't prove: shown so a green QR row never reads as "slip verified". */
const NOT_FROM_QR = ['AMOUNT', 'RECEIVER', 'TIME'] as const;

/** One check row: label + what it really verified (REFERENCE · PASS never reads as "slip OK"). */
function CheckRow({ c, t }: { c: SlipCheck | { rule: SlipCheck['rule']; result: null; detail: string }; t: Dictionary }) {
  const status = c.result === null ? t.orderDetail.slipNotChecked : c.rule === 'REFERENCE' && c.result === 'PASS' ? t.orderDetail.slipReferencePass : t.orderDetail.slipResult[c.result];
  const color = c.result === null ? 'text-[var(--muted)]' : LEVEL_COLOR[c.result];
  return (
    <li>
      <span className={`font-medium ${color}`}>
        {t.orderDetail.slipRule[c.rule]} · {status}
      </span>
      {c.detail && <>: {c.detail}</>}
    </li>
  );
}

export function SlipPaymentCard({
  order,
  t,
  busy,
  onConfirm,
  onReject,
  onQrDecoded,
}: {
  order: OwnerOrderView;
  t: Dictionary;
  busy: boolean;
  onConfirm: (overrideReason: string | null) => void;
  onReject: (reason: string) => void;
  /** Sends the decoded Mini-QR text (or null when none was found) to POST /api/owner/payments/:id/qr. */
  onQrDecoded?: (payload: string | null) => Promise<void>;
}) {
  const payment = order.latestPayment!;
  const qr = useSlipQrCheck(order, useStableSignedUrl(payment.id, payment.slipImageUrl), onQrDecoded);
  const [reason, setReason] = useState('');
  // The owner looks at the slip and confirms. Only a FAIL (duplicate / tampered QR, AI-read mismatch) needs a reason.
  const fails = payment.checks.filter((c) => c.result === 'FAIL');
  const needsOverride = payment.result === 'FAIL' || fails.length > 0;
  const notChecked = NOT_FROM_QR.filter((rule) => !payment.checks.some((c) => c.rule === rule));
  const reviewing = order.status === 'PAYMENT_REVIEW';

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>{t.orderDetail.paymentTitle}</CardTitle>
        <Badge className={RESULT_COLOR[payment.result]}>{payment.result}</Badge>
      </div>
      <SlipImage paymentId={payment.id} url={payment.slipImageUrl} t={t} />
      {fails.length > 0 && (
        <div role="alert" className="mt-2 rounded-xl border border-[var(--red)] bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">
          <p className="font-semibold">{t.orderDetail.slipMismatchBanner}</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {fails.map((c, i) => (
              <li key={i}>
                {t.orderDetail.slipRule[c.rule]}: {c.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
        {payment.checks.map((c, i) => (
          <CheckRow key={i} c={c} t={t} />
        ))}
        {notChecked.map((rule) => (
          <CheckRow key={rule} c={{ rule, result: null, detail: '' }} t={t} />
        ))}
      </ul>
      {qr.state === 'running' && <p className="mt-2 text-xs text-[var(--muted)]">{t.orderDetail.slipQrChecking}</p>}
      {qr.state === 'error' && <p className="mt-2 text-xs text-[var(--yellow)]">{t.orderDetail.slipQrError}</p>}
      {qr.canRun && qr.state !== 'running' && (
        <Button variant="secondary" size="sm" className="mt-2" disabled={busy} onClick={() => void qr.run()}>
          {t.orderDetail.slipQrRecheck}
        </Button>
      )}
      {payment.extracted?.amount != null && <p className="mt-2 text-sm">{t.orderDetail.slipAmount(`฿${payment.extracted.amount}`)}</p>}

      {reviewing && (
        <>
          <Input className="mt-3" placeholder={t.orderDetail.overrideReasonPlaceholder} value={reason} onChange={(e) => setReason(e.target.value)} />
          {!reason.trim() && <p className="mt-1 text-xs text-[var(--muted)]">{needsOverride ? t.orderDetail.slipOverrideRequired : t.orderDetail.rejectNeedsReason}</p>}
        </>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button disabled={busy || !reviewing || (needsOverride && !reason.trim())} onClick={() => onConfirm(needsOverride ? reason.trim() : null)}>
          {t.orderDetail.confirmPayment}
        </Button>
        <Button variant="danger" disabled={busy || !reviewing || !reason.trim()} onClick={() => onReject(reason.trim())}>
          {t.orderDetail.rejectSlip}
        </Button>
      </div>
    </Card>
  );
}
