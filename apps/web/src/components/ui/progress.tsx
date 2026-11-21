import { cn } from '@/lib/cn';

export function Progress({ value, className, barClassName }: { value: number; className?: string; barClassName?: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className={cn('h-3 w-full overflow-hidden rounded-full bg-black/10', className)}>
      <div className={cn('h-full rounded-full bg-[var(--brand)] transition-all', barClassName)} style={{ width: `${pct}%` }} />
    </div>
  );
}
