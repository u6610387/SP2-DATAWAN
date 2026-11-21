import { formatTHB, type Margin } from '@datawan/shared';
import { cn } from '@/lib/cn';
import type { Dictionary } from '@/lib/i18n/dictionary';

/**
 * The hero element of a pricing decision — CLAUDE.md's "code calculates, owner decides"
 * philosophy means this number is the thing the owner actually needs, so it gets its own
 * full-width panel (not a small pill squeezed beside an input) and a sign in the text itself,
 * never color alone (WCAG 1.4.1 — profit/loss must be legible without perceiving color).
 */
export function MarginPreview({ margin, t }: { margin: Margin; t: Dictionary }) {
  if (margin.marginSatang === null) {
    return <div className="mt-3 rounded-xl bg-black/5 px-4 py-3 text-sm font-medium text-[var(--muted)]">{t.orderDetail.marginUnknown}</div>;
  }
  const isProfit = margin.color === 'GREEN';
  const amount = formatTHB(Math.abs(margin.marginSatang));
  const pct = `${Math.round((margin.marginPct ?? 0) * 100)}%`;
  const label = isProfit ? t.orderDetail.marginProfit(amount, pct) : t.orderDetail.marginLoss(amount, pct);
  return (
    <div
      className={cn(
        'mt-3 rounded-xl px-4 py-3 text-center text-base font-semibold tabular-nums',
        isProfit ? 'bg-[var(--green-bg)] text-[var(--green)]' : 'bg-[var(--red-bg)] text-[var(--red)]',
      )}
    >
      {label}
    </div>
  );
}
