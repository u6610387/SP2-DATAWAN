/** Cron dispatcher — schedules declared in wrangler.toml. */
import type { Deps } from '../deps';
import { refreshQuota } from '../line/quota';
import { runImageCleanup } from './cleanup';
import { runAbandonment, runOwnerReminders, runPaymentExpiry } from './timers';

export const CRONS = {
  EVERY_MINUTE: '* * * * *',
  QUOTA: '*/10 * * * *',
  CLEANUP: '0 20 * * *', // 03:00 Asia/Bangkok
  KEEPALIVE: '0 1 * * 1', // Monday 08:00 Bangkok — Supabase free-tier pause guard (D5)
} as const;

export async function runScheduled(deps: Deps, cron: string): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  const safe = async (name: string, fn: () => Promise<number | string>) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = `error: ${(e as Error).message}`;
      console.error(`[cron:${name}]`, e);
    }
  };
  switch (cron) {
    case CRONS.EVERY_MINUTE:
      await safe('ownerReminders', () => runOwnerReminders(deps));
      await safe('paymentExpiry', () => runPaymentExpiry(deps));
      await safe('abandonment', () => runAbandonment(deps));
      break;
    case CRONS.QUOTA:
      await safe('quota', async () => (await refreshQuota(deps)).mode);
      break;
    case CRONS.CLEANUP:
      await safe('cleanup', () => runImageCleanup(deps));
      break;
    case CRONS.KEEPALIVE:
      await safe('keepalive', async () => (await deps.repo.listActiveProducts()).length);
      break;
  }
  return out;
}
