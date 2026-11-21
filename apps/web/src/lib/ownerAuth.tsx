'use client';
/** Owner Supabase Auth session → access token for ownerFetch(). Mocks mode skips Supabase entirely. */
import { createContext, useContext, useEffect, useState } from 'react';
import { getSupabaseClient } from './supabase';

const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === 'true';

interface OwnerAuthState {
  loading: boolean;
  token: string | null;
}

const Ctx = createContext<OwnerAuthState>({ loading: true, token: null });

export function OwnerAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OwnerAuthState>(USE_MOCKS ? { loading: false, token: 'mock-owner-token' } : { loading: true, token: null });

  useEffect(() => {
    if (USE_MOCKS) return;
    const supabase = getSupabaseClient();
    supabase.auth.getSession().then(({ data }) => setState({ loading: false, token: data.session?.access_token ?? null }));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ loading: false, token: session?.access_token ?? null });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useOwnerAuth(): OwnerAuthState {
  return useContext(Ctx);
}
