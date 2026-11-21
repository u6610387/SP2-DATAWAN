'use client';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { bahtToSatang, computeMargin, formatTHB, type OwnerOrderView } from '@datawan/shared';
import { Badge, MarginBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiRequestError, ownerFetch } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { useOwnerAuth } from '@/lib/ownerAuth';
import { useOwnerRealtime } from '@/lib/useOwnerRealtime';

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { token } = useOwnerAuth();
  const { t, lang } = useLanguage();
  const { data: order, mutate, error } = useSWR(token ? ['order', id, token] : null, () => ownerFetch<OwnerOrderView>(`/api/owner/orders/${id}`, token!), {
    refreshInterval: 10_000,
  });
  useOwnerRealtime(() => void mutate());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setActionError(e instanceof ApiRequestError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  if (error instanceof ApiRequestError && error.status === 404) {
    return <p className="p-6 text-center text-sm text-[var(--muted)]">{t.orderDetail.notFound}</p>;
  }
  if (!order) return <div className="h-40 animate-pulse rounded-2xl bg-black/5" />;

  return (
    <div className="space-y-4">
      <button onClick={() => router.push('/dashboard')} className="text-sm text-[var(--brand)]">
        {t.orderDetail.back}
      </button>

      <Card>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-semibold">{order.code}</div>
            <div className="text-sm text-[var(--muted)]">{order.customer.name ?? order.customer.businessName ?? '-'}</div>
          </div>
          <Badge className="bg-black/5">{t.orderStatus[order.status]}</Badge>
        </div>
        {order.needsOwnerReview && <p className="mt-2 text-xs text-[var(--yellow)]">{t.orderDetail.needsReviewWarning}</p>}
      </Card>

      <Card>
        <CardTitle>{t.orderDetail.items}</CardTitle>
        <ul className="mt-2 space-y-1 text-sm">
          {order.items.map((it) => (
            <li key={it.id} className="flex justify-between">
              <span>{it.name}</span>
              <span className="text-[var(--muted)]">
                {it.qty} {it.unit}
                {it.actualQty !== null ? ` (${t.orderDetail.weighed(String(it.actualQty))})` : ''}
              </span>
            </li>
          ))}
        </ul>
        {order.rawOrderText && <p className="mt-2 rounded-lg bg-black/5 p-2 text-xs text-[var(--muted)]">{order.rawOrderText}</p>}
      </Card>

      {actionError && <p className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">{actionError}</p>}

      {(order.status === 'AWAITING_PRICE' || order.status === 'PRICE_QUOTED') && (
        <PriceCard
          order={order}
          t={t}
          busy={busy}
          onSubmit={(amountSatang, note) => run(() => ownerFetch(`/api/owner/orders/${order.id}/price`, token!, { method: 'POST', body: { amountSatang, note }, ifMatch: order.version }))}
        />
      )}

      {order.status === 'NEGOTIATING' && (
        <NegotiationCard
          order={order}
          t={t}
          busy={busy}
          onAction={(action, amountSatang) =>
            run(() => ownerFetch(`/api/owner/orders/${order.id}/negotiation`, token!, { method: 'POST', body: { action, amountSatang }, ifMatch: order.version }))
          }
        />
      )}

      {order.status === 'AWAITING_SHIPPING_FEE' && (
        <ShippingCard t={t} busy={busy} onSubmit={(feeSatang) => run(() => ownerFetch(`/api/owner/orders/${order.id}/shipping`, token!, { method: 'POST', body: { feeSatang }, ifMatch: order.version }))} />
      )}

      {order.lalamoveCard && (
        <Card>
          <CardTitle>{t.orderDetail.lalamoveTitle}</CardTitle>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-black/5 p-3 text-sm">{order.lalamoveCard.text}</pre>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => navigator.clipboard.writeText(order.lalamoveCard!.text)}>
            {t.common.copy}
          </Button>
        </Card>
      )}

      {order.totalSatang !== null && order.status === 'AWAITING_PAYMENT' && (
        <Card>
          <CardTitle>{t.orderDetail.awaitingPaymentTitle}</CardTitle>
          <div className="mt-2 text-2xl font-semibold">{formatTHB(order.totalSatang)}</div>
          {order.paymentExpiresAt && (
            <p className="text-xs text-[var(--muted)]">{t.orderDetail.expiresAt(new Date(order.paymentExpiresAt).toLocaleTimeString(lang === 'th' ? 'th-TH' : 'en-GB'))}</p>
          )}
        </Card>
      )}

      {order.latestPayment && (
        <PaymentCard
          order={order}
          t={t}
          busy={busy}
          onConfirm={(overrideReason) => run(() => ownerFetch(`/api/owner/payments/${order.latestPayment!.id}/confirm`, token!, { method: 'POST', body: { overrideReason }, ifMatch: order.version }))}
          onReject={(reason) => run(() => ownerFetch(`/api/owner/payments/${order.latestPayment!.id}/reject`, token!, { method: 'POST', body: { reason }, ifMatch: order.version }))}
        />
      )}

      {order.status === 'PAID' && (
        <DispatchCard t={t} busy={busy} onSubmit={(trackingUrl) => run(() => ownerFetch(`/api/owner/orders/${order.id}/dispatch`, token!, { method: 'POST', body: { trackingUrl }, ifMatch: order.version }))} />
      )}

      {order.status === 'DELIVERING' && (
        <Card>
          <CardTitle>{t.orderDetail.deliveringTitle}</CardTitle>
          {order.trackingUrl && (
            <a href={order.trackingUrl} target="_blank" rel="noreferrer" className="mt-1 block text-sm text-[var(--brand)] underline">
              {order.trackingUrl}
            </a>
          )}
          <Button className="mt-3" size="lg" disabled={busy} onClick={() => run(() => ownerFetch(`/api/owner/orders/${order.id}/delivered`, token!, { method: 'POST', body: {}, ifMatch: order.version }))}>
            {t.orderDetail.markDelivered}
          </Button>
        </Card>
      )}

      {order.status === 'DELIVERED' && (
        <Card>
          <CardTitle>{t.orderDetail.deliveredTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{t.orderDetail.deliveredSummary(order.totalSatang !== null ? formatTHB(order.totalSatang) : '-')}</p>
        </Card>
      )}
    </div>
  );
}

function PriceCard({ order, t, busy, onSubmit }: { order: OwnerOrderView; t: Dictionary; busy: boolean; onSubmit: (amountSatang: number, note: string | null) => void }) {
  const [baht, setBaht] = useState(order.suggestedPriceSatang !== null ? String(order.suggestedPriceSatang / 100) : '');
  const [note, setNote] = useState('');
  const amountSatang = useMemo(() => {
    const n = Number(baht);
    return Number.isFinite(n) && n > 0 ? bahtToSatang(n) : null;
  }, [baht]);
  const margin = amountSatang !== null ? computeMargin(amountSatang, [order.costSatang]) : null;

  return (
    <Card>
      <CardTitle>{t.orderDetail.priceTitle}</CardTitle>
      <div className="mt-2 space-y-2 text-xs text-[var(--muted)]">
        {order.costSatang !== null && <p>{t.orderDetail.cost(formatTHB(order.costSatang))}</p>}
        {order.suggestedPriceSatang !== null && <p>{t.orderDetail.suggested(formatTHB(order.suggestedPriceSatang))}</p>}
        {order.b2bAnchorPriceSatang !== null && <p>{t.orderDetail.b2bAnchor(formatTHB(order.b2bAnchorPriceSatang))}</p>}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Input inputMode="decimal" placeholder={t.orderDetail.pricePlaceholder} value={baht} onChange={(e) => setBaht(e.target.value)} />
        {margin && <MarginBadge color={margin.color}>{margin.marginSatang !== null ? formatTHB(margin.marginSatang) : '—'}</MarginBadge>}
      </div>
      <Input className="mt-2" placeholder={t.orderDetail.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} />
      <Button className="mt-3" size="lg" disabled={busy || amountSatang === null} onClick={() => amountSatang !== null && onSubmit(amountSatang, note || null)}>
        {t.orderDetail.confirmPrice}
      </Button>
    </Card>
  );
}

function NegotiationCard({ order, t, busy, onAction }: { order: OwnerOrderView; t: Dictionary; busy: boolean; onAction: (action: 'accept' | 'counter' | 'hold', amountSatang?: number) => void }) {
  const lastCounter = [...order.negotiation].reverse().find((n) => n.actor === 'customer' && n.action === 'counter');
  const [baht, setBaht] = useState('');
  const counterAmount = Number(baht) > 0 ? bahtToSatang(Number(baht)) : null;

  return (
    <Card>
      <CardTitle>{t.orderDetail.negotiationTitle}</CardTitle>
      {lastCounter?.amountSatang != null && <div className="mt-2 text-xl font-semibold">{formatTHB(lastCounter.amountSatang)}</div>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button disabled={busy} onClick={() => onAction('accept')}>
          {t.orderDetail.accept}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => onAction('hold')}>
          {t.orderDetail.hold}
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Input inputMode="decimal" placeholder={t.orderDetail.counterPlaceholder} value={baht} onChange={(e) => setBaht(e.target.value)} />
        <Button variant="secondary" disabled={busy || counterAmount === null} onClick={() => counterAmount !== null && onAction('counter', counterAmount)}>
          {t.orderDetail.counterSend}
        </Button>
      </div>
    </Card>
  );
}

function ShippingCard({ t, busy, onSubmit }: { t: Dictionary; busy: boolean; onSubmit: (feeSatang: number) => void }) {
  const [baht, setBaht] = useState('');
  const feeSatang = Number(baht) >= 0 && baht !== '' ? bahtToSatang(Number(baht)) : null;
  return (
    <Card>
      <CardTitle>{t.orderDetail.shippingTitle}</CardTitle>
      <div className="mt-2 flex items-center gap-2">
        <Input inputMode="decimal" placeholder={t.orderDetail.shippingPlaceholder} value={baht} onChange={(e) => setBaht(e.target.value)} />
        <Button disabled={busy || feeSatang === null} onClick={() => feeSatang !== null && onSubmit(feeSatang)}>
          {t.orderDetail.confirmShipping}
        </Button>
      </div>
    </Card>
  );
}

function PaymentCard({
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
  const RESULT_COLOR = { PASS: 'bg-[var(--green-bg)] text-[var(--green)]', WARN: 'bg-[var(--yellow-bg)] text-[var(--yellow)]', FAIL: 'bg-[var(--red-bg)] text-[var(--red)]', PENDING: 'bg-black/5' } as const;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>{t.orderDetail.paymentTitle}</CardTitle>
        <Badge className={RESULT_COLOR[payment.result]}>{payment.result}</Badge>
      </div>
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

function DispatchCard({ t, busy, onSubmit }: { t: Dictionary; busy: boolean; onSubmit: (trackingUrl: string) => void }) {
  const [url, setUrl] = useState('');
  return (
    <Card>
      <CardTitle>{t.orderDetail.dispatchTitle}</CardTitle>
      <div className="mt-2 flex items-center gap-2">
        <Input placeholder={t.orderDetail.trackingPlaceholder} value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button disabled={busy || !url} onClick={() => onSubmit(url)}>
          {t.orderDetail.dispatchSubmit}
        </Button>
      </div>
    </Card>
  );
}
