import { cn } from '@/lib/cn';

export function Progress({
  value,
  markers,
  className,
  barClassName,
}: {
  value: number;
  /** Percentages (0-100) to mark with a tick line, e.g. the 80% quota warning threshold. */
  markers?: number[];
  className?: string;
  barClassName?: string;
}) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className={cn('relative h-3.5 w-full overflow-hidden rounded-full bg-black/10', className)}>
      <div className={cn('h-full rounded-full bg-[var(--brand)] transition-all duration-300', barClassName)} style={{ width: `${pct}%` }} />
      {markers?.map((m) => (
        <div key={m} className="absolute top-0 h-full w-px bg-[var(--bg)]/70" style={{ left: `${Math.min(100, Math.max(0, m))}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}
