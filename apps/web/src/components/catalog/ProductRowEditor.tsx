'use client';
/** สต็อก row: one-tap category move + edit name / aliases / open-closed for sale. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { extraAliases, parseAliases, type Category, type StockRow } from '@/lib/catalog';
import type { Dictionary } from '@/lib/i18n/dictionary';

export interface ProductPatch {
  nameTh?: string;
  aliases?: string[];
  categoryId?: string | null;
  isActive?: boolean;
}

export function CategoryQuickSelect({ row, categories, t, busy, onMove }: { row: StockRow; categories: Category[]; t: Dictionary; busy: boolean; onMove: (categoryId: string | null) => void }) {
  return (
    <div className="mt-3">
      <label className="block text-xs text-[var(--muted)]" htmlFor={`move-${row.productId}`}>
        {t.catalog.moveToCategory}
      </label>
      <select
        id={`move-${row.productId}`}
        className="mt-1 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm"
        disabled={busy}
        value={row.categoryId ?? ''}
        onChange={(e) => onMove(e.target.value || null)}
      >
        <option value="">{t.catalog.noCategory}</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.nameTh}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ProductEditForm({ row, t, busy, onSave, onCancel }: { row: StockRow; t: Dictionary; busy: boolean; onSave: (p: ProductPatch) => void; onCancel: () => void }) {
  const [name, setName] = useState(row.nameTh);
  const [aliasText, setAliasText] = useState(extraAliases(row).join(', '));
  const [active, setActive] = useState(row.isActive);
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-[var(--border)] p-3">
      <label className="block text-xs text-[var(--muted)]" htmlFor={`edit-name-${row.productId}`}>
        {t.catalog.productName}
      </label>
      <Input id={`edit-name-${row.productId}`} value={name} onChange={(e) => setName(e.target.value)} />
      <label className="block text-xs text-[var(--muted)]" htmlFor={`edit-aliases-${row.productId}`}>
        {t.catalog.aliases}
      </label>
      <Input id={`edit-aliases-${row.productId}`} value={aliasText} placeholder={t.catalog.aliasesPlaceholder} onChange={(e) => setAliasText(e.target.value)} disabled={!row.isActive && !active} />
      <label htmlFor={`edit-active-${row.productId}`} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-[var(--border)] px-3 text-sm">
        <input id={`edit-active-${row.productId}`} type="checkbox" className="h-6 w-6 accent-[var(--brand)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span>{t.catalog.openForSale}</span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t.catalog.cancel}
        </Button>
        <Button
          disabled={busy || !name.trim()}
          onClick={() => onSave({ nameTh: name.trim(), ...(row.isActive || active ? { aliases: parseAliases(aliasText) } : {}), isActive: active })}
        >
          {t.catalog.save}
        </Button>
      </div>
    </div>
  );
}
