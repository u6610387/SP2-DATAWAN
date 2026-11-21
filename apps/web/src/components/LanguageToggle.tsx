'use client';
import { cn } from '@/lib/cn';
import { useLanguage, type Lang } from '@/lib/i18n/context';

const OPTIONS: { value: Lang; label: string }[] = [
  { value: 'th', label: 'TH' },
  { value: 'en', label: 'EN' },
];

export function LanguageToggle() {
  const { lang, setLang } = useLanguage();

  return (
    <div role="group" aria-label="Language / ภาษา" className="inline-flex items-center rounded-full border border-[var(--border)] bg-black/5 p-0.5">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={lang === opt.value}
          onClick={() => setLang(opt.value)}
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-1',
            lang === opt.value ? 'bg-[var(--brand)] text-white' : 'text-[var(--muted)] hover:text-[var(--fg)]',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
