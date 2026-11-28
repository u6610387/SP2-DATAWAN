'use client';
/**
 * Owner dashboard: latest payment slip + code check + confirm / reject.
 * The slip image is shown for EVERY result (PASS / WARN / FAIL / PENDING): on WARN or FAIL the
 * owner decides from the picture, and in GEMINI_SLIP_MODE=manual every slip is WARN.
 */
import { useEffect, useRef, useState } from 'react';
import { bahtToSatang, ownerSlipChecks, type CheckLevel, type OwnerOrderView, type OwnerSlipChecklist, type SlipCheck } from '@datawan/shared';
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

const OWNER_RULES = new Set(['AMOUNT', 'RECEIVER', 'TIME']);
const RANK: Record<CheckLevel, number> = { PASS: 0, WARN: 1, FAIL: 2 };
const worst = (checks: SlipCheck[]): CheckLevel => checks.reduce<CheckLevel>((a, c) => (RANK[c.result] > RANK[a] ? c.result : a), 'PASS');

/** datetime-local value ("2026-11-28T23:41") as Bangkok time → ISO with offset. */
const bangkokIso = (local: string) => (local ? `${local}:00+07:00` : '');

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
  onConfirm: (overrideReason: string | null, slipChecklist: OwnerSlipChecklist | null) => void;
  onReject: (reason: string) => void;
  /** Sends the decoded Mini-QR text (or null when none was found) to POST /api/owner/payments/:id/qr. */
  onQrDecoded?: (payload: string | null) => Promise<void>;
}) {
  const payment = order.latestPayment!;
  const qr = useSlipQrCheck(order, useStableSignedUrl(payment.id, payment.slipImageUrl), onQrDecoded);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [receiverIsShop, setReceiverIsShop] = useState(false);
  const [slipTime, setSlipTime] = useState('');

  // Nothing read the amount (manual slip mode): the owner's checklist decides AMOUNT / RECEIVER / TIME.
  const needsChecklist = order.status === 'PAYMENT_REVIEW' && !payment.checks.some((c) => c.rule === 'AMOUNT');
  const amountNum = Number(amount.replace(/,/g, ''));
  const checklist: OwnerSlipChecklist | null =
    needsChecklist && amount.trim() !== '' && Number.isFinite(amountNum) && amountNum >= 0 && slipTime
      ? { amountSatang: bahtToSatang(amountNum), receiverIsShop, slipTime: bangkokIso(slipTime) }
      : null;
  // Same rules as the worker (packages/shared/src/slipChecklist.ts), previewed live.
  const preview = checklist ? ownerSlipChecks(checklist, { totalSatang: order.totalSatang, orderCreatedAt: order.createdAt, now: new Date() }) : null;
  const shown: SlipCheck[] = preview
    ? [...payment.checks.filter((c) => !OWNER_RULES.has(c.rule)).map((c) => (c.rule === 'READABLE' ? { ...c, result: 'PASS' as const, detail: '' } : c)), ...preview]
    : payment.checks;
  const pending = needsChecklist && !preview ? (['AMOUNT', 'RECEIVER', 'TIME'] as const) : [];
  const result: CheckLevel | 'PENDING' = preview ? worst(shown) : payment.result;
  const fails = shown.filter((c) => c.result === 'FAIL');
  const needsOverride = result !== 'PASS';
  const canConfirm = order.status === 'PAYMENT_REVIEW' && (!needsChecklist || checklist !== null) && (!needsOverride || reason.trim() !== '');

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>{t.orderDetail.paymentTitle}</CardTitle>
        <Badge className={RESULT_COLOR[result]}>{result}</Badge>
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
        {shown.map((c, i) => (
          <CheckRow key={i} c={c} t={t} />
        ))}
        {pending.map((rule) => (
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

      {needsChecklist && (
        <fieldset className="mt-3 space-y-2 rounded-xl border border-[var(--border)] p-3">
          <legend className="px-1 text-sm font-medium">{t.orderDetail.slipChecklistTitle}</legend>
          <p className="text-xs text-[var(--muted)]">{t.orderDetail.slipChecklistHint}</p>
          <label className="block text-xs">
            {t.orderDetail.slipChecklistAmount}
            <Input className="mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={receiverIsShop} onChange={(e) => setReceiverIsShop(e.target.checked)} />
            {t.orderDetail.slipChecklistReceiver}
          </label>
          <label className="block text-xs">
            {t.orderDetail.slipChecklistTime}
            <Input className="mt-1" type="datetime-local" value={slipTime} onChange={(e) => setSlipTime(e.target.value)} />
          </label>
          {!checklist && <p className="text-xs text-[var(--yellow)]">{t.orderDetail.slipChecklistIncomplete}</p>}
        </fieldset>
      )}

      {needsOverride && (
        <>
          <Input className="mt-3" placeholder={t.orderDetail.overrideReasonPlaceholder} value={reason} onChange={(e) => setReason(e.target.value)} />
          {!reason.trim() && <p className="mt-1 text-xs text-[var(--red)]">{t.orderDetail.slipOverrideRequired}</p>}
        </>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button disabled={busy || !canConfirm} onClick={() => onConfirm(needsOverride ? reason : null, checklist)}>
          {t.orderDetail.confirmPayment}
        </Button>
        <Button variant="danger" disabled={busy || order.status !== 'PAYMENT_REVIEW'} onClick={() => onReject(reason || t.orderDetail.rejectReasonFallback)}>
          {t.orderDetail.rejectSlip}
        </Button>
      </div>
    </Card>
  );
}
