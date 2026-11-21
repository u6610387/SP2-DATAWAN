'use client';
import { useEffect, useState } from 'react';
import { formatRemaining } from '@/lib/countdown';

export function Countdown({ until }: { until: string }) {
  const [remainingMs, setRemainingMs] = useState(() => Date.parse(until) - Date.now());

  useEffect(() => {
    const id = setInterval(() => setRemainingMs(Date.parse(until) - Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);

  return <span className={remainingMs <= 0 ? 'text-[var(--red)]' : undefined}>{formatRemaining(remainingMs)}</span>;
}
