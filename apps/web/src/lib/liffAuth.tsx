'use client';
/**
 * LIFF auth — real @line/liff ID token, or a dev-only bypass (mock line_user_id in
 * localStorage) so the order room can be tested in a normal Chrome tab without opening LINE.
 * The Worker still hard-gates the bypass header to APP_ENV==='dev' (auth/liff.ts) — this is
 * just the client half of that story.
 */
import { createContext, useContext, useEffect, useState } from 'react';

const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === 'true';
const DEV_BYPASS = process.env.NEXT_PUBLIC_LIFF_DEV_BYPASS === 'true';
const LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID;

export interface LiffAuthState {
  loading: boolean;
  idToken: string | null;
  devUser: string | null;
  error: string | null;
}

const Ctx = createContext<LiffAuthState>({ loading: true, idToken: null, devUser: null, error: null });

function devUserId(): string {
  const KEY = 'dtw-dev-line-user-id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `Udev${Math.random().toString(16).slice(2).padEnd(30, '0').slice(0, 30)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

export function LiffAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LiffAuthState>({ loading: true, idToken: null, devUser: null, error: null });

  useEffect(() => {
    if (USE_MOCKS || DEV_BYPASS) {
      setState({ loading: false, idToken: null, devUser: devUserId(), error: null });
      return;
    }
    (async () => {
      try {
        const liffModule = await import('@line/liff');
        const liff = liffModule.default;
        await liff.init({ liffId: LIFF_ID! });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return; // LINE redirects back here after login
        }
        setState({ loading: false, idToken: liff.getIDToken(), devUser: null, error: null });
      } catch (e) {
        setState({ loading: false, idToken: null, devUser: null, error: e instanceof Error ? e.message : 'LIFF init failed' });
      }
    })();
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useLiffAuth(): LiffAuthState {
  return useContext(Ctx);
}
