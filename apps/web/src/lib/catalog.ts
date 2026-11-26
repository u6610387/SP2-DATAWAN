/** สต็อก tab helpers (pure, unit-tested). */
export interface StockRow {
  productId: string;
  nameTh: string;
  unit: string;
  onHand: number;
  categoryId: string | null;
  categoryName: string | null;
}
export interface Category {
  id: string;
  nameTh: string;
  sort: number;
}
export interface StockGroup {
  id: string | null;
  name: string | null;
  rows: StockRow[];
}

/** Groups in category order (empty categories included so new ones show up), "no category" last. */
export function groupStockByCategory(stock: StockRow[], categories: Category[]): StockGroup[] {
  const byCat = new Map<string | null, StockRow[]>();
  for (const r of stock) byCat.set(r.categoryId, [...(byCat.get(r.categoryId) ?? []), r]);
  const sortRows = (rows: StockRow[]) => [...rows].sort((a, b) => a.nameTh.localeCompare(b.nameTh, 'th'));
  const groups: StockGroup[] = [...categories]
    .sort((a, b) => a.sort - b.sort || a.nameTh.localeCompare(b.nameTh, 'th'))
    .map((c) => ({ id: c.id, name: c.nameTh, rows: sortRows(byCat.get(c.id) ?? []) }));
  const known = new Set(categories.map((c) => c.id));
  const orphans = stock.filter((r) => r.categoryId === null || !known.has(r.categoryId));
  if (orphans.length) groups.push({ id: null, name: null, rows: sortRows(orphans) });
  return groups;
}

/** "ทับทิม, ปลาทับทิมสด\nทับทิมแดง" → trimmed, unique, non-empty words. */
export function parseAliases(text: string): string[] {
  const out: string[] = [];
  for (const a of text.split(/[,\n、;]+/).map((x) => x.trim().replace(/\s+/g, ' '))) {
    if (a && !out.some((o) => o.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  return out;
}

export const UNIT_OPTIONS = ['kg', 'piece', 'box', 'tray', 'set'] as const;
export const PREP_OPTIONS = ['live', 'chilled', 'frozen', 'cooked', 'any'] as const;
