'use client';
/** Owner Web Push opt-in (VAPID). Registers public/sw.js, subscribes, posts to /api/owner/push-subscriptions. */
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { ownerFetch } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import { useOwnerAuth } from '@/lib/ownerAuth';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
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
      .then((sub) => {
        if (sub) setStatus('subscribed');
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
    <Button size="sm" variant="secondary" onClick={subscribe}>
      {t.pushButton.enable}
    </Button>
  );
}
