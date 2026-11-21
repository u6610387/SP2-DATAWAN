'use client';
/** LIFF realtime: Broadcast on order:{id}:{token} (ARCHITECTURE_AND_DB.md §1.3 / line-liff-architect §6.2). */
import { useEffect, useRef } from 'react';
import { getSupabaseClient } from './supabase';

const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === 'true';

export function useOrderBroadcast(channel: string | undefined, version: number, onStale: () => void): void {
  const versionRef = useRef(version);
  versionRef.current = version;

  useEffect(() => {
    if (USE_MOCKS || !channel) return;
    const supabase = getSupabaseClient();
    const ch = supabase
      .channel(channel)
      .on('broadcast', { event: 'order_updated' }, ({ payload }) => {
        const incoming = (payload as { version?: number }).version ?? 0;
        if (incoming > versionRef.current) onStale();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);
}
