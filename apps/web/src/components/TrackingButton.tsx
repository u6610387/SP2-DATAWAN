'use client';
/** Big "ติดตามการจัดส่ง (Lalamove)" button whenever the order has a courier link (https only). */
import { extractTrackingUrl, isLalamoveUrl } from '@datawan/shared';
import type { Dictionary } from '@/lib/i18n/dictionary';

export function TrackingButton({ url, t }: { url: string | null; t: Dictionary }) {
  const safe = url ? extractTrackingUrl(url) : null;
  if (!safe) return null;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer"
      className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[var(--brand)] px-4 py-3 text-center text-base font-semibold text-white shadow-sm active:opacity-90"
    >
      <span aria-hidden="true">🚚</span>
      {isLalamoveUrl(safe) ? t.liff.trackLalamove : t.liff.trackDelivery}
    </a>
  );
}

/** Owner dashboard: did the tracking link reach the customer by LINE push? */
export function trackingPushNotice(t: Dictionary, p: { sent: boolean; reason: string | null } | null): { tone: 'ok' | 'info'; text: string } | null {
  if (!p) return null;
  if (p.sent) return { tone: 'ok', text: t.orderDetail.trackingPushSent };
  const why = (t.orderDetail.trackingPushReasons as Record<string, string>)[p.reason ?? ''] ?? p.reason ?? '';
  return { tone: 'info', text: t.orderDetail.trackingPushDeferred(why) };
}
