'use client';
import useSWR from 'swr';
import Link from 'next/link';
import { formatTHB, type OrderStatus, type OwnerOrderView, type QuotaStatus } from '@datawan/shared';
import { Badge, MarginBadge } from '@/components/ui/badge';
import { B2bBadge } from '@/components/B2bBadge';
import { Card, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ownerFetch } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import { useOwnerAuth } from '@/lib/ownerAuth';
import { useOwnerRealtime } from '@/lib/useOwnerRealtime';

interface TodaySummary {
  ordersDelivered: number;
  productRevenueSatang: number;
  shippingCollectedSatang: number;
  grossMarginSatang: number;
  openByStatus: Record<string, number>;
}

const BOARD_ORDER: OrderStatus[] = [
  'AWAITING_PRICE',
  'PRICE_QUOTED',
  'NEGOTIATING',
  'AWAITING_SHIPPING_FEE',
  'AWAITING_PAYMENT',
  'PAYMENT_EXPIRED',
  'PAYMENT_REVIEW',
  'PAID',
  'DELIVERING',
];

export default function DashboardHome() {
  const { token } = useOwnerAuth();
  const { t } = useLanguage();
  const summary = useSWR(token ? ['summary', token] : null, () => ownerFetch<TodaySummary>('/api/owner/summary/today', token!));
  const quota = useSWR(token ? ['quota', token] : null, () => ownerFetch<QuotaStatus>('/api/owner/quota', token!), { refreshInterval: 30_000 });
  const orders = useSWR(token ? ['orders', token] : null, () => ownerFetch<OwnerOrderView[]>('/api/owner/orders', token!), { refreshInterval: 15_000 });

  useOwnerRealtime(() => {
    void summary.mutate();
    void quota.mutate();
    void orders.mutate();
  });

  const grouped = new Map<OrderStatus, OwnerOrderView[]>();
  for (const o of orders.data ?? []) {
    if (!grouped.has(o.status)) grouped.set(o.status, []);
    grouped.get(o.status)!.push(o);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>{t.dashboard.salesToday}</CardTitle>
        {summary.data ? (
          <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
            <Stat label={t.dashboard.delivered} value={`${summary.data.ordersDelivered}`} />
            <Stat label={t.dashboard.productRevenue} value={formatTHB(summary.data.productRevenueSatang)} />
            <Stat label={t.dashboard.shipping} value={formatTHB(summary.data.shippingCollectedSatang)} />
            <Stat label={t.dashboard.grossMargin} value={formatTHB(summary.data.grossMarginSatang)} />
          </div>
        ) : (
          <Skeleton />
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{t.dashboard.quotaTitle}</CardTitle>
          {quota.data && (
            <div className="flex items-center gap-2">
              <span className="text-xs tabular-nums text-[var(--muted)]">
                {quota.data.used} / {quota.data.limit}
              </span>
              <Badge
                className={
                  quota.data.mode === 'QUOTA_SAVER'
                    ? 'bg-[var(--red-bg)] text-[var(--red)]'
                    : quota.data.mode === 'WARNING'
                      ? 'bg-[var(--yellow-bg)] text-[var(--yellow)]'
                      : 'bg-[var(--green-bg)] text-[var(--green)]'
                }
              >
                {quota.data.mode === 'QUOTA_SAVER' ? t.dashboard.quotaSaverBadge : quota.data.mode === 'WARNING' ? t.dashboard.quotaWarningBadge : t.dashboard.quotaNormal}
              </Badge>
            </div>
          )}
        </div>
        {quota.data ? (
          <>
            <Progress
              value={(quota.data.used / quota.data.limit) * 100}
              markers={[80, 95]}
              className="mt-3"
              barClassName={quota.data.mode === 'QUOTA_SAVER' ? 'bg-[var(--red)]' : quota.data.mode === 'WARNING' ? 'bg-[var(--yellow)]' : undefined}
            />
            {quota.data.mode === 'WARNING' && <p className="mt-2 text-xs text-[var(--yellow)]">{t.dashboard.quotaWarning}</p>}
            {quota.data.mode === 'QUOTA_SAVER' && <p className="mt-2 text-xs text-[var(--red)]">{t.dashboard.quotaSaver}</p>}
          </>
        ) : (
          <Skeleton />
        )}
      </Card>

      {orders.error && (
        <p role="alert" className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">
          {t.dashboard.ordersLoadError}
        </p>
      )}

      <div className="space-y-3">
        {BOARD_ORDER.filter((s) => grouped.has(s)).map((status) => (
          <Card key={status}>
            <CardTitle>
              {t.orderStatus[status]} ({grouped.get(status)!.length})
            </CardTitle>
            <div className="mt-2 space-y-2">
              {grouped.get(status)!.map((o) => (
                <Link key={o.id} href={`/dashboard/orders/${o.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3">
                  <div className="min-w-0">
                    <div className="font-semibold">{o.code}</div>
                    <div className="truncate text-xs text-[var(--muted)]">{o.customer.name ?? o.customer.businessName ?? '-'}</div>
                    <B2bBadge b2b={o.customer.b2b} />
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {o.totalSatang !== null ? (
                      <span className="text-sm tabular-nums">{formatTHB(o.totalSatang)}</span>
                    ) : o.productPriceSatang !== null ? (
                      <span className="text-sm tabular-nums">{formatTHB(o.productPriceSatang)}</span>
                    ) : o.suggestedPriceSatang !== null ? (
                      <span className="text-sm tabular-nums text-[var(--muted)]">~{formatTHB(o.suggestedPriceSatang)}</span>
                    ) : null}
                    <MarginBadge color={o.marginColor}>{o.marginColor === 'GREY' ? '—' : o.marginColor === 'GREEN' ? t.dashboard.profit : t.dashboard.loss}</MarginBadge>
                    {o.needsOwnerReview && <Badge className="bg-[var(--yellow-bg)] text-[var(--yellow)]">{t.dashboard.needsReview}</Badge>}
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        ))}
        {orders.data && orders.data.length === 0 && <p className="py-8 text-center text-sm text-[var(--muted)]">{t.dashboard.noOpenOrders}</p>}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function Skeleton() {
  return <div className="mt-2 h-10 animate-pulse rounded-lg bg-black/5" />;
}
