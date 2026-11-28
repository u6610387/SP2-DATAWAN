/** Cron dispatcher — schedules declared in wrangler.toml. */
import type { Deps } from '../deps';
import { refreshQuota } from '../line/quota';
import { runImageCleanup } from './cleanup';
import { runAbandonment, runOwnerReminders, runPaymentExpiry, type ActionBudget } from './timers';

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
    case CRONS.EVERY_MINUTE: {
      // One action budget for the whole run, so a backlog can't go past the Workers Free limit of
      // 50 subrequests mid-order (status changed, audit row or owner alert lost). Payment expiry
      // goes first: it closes the payment window, the most time-sensitive of the three.
      const budget: ActionBudget = { left: deps.cfg.CRON_MAX_ACTIONS_PER_RUN };
      await safe('paymentExpiry', () => runPaymentExpiry(deps, budget));
      await safe('ownerReminders', () => runOwnerReminders(deps, budget));
      await safe('abandonment', () => runAbandonment(deps, budget));
      break;
    }
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
