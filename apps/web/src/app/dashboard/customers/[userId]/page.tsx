'use client';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR, { useSWRConfig } from 'swr';
import type { OwnerB2bDetailView } from '@datawan/shared';
import { B2bActions, B2bDetailFields } from '@/components/B2bReview';
import { Card } from '@/components/ui/card';
import {
  acknowledgeB2bCustomer, ApiRequestError, approveB2bCustomer, getB2bCustomer, rejectB2bCustomer, revokeB2bCustomer,
} from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import { useOwnerAuth } from '@/lib/ownerAuth';

export default function CustomerDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();
  const { token } = useOwnerAuth();
  const { t } = useLanguage();
  const { mutate: globalMutate } = useSWRConfig();
  const { data: view, error, mutate } = useSWR(token ? ['b2b-detail', userId, token] : null, () => getB2bCustomer(token!, userId));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<OwnerB2bDetailView>) {
    setBusy(true);
    setMessage(null);
    try {
      await mutate(await action(), { revalidate: false });
      void globalMutate((key) => Array.isArray(key) && key[0] === 'b2b-list');
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409) {
        setMessage(t.customers.changedReload);
        await mutate();
      } else {
        setMessage(e instanceof Error ? e.message : t.common.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={() => router.push('/dashboard/customers')} className="-ml-2 inline-flex h-10 items-center rounded-full px-2 text-sm font-medium text-[var(--brand)]">
        ← {t.customers.back}
      </button>
      {error && !view && <p className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">{t.customers.loadError}</p>}
      {!view && !error && <div className="h-40 animate-pulse rounded-2xl bg-black/5" />}
      {message && <p className="rounded-xl bg-[var(--yellow-bg)] p-3 text-sm text-[var(--yellow)]">{message}</p>}
      {view && (
        <>
          <Card><B2bDetailFields view={view} t={t} /></Card>
          <B2bActions
            view={view}
            t={t}
            busy={busy}
            onApprove={() => run(() => approveB2bCustomer(token!, userId))}
            onReject={(r) => run(() => rejectB2bCustomer(token!, userId, r))}
            onAcknowledge={() => run(() => acknowledgeB2bCustomer(token!, userId))}
            onRevoke={(r) => run(() => revokeB2bCustomer(token!, userId, r))}
          />
        </>
      )}
    </div>
  );
}
