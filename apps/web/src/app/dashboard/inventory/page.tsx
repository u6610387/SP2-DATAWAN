'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { bahtToSatang } from '@datawan/shared';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiRequestError, ownerFetch } from '@/lib/api';
import { useLanguage } from '@/lib/i18n/context';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { useOwnerAuth } from '@/lib/ownerAuth';

interface StockRow {
  productId: string;
  nameTh: string;
  unit: string;
  onHand: number;
}

type Reason = 'stock_in' | 'waste' | 'adjust';

export default function InventoryPage() {
  const { token } = useOwnerAuth();
  const { t } = useLanguage();
  const { data: stock, mutate } = useSWR(token ? ['stock', token] : null, () => ownerFetch<StockRow[]>('/api/owner/stock', token!), { refreshInterval: 20_000 });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>{t.inventory.title}</CardTitle>
        {!stock ? (
          <div className="mt-2 h-24 animate-pulse rounded-lg bg-black/5" />
        ) : (
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {stock.map((row) => (
              <li key={row.productId} className="py-3">
                <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(open === row.productId ? null : row.productId)}>
                  <span>{row.nameTh}</span>
                  <span className="font-semibold">
                    {row.onHand} {row.unit}
                  </span>
                </button>
                {open === row.productId && (
                  <AdjustForm
                    t={t}
                    token={token!}
                    productId={row.productId}
                    onDone={() => {
                      setOpen(null);
                      void mutate();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function AdjustForm({ t, token, productId, onDone }: { t: Dictionary; token: string; productId: string; onDone: () => void }) {
  const REASONS: { value: Reason; label: string }[] = [
    { value: 'stock_in', label: t.inventory.reasonStockIn },
    { value: 'waste', label: t.inventory.reasonWaste },
    { value: 'adjust', label: t.inventory.reasonAdjust },
  ];
  const [reason, setReason] = useState<Reason>('stock_in');
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const n = Number(qty);
    if (!Number.isFinite(n) || n === 0) return;
    const qtyDelta = reason === 'stock_in' ? Math.abs(n) : -Math.abs(n);
    setBusy(true);
    setError(null);
    try {
      await ownerFetch('/api/owner/stock', token, {
        method: 'POST',
        body: {
          productId,
          reason,
          qtyDelta,
          unitCostSatang: reason === 'stock_in' && unitCost ? bahtToSatang(Number(unitCost)) : null,
          note: note || null,
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-xl bg-black/5 p-3">
      <div className="flex gap-2">
        {REASONS.map((r) => (
          <button
            key={r.value}
            onClick={() => setReason(r.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${reason === r.value ? 'bg-[var(--brand)] text-white' : 'bg-[var(--card)]'}`}
          >
            {r.label}
          </button>
        ))}
      </div>
      <Input inputMode="decimal" placeholder={t.inventory.qtyPlaceholder} value={qty} onChange={(e) => setQty(e.target.value)} />
      {reason === 'stock_in' && <Input inputMode="decimal" placeholder={t.inventory.unitCostPlaceholder} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />}
      <Input placeholder={t.inventory.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="text-xs text-[var(--red)]">{error}</p>}
      <Button size="sm" disabled={busy || !qty} onClick={submit}>
        {t.inventory.save}
      </Button>
    </div>
  );
}
