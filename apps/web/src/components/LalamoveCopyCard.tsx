'use client';
/** Owner dashboard: Lalamove fields with 1-tap copy each (raw values only) + Copy all. */
import { useEffect, useRef, useState } from 'react';
import type { OwnerOrderView } from '@datawan/shared';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { copyText, lalamoveFields } from '@/lib/lalamove';

type Key = 'pin' | 'name' | 'phone' | 'address' | 'all';

function CopyButton({ k, value, copied, onCopy, t, wide }: { k: Key; value: string; copied: Key | null; onCopy: (k: Key, v: string) => void; t: Dictionary; wide?: boolean }) {
  const done = copied === k;
  return (
    <Button
      variant={done ? 'primary' : 'secondary'}
      size="sm"
      className={`${wide ? 'w-full' : 'shrink-0'} min-h-10`}
      data-copy={value}
      aria-live="polite"
      onClick={() => onCopy(k, value)}
    >
      {done ? t.orderDetail.lalamoveCopied : t.common.copy}
    </Button>
  );
}

export function LalamoveCopyCard({ order, t }: { order: OwnerOrderView; t: Dictionary }) {
  const f = lalamoveFields(order);
  const [copied, setCopied] = useState<Key | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const onCopy = async (k: Key, v: string) => {
    if (!(await copyText(v))) return;
    setCopied(k);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1500);
  };

  const row = (k: Exclude<Key, 'all'>, label: string, shown: string | null, value: string | null, extra?: React.ReactNode, prefix?: string) => (
    <div className="border-t border-[var(--border)] py-2 first:border-t-0">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <div className="min-w-0 flex-1 break-words text-sm">
          {shown ? (
            <>
              {prefix && <span className="mr-1 rounded bg-black/5 px-1 text-xs text-[var(--muted)]">{prefix}</span>}
              {shown}
            </>
          ) : (
            <span className="text-[var(--muted)]">{t.orderDetail.lalamoveMissing}</span>
          )}
        </div>
        {value && <CopyButton k={k} value={value} copied={copied} onCopy={onCopy} t={t} />}
      </div>
      {extra}
    </div>
  );

  return (
    <Card>
      <CardTitle>{t.orderDetail.lalamoveTitle}</CardTitle>
      <div className="mt-2">
        {row(
          'pin',
          t.orderDetail.lalamovePin,
          f.pin,
          f.pin,
          f.mapUrl && (
            <a href={f.mapUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-[var(--brand)] underline">
              {t.orderDetail.lalamoveOpenMap}
            </a>
          ),
        )}
        {row('name', t.orderDetail.lalamoveName, f.name, f.name)}
        {row('phone', t.orderDetail.lalamovePhone, f.phoneDisplay, f.phoneForPlus66, f.phoneForPlus66 && <p className="mt-1 text-xs text-[var(--muted)]">{t.orderDetail.lalamovePhoneHint(f.phoneForPlus66)}</p>, '+66')}
        {row('address', t.orderDetail.lalamoveAddress, f.address, f.address)}
      </div>
      {f.all && (
        <div className="mt-3">
          <CopyButton k="all" value={f.all} copied={copied} onCopy={onCopy} t={{ ...t, common: { ...t.common, copy: t.orderDetail.lalamoveCopyAll } }} wide />
        </div>
      )}
    </Card>
  );
}
