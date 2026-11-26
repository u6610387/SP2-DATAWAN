/** สต็อก tab: grouping, alias parsing, add-product form. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddCategoryForm } from '@/components/catalog/AddCategoryForm';
import { AddProductForm } from '@/components/catalog/AddProductForm';
import { extraAliases, groupStockByCategory, parseAliases, suggestCategory, type StockRow } from '@/lib/catalog';
import { CategoryQuickSelect, ProductEditForm } from '@/components/catalog/ProductRowEditor';
import { th } from '@/lib/i18n/th';

const row = (productId: string, nameTh: string, categoryId: string | null, extra: Partial<StockRow> = {}): StockRow => ({ productId, nameTh, unit: 'kg', onHand: 1, categoryId, categoryName: null, isActive: true, aliases: [nameTh], ...extra });

describe('groupStockByCategory', () => {
  it('orders by category sort, keeps empty categories, puts uncategorised (and unknown) last, sorts rows by Thai name', () => {
    const groups = groupStockByCategory(
      [row('p1', 'หอยแครง', 'c2'), row('p2', 'ปลากะพง', 'c1'), row('p3', 'ปลาทับทิม', 'c1'), row('p4', 'กุ้งแม่น้ำ', null), row('p5', 'ปูม้า', 'gone')],
      [{ id: 'c2', nameTh: 'หอย', sort: 20 }, { id: 'c1', nameTh: 'ปลา', sort: 10 }, { id: 'c3', nameTh: 'ปลาหมึก', sort: 30 }],
    );
    expect(groups.map((g) => [g.name, g.rows.map((r) => r.nameTh)])).toEqual([
      ['ปลา', ['ปลากะพง', 'ปลาทับทิม']],
      ['หอย', ['หอยแครง']],
      ['ปลาหมึก', []],
      [null, ['กุ้งแม่น้ำ', 'ปูม้า']],
    ]);
  });
});

describe('parseAliases', () => {
  it('splits on commas/new lines, trims, de-duplicates', () => {
    expect(parseAliases(' ทับทิม , ปลาทับทิมสด\nทับทิม,, ทับทิม  แดง ')).toEqual(['ทับทิม', 'ปลาทับทิมสด', 'ทับทิม แดง']);
    expect(parseAliases('')).toEqual([]);
  });
});

describe('add forms', () => {
  it('product form: name, unit, category (incl. none), prep chips, aliases hint; save disabled until named', () => {
    const html = renderToStaticMarkup(<AddProductForm t={th} busy={false} categories={[{ id: 'c1', nameTh: 'ปลา', sort: 10 }]} onSubmit={() => {}} onCancel={() => {}} />);
    for (const id of ['product-name', 'product-unit', 'product-category', 'product-aliases']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('<option value="kg" selected="">กิโลกรัม (กก.)</option>');
    expect(html).toMatch(/<option value=""( selected="")?>ไม่มีหมวดหมู่<\/option>/);
    expect(html).toContain('<option value="c1">ปลา</option>');
    for (const p of Object.values(th.catalog.preps)) expect(html).toContain(`>${p}</button>`);
    expect(html).toMatch(/aria-pressed="true"[^>]*>ไม่ระบุ<\/button>/);
    expect(html).toContain(th.catalog.aliasesHint);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>บันทึก<\/button>/);
  });
  it('category form: one name field, save disabled until named', () => {
    const html = renderToStaticMarkup(<AddCategoryForm t={th} busy={false} onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).toContain('id="category-name"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>บันทึก<\/button>/);
  });
  it('buttons read "+ เพิ่มหมวดหมู่" / "+ เพิ่มสินค้า"', () => {
    expect(th.catalog.addCategoryButton).toBe('+ เพิ่มหมวดหมู่');
    expect(th.catalog.addProductButton).toBe('+ เพิ่มสินค้า');
  });
});

// Production 2026-11-26: ปลาทับทิม landed in "ไม่มีหมวดหมู่" and couldn't be moved.
describe('suggestCategory (auto-select while typing)', () => {
  const cats = [{ id: 'c1', nameTh: 'ปลา', sort: 10 }, { id: 'c2', nameTh: 'ปลาหมึก', sort: 20 }, { id: 'c3', nameTh: 'กุ้ง', sort: 30 }];
  it.each([
    ['ปลาทับทิม', 'c1'],
    ['ปลาหมึกกล้วย', 'c2'], // longest prefix wins over "ปลา"
    ['  กุ้งแม่น้ำ ', 'c3'],
    ['หัวปลาแซลมอน', 'c1'], // contains, when no prefix matches
    ['หอยแครง', null],
    ['', null],
  ])('%s → %s', (name, id) => expect(suggestCategory(name, cats)?.id ?? null).toBe(id));
});

describe('row editing', () => {
  const r = row('p1', 'ปลาทับทิม', null, { aliases: ['ปลาทับทิม', 'ทับทิม'] });
  it('extraAliases hides the name (the server always re-adds it)', () => {
    expect(extraAliases(r)).toEqual(['ทับทิม']);
  });
  it('one-tap category selector lists "no category" + every category, current one selected', () => {
    const html = renderToStaticMarkup(<CategoryQuickSelect row={{ ...r, categoryId: 'c1' }} categories={[{ id: 'c1', nameTh: 'ปลา', sort: 10 }]} t={th} busy={false} onMove={() => {}} />);
    expect(html).toContain(th.catalog.moveToCategory);
    expect(html).toMatch(/<option value="c1" selected="">ปลา<\/option>/);
    expect(html).toContain('>ไม่มีหมวดหมู่</option>');
  });
  it('edit form pre-fills name, extra aliases and the open-for-sale toggle', () => {
    const html = renderToStaticMarkup(<ProductEditForm row={r} t={th} busy={false} onSave={() => {}} onCancel={() => {}} />);
    expect(html).toContain('value="ปลาทับทิม"');
    expect(html).toContain('value="ทับทิม"');
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toContain(th.catalog.openForSale);
  });
});

