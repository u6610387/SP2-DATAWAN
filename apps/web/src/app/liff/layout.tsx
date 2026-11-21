'use client';
import type { ReactNode } from 'react';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useLanguage } from '@/lib/i18n/context';
import { LiffAuthProvider } from '@/lib/liffAuth';

function LiffChrome({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  return (
    <div className="mx-auto min-h-dvh max-w-md px-4 py-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-[var(--muted)]">{t.common.brand}</span>
        <LanguageToggle />
      </header>
      {children}
    </div>
  );
}

export default function LiffLayout({ children }: { children: ReactNode }) {
  return (
    <LiffAuthProvider>
      <LiffChrome>{children}</LiffChrome>
    </LiffAuthProvider>
  );
}
