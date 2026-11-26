'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { Dictionary } from '@/lib/i18n/dictionary';

export function AddCategoryForm({ t, busy, onSubmit, onCancel }: { t: Dictionary; busy: boolean; onSubmit: (nameTh: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  return (
    <Card>
      <CardTitle>{t.catalog.addCategory}</CardTitle>
      <label className="mt-2 block text-xs text-[var(--muted)]" htmlFor="category-name">
        {t.catalog.categoryName}
      </label>
      <Input id="category-name" value={name} placeholder={t.catalog.categoryPlaceholder} onChange={(e) => setName(e.target.value)} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t.catalog.cancel}
        </Button>
        <Button disabled={busy || !name.trim()} onClick={() => onSubmit(name.trim())}>
          {t.catalog.save}
        </Button>
      </div>
    </Card>
  );
}
