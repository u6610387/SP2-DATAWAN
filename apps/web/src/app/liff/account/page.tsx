'use client';
import { useState } from 'react';
import useSWR from 'swr';
import type { B2bApplyRequest } from '@datawan/shared';
import { B2bApplicationForm, type B2bFormFields } from '@/components/B2bApplicationForm';
import { ApiRequestError, applyB2b, getAccount, getB2bDocUploadUrl } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import { useLiffAuth } from '@/lib/liffAuth';

export default function LiffAccountPage() {
  const auth = useLiffAuth();
  const { t } = useLanguage();

  if (auth.loading) return <p className="p-6 text-center text-sm text-[var(--muted)]">{t.liff.loggingIn}</p>;
  if (auth.error) return <p className="p-6 text-center text-sm text-[var(--red)]">{t.liff.loginError(auth.error)}</p>;
  return <Account auth={{ idToken: auth.idToken, devUser: auth.devUser }} />;
}

function Account({ auth }: { auth: { idToken: string | null; devUser: string | null } }) {
  const { t } = useLanguage();
  const { data: account, mutate } = useSWR(['liff-account', auth.idToken, auth.devUser], () => getAccount(auth));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(fields: B2bFormFields, photos: Blob[]) {
    setBusy(true);
    setError(null);
    try {
      const documentPaths: string[] = [];
      for (const blob of photos) {
        const { uploadUrl, path } = await getB2bDocUploadUrl(auth, 'image/jpeg');
        if (!uploadUrl.startsWith('about:blank')) {
          const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
          if (!res.ok) throw new Error('upload failed');
        }
        documentPaths.push(path);
      }
      const body: B2bApplyRequest = { ...fields, documentPaths };
      await mutate(await applyB2b(auth, body), { revalidate: false });
    } catch (e) {
      setError(e instanceof ApiRequestError ? (e.code === 'TOO_MANY_DOCUMENTS' ? t.account.tooManyDocuments : e.message) : t.account.genericError);
    } finally {
      setBusy(false);
    }
  }

  if (!account) return <div className="h-40 animate-pulse rounded-2xl bg-black/5" />;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t.account.title}</h1>
      {error && <p className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">{error}</p>}
      {/* key: re-seed the form's initial values whenever the server copy changes (after a submit). */}
      <B2bApplicationForm key={`${account.b2b?.status ?? 'none'}-${account.b2b?.businessName ?? ''}`} account={account} t={t} busy={busy} onSubmit={submit} />
    </div>
  );
}

