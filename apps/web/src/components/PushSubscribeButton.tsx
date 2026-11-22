'use client';
/**
 * Owner Web Push opt-in (VAPID). Icon-only in the header so it doesn't crowd the language
 * toggle on narrow screens — the action is named via aria-label, not a wide text pill.
 */
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { ownerFetch } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import { useOwnerAuth } from '@/lib/ownerAuth';
import { subscriptionUsesKey, urlBase64ToUint8Array } from '@/lib/vapid';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function BellIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

type Status = 'idle' | 'subscribed' | 'unsupported' | 'denied';

export function PushSubscribeButton() {
  const { token } = useOwnerAuth();
  const { t } = useLanguage();
  const [status, setStatus] = useState<Status>('idle');

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('unsupported');
      return;
    }
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then(async (sub) => {
        if (!sub) return;
        // A subscription made with a previous VAPID key can never receive pushes again —
        // drop it so the bell reappears and the owner can opt in with the current key.
        if (VAPID_PUBLIC_KEY && !subscriptionUsesKey(sub.options.applicationServerKey, VAPID_PUBLIC_KEY)) {
          await sub.unsubscribe();
          return;
        }
        setStatus('subscribed');
      })
      .catch(() => {});
  }, []);

  async function subscribe() {
    if (!token || !VAPID_PUBLIC_KEY) return;
    const reg = await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('denied');
      return;
    }
    const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await ownerFetch('/api/owner/push-subscriptions', token, { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
    setStatus('subscribed');
  }

  if (status === 'unsupported' || status === 'subscribed') return null;
  return (
    <button
      type="button"
      title={t.pushButton.enable}
      aria-label={t.pushButton.enableAria}
      onClick={subscribe}
      className={cn(
        'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted)] transition-colors',
        'hover:text-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-1',
      )}
    >
      <BellIcon className="h-5 w-5" />
    </button>
  );
}
