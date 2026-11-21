import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import type { MarginColor } from '@datawan/shared';

const COLOR_CLASS: Record<MarginColor, string> = {
  GREEN: 'bg-[var(--green-bg)] text-[var(--green)]',
  RED: 'bg-[var(--red-bg)] text-[var(--red)]',
  GREY: 'bg-black/5 text-[var(--muted)]',
};

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold', className)} {...props} />;
}

export function MarginBadge({ color, children }: { color: MarginColor; children: React.ReactNode }) {
  return <Badge className={COLOR_CLASS[color]}>{children}</Badge>;
}
