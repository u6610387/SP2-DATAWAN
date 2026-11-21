/** Daily: delete slip / bill images older than STORAGE_RETENTION_DAYS (PDPA + 1 GB free tier). */
import type { Deps } from '../deps';

export async function runImageCleanup(deps: Deps): Promise<number> {
  const days = deps.cfg.STORAGE_RETENTION_DAYS;
  const a = await deps.storage.deleteOlderThan('slips', days, deps.now());
  const b = await deps.storage.deleteOlderThan('supplier-bills', days, deps.now());
  return a + b;
}
