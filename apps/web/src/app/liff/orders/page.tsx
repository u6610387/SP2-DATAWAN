'use client';
/**
 * LIFF order list: open orders + history, with one-tap "สั่งซ้ำ" on delivered orders.
 * Reorder copies the items only (no AI, no prices); the shop quotes today's price as usual.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { formatTHB, type CustomerOrderSummary } from '@datawan/shared';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ApiRequestError, listLiffOrders, reorderFrom } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { useLiffAuth } from '@/lib/liffAuth';
import { reorderSkippedKey } from '@/lib/reorder';

type Auth = { idToken: string | null; devUser: string | null };

export default function LiffOrdersPage() {
  const auth = useLiffAuth();
  const { t } = useLanguage();
  if (auth.loading) return <p className="p-6 text-center text-sm text-[var(--muted)]">{t.liff.loggingIn}</p>;
  if (auth.error) return <p className="p-6 text-center text-sm text-[var(--red)]">{t.liff.loginError(auth.error)}</p>;
  return <Orders auth={{ idToken: auth.idToken, devUser: auth.devUser }} />;
}

function Orders({ auth }: { auth: Auth }) {
  const { t, lang } = useLanguage();
  const router = useRouter();
  const open = useSWR(['liff-orders', 'open', auth.idToken, auth.devUser], () => listLiffOrders(auth, 'open'));
  const past = useSWR(['liff-orders', 'history', auth.idToken, auth.devUser], () => listLiffOrders(auth, 'history'));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  async function onReorder(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const order = await reorderFrom(auth, id);
      if (order.skippedItems.length) sessionStorage.setItem(reorderSkippedKey(order.id), JSON.stringify(order.skippedItems));
      router.push(`/liff/orders/${order.id}`);
    } catch (e) {
      setError(e instanceof ApiRequestError && e.code === 'NOTHING_TO_REORDER' ? t.history.nothingToReorder : e instanceof ApiRequestError ? e.message : t.liff.genericError);
      setBusyId(null);
      void past.mutate();
    }
  }

  const loading = !open.data || !past.data;
  const loadError = open.error || past.error;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t.history.title}</h1>
      {error && <p className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">{error}</p>}
      {loadError && <p className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">{t.liff.genericError}</p>}
      {loading && !loadError && <div className="h-40 animate-pulse rounded-2xl bg-black/5" />}

      {open.data && open.data.length > 0 && (
        <section className="space-y-2">
          <CardTitle>{t.history.openTitle}</CardTitle>
          {open.data.map((o) => (
            <OrderCard key={o.id} order={o} t={t} when={t.history.placedOn(fmt(o.createdAt))} />
          ))}
        </section>
      )}

      {past.data && (
        <section className="space-y-2">
          <CardTitle>{t.history.pastTitle}</CardTitle>
          {past.data.length === 0 && (open.data?.length ?? 0) === 0 && <Card className="text-sm text-[var(--muted)]">{t.history.empty}</Card>}
          {past.data.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              t={t}
              when={o.deliveredAt ? t.history.deliveredOn(fmt(o.deliveredAt)) : t.history.placedOn(fmt(o.createdAt))}
              action={
                o.reorderable ? (
                  <Button size="sm" disabled={busyId !== null} onClick={() => void onReorder(o.id)}>
                    {busyId === o.id ? t.history.reordering : t.history.reorder}
                  </Button>
                ) : null
              }
            />
          ))}
        </section>
      )}

      <p className="pt-2 text-center text-xs">
        <Link href="/liff/account" className="text-[var(--muted)] underline">
          {t.account.myAccountLink}
        </Link>
      </p>
    </div>
  );
}

function OrderCard({ order, t, when, action }: { order: CustomerOrderSummary; t: Dictionary; when: string; action?: React.ReactNode }) {
  const more = order.itemCount - order.itemsPreview.length;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <Link href={`/liff/orders/${order.id}`} className="font-semibold underline-offset-2 hover:underline">
          {t.liff.orderLabel(order.code)}
        </Link>
        <span className="rounded-full bg-black/5 px-3 py-1 text-xs font-medium">{t.orderStatus[order.status]}</span>
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">{when}</p>
      <ul className="mt-2 space-y-0.5 text-sm">
        {order.itemsPreview.map((it, i) => (
          <li key={i} className="flex justify-between">
            <span>{it.name}</span>
            <span className="text-[var(--muted)]">
              {it.qty} {it.unit}
            </span>
          </li>
        ))}
        {more > 0 && <li className="text-xs text-[var(--muted)]">{t.history.moreItems(more)}</li>}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-sm tabular-nums">{order.totalSatang !== null ? formatTHB(order.totalSatang) : ''}</span>
        {action}
      </div>
    </Card>
  );
}
