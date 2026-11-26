/** สต็อก tab: grouping, alias parsing, add-product form. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddCategoryForm } from '@/components/catalog/AddCategoryForm';
import { AddProductForm } from '@/components/catalog/AddProductForm';
import { groupStockByCategory, parseAliases, type StockRow } from '@/lib/catalog';
import { th } from '@/lib/i18n/th';

const row = (productId: string, nameTh: string, categoryId: string | null): StockRow => ({ productId, nameTh, unit: 'kg', onHand: 1, categoryId, categoryName: null });

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
