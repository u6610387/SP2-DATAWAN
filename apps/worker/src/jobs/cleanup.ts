/**
 * Daily: delete slip / bill images older than STORAGE_RETENTION_DAYS (PDPA + 1 GB free tier), B2B
 * documents 30 days after the decision, and business-docs uploads with no document row after 1 day.
 */
import type { Deps } from '../deps';
import { purgeDecidedDocuments, sweepOrphanDocuments } from '../services/b2b';

export async function runImageCleanup(deps: Deps): Promise<number> {
  const days = deps.cfg.STORAGE_RETENTION_DAYS;
  const a = await deps.storage.deleteOlderThan('slips', days, deps.now());
  const b = await deps.storage.deleteOlderThan('supplier-bills', days, deps.now());
  const c = await purgeDecidedDocuments(deps);
  const d = await sweepOrphanDocuments(deps);
  return a + b + c + d;
}
