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
import { groupStockByCategory, type Category, type StockRow } from '@/lib/catalog';
import { AddCategoryForm } from '@/components/catalog/AddCategoryForm';
import { AddProductForm, type NewProduct } from '@/components/catalog/AddProductForm';


type Reason = 'stock_in' | 'waste' | 'adjust';

export default function InventoryPage() {
  const { token } = useOwnerAuth();
  const { t } = useLanguage();
  const { data: stock, mutate } = useSWR(token ? ['stock', token] : null, () => ownerFetch<StockRow[]>('/api/owner/stock', token!), { refreshInterval: 20_000 });
  const { data: categories, mutate: mutateCategories } = useSWR(token ? ['categories', token] : null, () => ownerFetch<Category[]>('/api/owner/categories', token!));
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<'category' | 'product' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setAdding(null);
      setNotice(ok);
      await Promise.all([mutate(), mutateCategories()]);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  const addCategory = (nameTh: string) =>
    save(() => ownerFetch('/api/owner/categories', token!, { method: 'POST', body: { nameTh } }), t.catalog.categoryAdded(nameTh));
  const addProduct = (p: NewProduct) =>
    save(
      () => ownerFetch('/api/owner/products', token!, { method: 'POST', body: { nameTh: p.nameTh, unit: p.unit, prepTypes: p.prepTypes, aliases: p.aliases, categoryId: p.categoryId } }),
      t.catalog.productAdded(p.nameTh),
    );
  const groups = stock ? groupStockByCategory(stock, categories ?? []) : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" size="lg" disabled={busy} aria-expanded={adding === 'category'} onClick={() => setAdding(adding === 'category' ? null : 'category')}>
          {t.catalog.addCategoryButton}
        </Button>
        <Button size="lg" disabled={busy} aria-expanded={adding === 'product'} onClick={() => setAdding(adding === 'product' ? null : 'product')}>
          {t.catalog.addProductButton}
        </Button>
      </div>
      {error && <p className="rounded-xl bg-[var(--red-bg)] p-3 text-sm text-[var(--red)]">{error}</p>}
      {notice && <p className="rounded-xl bg-[var(--green-bg)] p-3 text-sm text-[var(--green)]">{notice}</p>}
      {adding === 'category' && <AddCategoryForm t={t} busy={busy} onSubmit={addCategory} onCancel={() => setAdding(null)} />}
      {adding === 'product' && <AddProductForm t={t} busy={busy} categories={categories ?? []} onSubmit={addProduct} onCancel={() => setAdding(null)} />}

      <Card>
        <CardTitle>{t.inventory.title}</CardTitle>
        {!groups ? (
          <div className="mt-2 h-24 animate-pulse rounded-lg bg-black/5" />
        ) : (
          groups.map((g) => (
          <section key={g.id ?? 'none'} className="mt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{g.name ?? t.catalog.noCategory}</h3>
          {g.rows.length === 0 && <p className="py-2 text-sm text-[var(--muted)]">{t.catalog.emptyCategory}</p>}
          <ul className="divide-y divide-[var(--border)]">
            {g.rows.map((row) => (
              <li key={row.productId} className="py-3">
                <button
                  className="flex w-full items-center justify-between text-left"
                  aria-expanded={open === row.productId}
                  onClick={() => setOpen(open === row.productId ? null : row.productId)}
                >
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
          </section>
          ))
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
            type="button"
            aria-pressed={reason === r.value}
            onClick={() => setReason(r.value)}
            className={`rounded-full px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${
              reason === r.value ? 'bg-[var(--brand)] text-white' : 'bg-[var(--card)] text-[var(--muted)]'
            }`}
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
