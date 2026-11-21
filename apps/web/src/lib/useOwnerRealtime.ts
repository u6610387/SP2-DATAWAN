'use client';
/** Dashboard realtime: direct postgres_changes (ARCHITECTURE_AND_DB.md §1.3), RLS via is_owner(). */
import { useEffect } from 'react';
import { getSupabaseClient } from './supabase';

const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === 'true';

export function useOwnerRealtime(onChange: () => void): void {
  useEffect(() => {
    if (USE_MOCKS) return;
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel('owner-dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'negotiations' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quota_logs' }, onChange)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
