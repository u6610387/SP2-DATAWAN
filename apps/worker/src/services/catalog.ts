/**
 * Owner catalog management (สต็อก tab): categories + products, via owner-authenticated routes.
 * The order parser reads the active catalog on every message and matches aliases, so the product
 * name is always included as an alias — a new product is recognised on the very next message.
 */
import type { CategoryRow, ProductCreateRequest, ProductRow, ProductUpdateRequest } from '@datawan/shared';
import type { Deps } from '../deps';

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const isUniqueViolation = (e: unknown) => /duplicate key|unique constraint|23505/i.test((e as Error)?.message ?? '');

export type CreateCategoryResult = { ok: true; category: CategoryRow } | { ok: false; reason: 'DUPLICATE' };

export async function createCategory(deps: Deps, nameTh: string): Promise<CreateCategoryResult> {
  const name = nameTh.trim().replace(/\s+/g, ' ');
  const existing = await deps.repo.listActiveCategories();
  if (existing.some((c) => norm(c.name_th) === norm(name))) return { ok: false, reason: 'DUPLICATE' };
  try {
    const sort = existing.reduce((m, c) => Math.max(m, c.sort), 0) + 10;
    return { ok: true, category: await deps.repo.insertCategory({ name_th: name, sort }) };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: 'DUPLICATE' };
    throw e;
  }
}

export type CreateProductResult =
  | { ok: true; product: ProductRow; merged?: true }
  | { ok: false; reason: 'DUPLICATE' }
  | { ok: false; reason: 'ALIAS_TAKEN'; alias: string; productName: string }
  | { ok: false; reason: 'CATEGORY_NOT_FOUND' };

/** name + extra aliases, de-duplicated, ≥ 2 chars (the parser ignores 1-char aliases). */
export function productAliases(nameTh: string, aliases: string[]): string[] {
  const out: string[] = [];
  for (const a of [nameTh, ...aliases].map((x) => x.trim().replace(/\s+/g, ' '))) {
    if (a.length >= 2 && !out.some((o) => norm(o) === norm(a))) out.push(a);
  }
  return out;
}

export async function createProduct(deps: Deps, input: ProductCreateRequest): Promise<CreateProductResult> {
  const name = input.nameTh.trim().replace(/\s+/g, ' ');
  if (input.categoryId) {
    const c = await deps.repo.getCategory(input.categoryId);
    if (!c?.is_active) return { ok: false, reason: 'CATEGORY_NOT_FOUND' };
  }
  const active = await deps.repo.listActiveProducts();
  const existing = active.find((p) => norm(p.name_th) === norm(name));
  if (existing) {
    // Same name, still uncategorised, and the owner now picked a category: assign it (and merge any
    // new aliases) instead of refusing — that's what "add it again into ปลา" means.
    if (existing.category_id === null && input.categoryId) {
      const r = await updateProduct(deps, existing.id, { categoryId: input.categoryId, aliases: [...existing.aliases, ...input.aliases] });
      if (r.ok) return { ok: true, product: r.product, merged: true };
      if (r.reason === 'ALIAS_TAKEN') return r;
      if (r.reason === 'CATEGORY_NOT_FOUND') return { ok: false, reason: 'CATEGORY_NOT_FOUND' };
      return { ok: false, reason: 'DUPLICATE' };
    }
    return { ok: false, reason: 'DUPLICATE' };
  }
  const aliases = productAliases(name, input.aliases);
  // An alias already used by another product would make the parser pick the wrong one.
  for (const a of aliases) {
    const owner = active.find((p) => [p.name_th, ...p.aliases].some((x) => norm(x) === norm(a)));
    if (owner) return { ok: false, reason: 'ALIAS_TAKEN', alias: a, productName: owner.name_th };
  }
  try {
    const product = await deps.repo.insertProduct({
      name_th: name,
      aliases,
      unit: input.unit,
      prep_types: [...new Set(input.prepTypes)],
      category_id: input.categoryId,
    });
    return { ok: true, product };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: 'DUPLICATE' };
    throw e;
  }
}

export type UpdateProductResult =
  | { ok: true; product: ProductRow }
  | { ok: false; reason: 'NOT_FOUND' | 'DUPLICATE' | 'CATEGORY_NOT_FOUND' }
  | { ok: false; reason: 'ALIAS_TAKEN'; alias: string; productName: string };

/**
 * Edit from the สต็อก list. The name stays an alias (a rename drops the old name and adds the new one);
 * name and alias conflicts are checked against the OTHER active products.
 */
export async function updateProduct(deps: Deps, id: string, patch: ProductUpdateRequest): Promise<UpdateProductResult> {
  const current = await deps.repo.getProduct(id);
  if (!current) return { ok: false, reason: 'NOT_FOUND' };
  if (patch.categoryId) {
    const c = await deps.repo.getCategory(patch.categoryId);
    if (!c?.is_active) return { ok: false, reason: 'CATEGORY_NOT_FOUND' };
  }
  const name = patch.nameTh !== undefined ? patch.nameTh.trim().replace(/\s+/g, ' ') : current.name_th;
  const willBeActive = patch.isActive ?? current.is_active;
  const others = (await deps.repo.listActiveProducts()).filter((p) => p.id !== id);
  if (willBeActive && others.some((p) => norm(p.name_th) === norm(name))) return { ok: false, reason: 'DUPLICATE' };

  const extra = patch.aliases ?? current.aliases.filter((a) => norm(a) !== norm(current.name_th));
  const aliases = productAliases(name, extra);
  if (willBeActive) {
    for (const a of aliases) {
      const owner = others.find((p) => [p.name_th, ...p.aliases].some((x) => norm(x) === norm(a)));
      if (owner) return { ok: false, reason: 'ALIAS_TAKEN', alias: a, productName: owner.name_th };
    }
  }
  try {
    const product = await deps.repo.updateProduct(id, {
      name_th: name,
      aliases,
      ...(patch.unit ? { unit: patch.unit } : {}),
      ...(patch.prepTypes ? { prep_types: [...new Set(patch.prepTypes)] } : {}),
      ...(patch.categoryId !== undefined ? { category_id: patch.categoryId } : {}),
      ...(patch.isActive !== undefined ? { is_active: patch.isActive } : {}),
    });
    return { ok: true, product };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: 'DUPLICATE' };
    throw e;
  }
}

