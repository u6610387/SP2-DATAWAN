'use client';
/**
 * LIFF Endpoint URL page (LINE Developers Console → Endpoint URL = <web origin>/liff).
 *
 * Order links are https://liff.line.me/<LIFF_ID>/orders/<id>. LINE first opens THIS page with the
 * extra path in `?liff.state=%2Forders%2F<id>` (primary redirect); liff.init() — run by
 * LiffAuthProvider in ../layout.tsx — then forwards to /liff/orders/<id> (secondary redirect).
 * Without this page the primary redirect 404s and liff.init() never runs.
 *
 * Do not navigate or rewrite the URL here: LINE requires that nothing changes the URL before
 * liff.init() resolves, and the SDK performs the forward itself.
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '@/lib/i18n/context';
import { useLiffAuth } from '@/lib/liffAuth';

export default function LiffEndpointPage() {
  const auth = useLiffAuth();
  const { t } = useLanguage();
  // null until mounted (window isn't available during prerender).
  const [hasTarget, setHasTarget] = useState<boolean | null>(null);

  useEffect(() => {
    setHasTarget(new URLSearchParams(window.location.search).has('liff.state'));
  }, []);

  if (auth.error) return <p className="p-6 text-center text-sm text-[var(--red)]">{t.liff.loginError(auth.error)}</p>;
  if (auth.loading || hasTarget !== false) {
    return <p className="p-6 text-center text-sm text-[var(--muted)]">{auth.loading ? t.liff.loggingIn : t.liff.openingOrder}</p>;
  }
  return <p className="p-6 text-center text-sm text-[var(--muted)]">{t.liff.openFromCard}</p>;
}
