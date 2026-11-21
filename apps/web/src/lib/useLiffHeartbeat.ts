'use client';
/** Presence heartbeat: POST every 30s while the tab is visible (used by the Worker's push-quota decision). */
import { useEffect } from 'react';
import { liffFetch } from './api';

export function useLiffHeartbeat(orderId: string | undefined, auth: { idToken: string | null; devUser: string | null }): void {
  useEffect(() => {
    if (!orderId) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void liffFetch(`/api/liff/orders/${orderId}/heartbeat`, auth, { method: 'POST' });
    };
    tick();
    const interval = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, auth.idToken, auth.devUser]);
}
