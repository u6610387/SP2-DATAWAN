'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PREP_OPTIONS, UNIT_OPTIONS, parseAliases, suggestCategory, type Category } from '@/lib/catalog';
import type { Dictionary } from '@/lib/i18n/dictionary';

export interface NewProduct {
  nameTh: string;
  unit: (typeof UNIT_OPTIONS)[number];
  prepTypes: (typeof PREP_OPTIONS)[number][];
  aliases: string[];
  categoryId: string | null;
}

export function AddProductForm({
  t,
  busy,
  categories,
  defaultCategoryId = null,
  onSubmit,
  onCancel,
}: {
  t: Dictionary;
  busy: boolean;
  categories: Category[];
  defaultCategoryId?: string | null;
  onSubmit: (p: NewProduct) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<NewProduct['unit']>('kg');
  const [categoryId, setCategoryId] = useState<string | null>(defaultCategoryId);
  // Auto-pick a category from the typed name until the owner chooses one by hand.
  const [categoryTouched, setCategoryTouched] = useState(defaultCategoryId !== null);
  const auto = !categoryTouched ? suggestCategory(name, categories) : null;
  const onName = (v: string) => {
    setName(v);
    if (!categoryTouched) setCategoryId(suggestCategory(v, categories)?.id ?? null);
  };
  const [prep, setPrep] = useState<NewProduct['prepTypes']>(['any']);
  const [aliasText, setAliasText] = useState('');
  const togglePrep = (p: NewProduct['prepTypes'][number]) =>
    setPrep((cur) => {
      if (p === 'any') return ['any'];
      const next = cur.filter((x) => x !== 'any');
      const toggled = next.includes(p) ? next.filter((x) => x !== p) : [...next, p];
      return toggled.length ? toggled : ['any'];
    });

  return (
    <Card>
      <CardTitle>{t.catalog.addProduct}</CardTitle>
      <label className="mt-2 block text-xs text-[var(--muted)]" htmlFor="product-name">
        {t.catalog.productName}
      </label>
      <Input id="product-name" value={name} placeholder={t.catalog.productPlaceholder} onChange={(e) => onName(e.target.value)} />

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-[var(--muted)]" htmlFor="product-unit">
            {t.catalog.unit}
          </label>
          <select id="product-unit" className="mt-1 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm" value={unit} onChange={(e) => setUnit(e.target.value as NewProduct['unit'])}>
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {t.catalog.units[u]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--muted)]" htmlFor="product-category">
            {t.catalog.category}
          </label>
          <select id="product-category" className="mt-1 h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm" value={categoryId ?? ''} onChange={(e) => {
              setCategoryTouched(true);
              setCategoryId(e.target.value || null);
            }}>
            <option value="">{t.catalog.noCategory}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nameTh}
              </option>
            ))}
          </select>
        </div>
      </div>

      {auto && categoryId === auto.id && <p className="mt-1 text-xs text-[var(--brand)]">{t.catalog.autoCategory(auto.nameTh)}</p>}

      <div className="mt-3 text-xs text-[var(--muted)]">{t.catalog.prepTypes}</div>
      <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label={t.catalog.prepTypes}>
        {PREP_OPTIONS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={prep.includes(p)}
            onClick={() => togglePrep(p)}
            className={`min-h-10 rounded-full border px-3 text-sm ${prep.includes(p) ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-[var(--border)]'}`}
          >
            {t.catalog.preps[p]}
          </button>
        ))}
      </div>

      <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="product-aliases">
        {t.catalog.aliases}
      </label>
      <Input id="product-aliases" value={aliasText} placeholder={t.catalog.aliasesPlaceholder} onChange={(e) => setAliasText(e.target.value)} />
      <p className="mt-1 text-xs text-[var(--muted)]">{t.catalog.aliasesHint}</p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t.catalog.cancel}
        </Button>
        <Button disabled={busy || !name.trim()} onClick={() => onSubmit({ nameTh: name.trim(), unit, prepTypes: prep, aliases: parseAliases(aliasText), categoryId })}>
          {t.catalog.save}
        </Button>
      </div>
    </Card>
  );
}
