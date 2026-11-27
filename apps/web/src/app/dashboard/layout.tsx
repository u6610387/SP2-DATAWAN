'use client';
import { useEffect } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LanguageToggle } from '@/components/LanguageToggle';
import { PushSubscribeButton } from '@/components/PushSubscribeButton';
import { listB2bCustomers } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import { useOwnerAuth, OwnerAuthProvider } from '@/lib/ownerAuth';

function Guard({ children }: { children: React.ReactNode }) {
  const { loading, token } = useOwnerAuth();
  const { t } = useLanguage();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !token) router.replace('/login');
  }, [loading, token, router]);

  if (loading) return <div className="p-6 text-center text-sm text-[var(--muted)]">{t.common.loading}</div>;
  if (!token) return null;
  return <>{children}</>;
}

function TabLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href + '/'));
  return (
    <Link href={href} className={`flex-1 py-3 text-center text-sm font-medium ${active ? 'text-[var(--brand)]' : 'text-[var(--muted)]'}`}>
      {label}
    </Link>
  );
}

function DashboardChrome({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();
  const { token } = useOwnerAuth();
  // Fetched once on mount; no polling (the list page refreshes it).
  const pending = useSWR(token ? ['b2b-list', 'pending', token] : null, () => listB2bCustomers(token!, 'pending'), { revalidateOnFocus: false, revalidateIfStale: false });
  const pendingCount = pending.data?.length ?? 0;
  return (
    <div className="mx-auto min-h-dvh max-w-md pb-24">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)]/90 px-4 py-3 backdrop-blur">
        <span className="min-w-0 flex-1 truncate font-semibold">{t.common.brand}</span>
        <div className="flex shrink-0 items-center gap-2">
          <PushSubscribeButton />
          <LanguageToggle />
        </div>
      </header>
      <main className="px-4 py-4">{children}</main>
      <nav className="fixed bottom-0 left-0 right-0 z-10 mx-auto flex max-w-md border-t border-[var(--border)] bg-[var(--card)]">
        <TabLink href="/dashboard" label={t.nav.home} />
        <TabLink href="/dashboard/inventory" label={t.nav.inventory} />
        <TabLink href="/dashboard/customers" label={pendingCount > 0 ? `${t.nav.customers} (${pendingCount})` : t.nav.customers} />
      </nav>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <OwnerAuthProvider>
      <Guard>
        <DashboardChrome>{children}</DashboardChrome>
      </Guard>
    </OwnerAuthProvider>
  );
}
