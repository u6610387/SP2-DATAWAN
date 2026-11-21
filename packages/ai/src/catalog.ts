import type { CatalogRef } from '@datawan/shared';
import type { CatalogProduct } from './types';

/** Map DB UUIDs to short refs so no internal IDs reach the AI (API_AND_AI_CONTRACTS §5.1). */
export interface CatalogMapping {
  catalog: CatalogRef[];
  refToId: Map<string, string>;
  idToRef: Map<string, string>;
}

export function toCatalogRefs(products: CatalogProduct[]): CatalogMapping {
  const refToId = new Map<string, string>();
  const idToRef = new Map<string, string>();
  const catalog = products.map((p, i) => {
    const ref = `p${i}`;
    refToId.set(ref, p.id);
    idToRef.set(p.id, ref);
    return {
      productRef: ref,
      nameTh: p.name_th,
      aliases: Array.from(new Set([p.name_th, ...p.aliases])),
      unit: p.unit,
      prepTypes: p.prep_types,
    };
  });
  return { catalog, refToId, idToRef };
}

export function allAliases(products: CatalogProduct[]): string[] {
  return products.flatMap((p) => [p.name_th, ...p.aliases]);
}
