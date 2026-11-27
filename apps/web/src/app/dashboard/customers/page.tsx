'use client';
import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { listB2bCustomers, type B2bFilter } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import { useOwnerAuth } from '@/lib/ownerAuth';

export default function CustomersPage() {
  const { token } = useOwnerAuth();
  const { t } = useLanguage();
  const c = t.customers;
  const [filter, setFilter] = useState<B2bFilter>('pending');
  const list = useSWR(token ? ['b2b-list', filter, token] : null, () => listB2bCustomers(token!, filter));
  const pending = useSWR(token ? ['b2b-list', 'pending', token] : null, () => listB2bCustomers(token!, 'pending'));
  const tabs: { key: B2bFilter; label: string }[] = [
    { key: 'pending', label: c.tabPending(pending.data?.length ?? 0) },
    { key: 'b2b', label: c.tabB2b },
    { key: 'all', label: c.tabAll },
  ];
  const statusLabel = { PENDING_VERIFICATION: c.statusPending, VERIFIED: c.statusVerified, REJECTED: c.statusRejected } as const;

  return (
    <div className="space-y-3">
      <div role="tablist" className="flex gap-1 rounded-xl bg-black/5 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={filter === tab.key}
            onClick={() => setFilter(tab.key)}
            className={`flex-1 rounded-lg px-2 py-2 text-xs font-medium ${filter === tab.key ? 'bg-[var(--card)] text-[var(--brand)] shadow-sm' : 'text-[var(--muted)]'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {list.error && <p className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">{c.loadError}</p>}
      {list.data?.map((u) => (
        <Link key={u.userId} href={`/dashboard/customers/${u.userId}`}>
          <Card className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-semibold">{u.businessName}</div>
              <div className="truncate text-xs text-[var(--muted)]">{u.customerName ?? '-'} · {t.account.types[u.businessType]}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge className="bg-black/5">{statusLabel[u.status]}</Badge>
              {u.needsRereview && <Badge className="bg-[var(--yellow-bg)] text-[var(--yellow)]">{c.needsRereview}</Badge>}
            </div>
          </Card>
        </Link>
      ))}
      {list.data && list.data.length === 0 && <p className="py-8 text-center text-sm text-[var(--muted)]">{c.empty}</p>}
    </div>
  );
}
