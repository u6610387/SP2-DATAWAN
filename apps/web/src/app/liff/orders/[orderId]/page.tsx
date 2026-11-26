'use client';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import useSWR from 'swr';
import { bahtToSatang, formatTHB, type CustomerOrderView } from '@datawan/shared';
import { Countdown } from '@/components/Countdown';
import { PromptPayQR } from '@/components/PromptPayQR';
import { RecipientCard, showRecipientCard } from '@/components/RecipientCard';
import { TrackingButton } from '@/components/TrackingButton';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiRequestError, liffFetch } from '@/lib/api';
import { compressImage } from '@/lib/compressImage';
import { useLanguage } from '@/lib/i18n/context';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { useLiffAuth } from '@/lib/liffAuth';
import { useLiffHeartbeat } from '@/lib/useLiffHeartbeat';
import { useOrderBroadcast } from '@/lib/useOrderBroadcast';

export default function LiffOrderRoomPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const auth = useLiffAuth();
  const { t } = useLanguage();

  if (auth.loading) return <p className="p-6 text-center text-sm text-[var(--muted)]">{t.liff.loggingIn}</p>;
  if (auth.error) return <p className="p-6 text-center text-sm text-[var(--red)]">{t.liff.loginError(auth.error)}</p>;
  return <OrderRoom orderId={orderId} auth={{ idToken: auth.idToken, devUser: auth.devUser }} />;
}

function OrderRoom({ orderId, auth }: { orderId: string; auth: { idToken: string | null; devUser: string | null } }) {
  const { t } = useLanguage();
  const { data: order, mutate, error } = useSWR(
    ['liff-order', orderId, auth.idToken, auth.devUser],
    () => liffFetch<CustomerOrderView>(`/api/liff/orders/${orderId}`, auth),
    { refreshInterval: 20_000 },
  );
  useOrderBroadcast(order?.realtime.channel, order?.version ?? 0, () => void mutate());
  useLiffHeartbeat(orderId, auth);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      // 409: the order moved on (owner acted, or the version is stale). Refetch right away so the
      // screen and its order.version are current; never auto-retry the customer's action.
      if (e instanceof ApiRequestError && e.status === 409) {
        await mutate();
        setActionError(t.common.orderChanged);
      } else {
        setActionError(e instanceof ApiRequestError ? e.message : t.liff.genericError);
      }
    } finally {
      setBusy(false);
    }
  }

  if (error instanceof ApiRequestError && error.status === 404) {
    return <p className="p-6 text-center text-sm text-[var(--muted)]">{t.liff.notFound}</p>;
  }
  if (!order) return <div className="h-40 animate-pulse rounded-2xl bg-black/5" />;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">{t.liff.orderLabel(order.code)}</div>
          <span className="rounded-full bg-black/5 px-3 py-1 text-xs font-medium">{t.orderStatus[order.status]}</span>
        </div>
        {order.ownerDelayed && <p className="mt-2 text-xs text-[var(--yellow)]">{t.liff.ownerDelayed}</p>}
      </Card>

      <Card>
        <CardTitle>{t.liff.items}</CardTitle>
        {order.items.length === 0 && <p className="mt-2 text-sm text-[var(--muted)]">{t.liff.noItems}</p>}
        <ul className="mt-2 space-y-1 text-sm">
          {order.items.map((it) => (
            <li key={it.id} className="flex justify-between">
              <span>{it.name}</span>
              <span className="text-[var(--muted)]">
                {it.qty} {it.unit}
              </span>
            </li>
          ))}
        </ul>
        {order.delivery.addressText && <p className="mt-2 text-xs text-[var(--muted)]">{t.liff.deliverTo(order.delivery.addressText)}</p>}
      </Card>

      {actionError && <p className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">{actionError}</p>}

      {order.trackingUrl && <TrackingButton url={order.trackingUrl} t={t} />}

      {showRecipientCard(order) && (
        <RecipientCard
          key={`${order.id}-${order.delivery.recipientName ?? ''}-${order.delivery.recipientPhone ?? ''}`}
          order={order}
          t={t}
          busy={busy}
          onSave={(recipientName, recipientPhone) =>
            run(() => liffFetch(`/api/liff/orders/${orderId}/recipient`, auth, { method: 'POST', body: { recipientName, recipientPhone, pdpaConsent: true }, ifMatch: order.version }))
          }
        />
      )}

      {order.status === 'AWAITING_PRICE' && <Card>{t.liff.awaitingPrice}</Card>}

      {order.status === 'PRICE_QUOTED' && order.productPriceSatang !== null && (
        <PriceCard
          t={t}
          productPriceSatang={order.productPriceSatang}
          note={order.priceNote}
          busy={busy}
          acceptBlocked={order.delivery.needsRecipient}
          onAccept={() => run(() => liffFetch(`/api/liff/orders/${orderId}/accept`, auth, { method: 'POST', ifMatch: order.version }))}
          onCounter={(amountSatang) => run(() => liffFetch(`/api/liff/orders/${orderId}/counter`, auth, { method: 'POST', body: { amountSatang }, ifMatch: order.version }))}
        />
      )}

      {order.status === 'NEGOTIATING' && (
        <Card>
          <CardTitle>{t.liff.negotiatingTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{t.liff.negotiatingBody}</p>
        </Card>
      )}

      {order.status === 'AWAITING_PAYMENT' && order.totalSatang !== null && (
        <Card>
          <CardTitle>{t.liff.amountDueTitle}</CardTitle>
          <dl className="mt-2 space-y-1 text-sm">
            {order.productPriceSatang !== null && (
              <div className="flex justify-between">
                <dt className="text-[var(--muted)]">{t.liff.productSubtotal}</dt>
                <dd className="tabular-nums">{formatTHB(order.productPriceSatang)}</dd>
              </div>
            )}
            {order.shippingFeeSatang !== null && (
              <div className="flex justify-between">
                <dt className="text-[var(--muted)]">{t.liff.shippingFee}</dt>
                <dd className="tabular-nums">{formatTHB(order.shippingFeeSatang)}</dd>
              </div>
            )}
          </dl>
          <div className="mt-2 border-t border-[var(--border)] pt-2 text-center text-2xl font-semibold tabular-nums">{formatTHB(order.totalSatang)}</div>
          {order.paymentExpiresAt && (
            <div className="mt-1 text-center text-xs text-[var(--muted)]">
              <Countdown until={order.paymentExpiresAt} />
            </div>
          )}
          {order.promptpayPayload && (
            <div className="mt-3">
              <PromptPayQR payload={order.promptpayPayload} />
            </div>
          )}
          <p className="mt-3 text-center text-xs text-[var(--muted)]">{t.liff.payInstructions}</p>
          <SlipUpload t={t} orderId={orderId} auth={auth} busy={busy} onUploaded={() => void mutate()} setError={setActionError} />
        </Card>
      )}

      {order.status === 'PAYMENT_EXPIRED' && (
        <Card>
          <CardTitle>{t.liff.expiredTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{t.liff.expiredBody}</p>
        </Card>
      )}

      {order.status === 'PAYMENT_REVIEW' && (
        <Card>
          <CardTitle>{t.liff.reviewTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{t.liff.reviewBody}</p>
        </Card>
      )}

      {(order.status === 'PAID' || order.status === 'DELIVERING') && (
        <Card>
          <CardTitle>{order.status === 'DELIVERING' ? t.liff.deliveringTitle : t.liff.paidTitle}</CardTitle>
        </Card>
      )}

      {order.status === 'DELIVERED' && (
        <Card>
          <CardTitle>{t.liff.deliveredTitle}</CardTitle>
        </Card>
      )}
    </div>
  );
}

function PriceCard({
  t,
  productPriceSatang,
  note,
  busy,
  onAccept,
  acceptBlocked,
  onCounter,
}: {
  t: Dictionary;
  productPriceSatang: number;
  note: string | null;
  busy: boolean;
  onAccept: () => void;
  /** Recipient name + phone still missing: accepting would move to the shipping-fee step. */
  acceptBlocked?: boolean;
  onCounter: (amountSatang: number) => void;
}) {
  const [countering, setCountering] = useState(false);
  const [baht, setBaht] = useState('');
  const counterAmount = Number(baht) > 0 ? bahtToSatang(Number(baht)) : null;

  return (
    <Card>
      <CardTitle>{t.liff.priceTitle}</CardTitle>
      <div className="mt-1 text-center text-2xl font-semibold">{formatTHB(productPriceSatang)}</div>
      {note && <p className="mt-1 text-center text-xs text-[var(--muted)]">{note}</p>}
      {!countering ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="lg" disabled={busy || acceptBlocked} onClick={onAccept}>
            {t.liff.acceptBtn}
          </Button>
          <Button variant="secondary" size="lg" disabled={busy} onClick={() => setCountering(true)}>
            {t.liff.counterBtn}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Input inputMode="decimal" placeholder={t.liff.counterPlaceholder} value={baht} onChange={(e) => setBaht(e.target.value)} />
          <Button disabled={busy || counterAmount === null} onClick={() => counterAmount !== null && onCounter(counterAmount)}>
            {t.liff.counterSend}
          </Button>
        </div>
      )}
    </Card>
  );
}

function SlipUpload({
  t,
  orderId,
  auth,
  busy,
  onUploaded,
  setError,
}: {
  t: Dictionary;
  orderId: string;
  auth: { idToken: string | null; devUser: string | null };
  busy: boolean;
  onUploaded: () => void;
  setError: (msg: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function onFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const blob = await compressImage(file);
      const { uploadUrl, path } = await liffFetch<{ uploadUrl: string; path: string }>(`/api/liff/orders/${orderId}/slip-upload-url`, auth, {
        method: 'POST',
        body: { contentType: 'image/jpeg' },
      });
      if (!uploadUrl.startsWith('about:blank')) {
        await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      }
      await liffFetch(`/api/liff/orders/${orderId}/slip`, auth, { method: 'POST', body: { path } });
      onUploaded();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : t.liff.uploadError);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mt-4">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
        }}
      />
      <Button size="lg" disabled={busy || uploading} onClick={() => inputRef.current?.click()}>
        {uploading ? t.liff.uploading : t.liff.uploadSlip}
      </Button>
    </div>
  );
}
