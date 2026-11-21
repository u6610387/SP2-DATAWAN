/**
 * Worker configuration. Every limit and key comes from env (CLAUDE.md §6), so switching
 * team keys → owner keys is a config-only change.
 */
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes'].includes(v.toLowerCase())));
const num = (d: number) => z.coerce.number().default(d);

export const ConfigSchema = z.object({
  APP_ENV: z.enum(['dev', 'exhibition', 'defence', 'production']).default('dev'),

  LINE_CHANNEL_SECRET: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  /**
   * One or more owner LINE userIds, comma-separated (e.g. owner + co-owner phone).
   * Parsed to a de-duplicated array; every listed ID is routed to the owner command handler.
   */
  LINE_OWNER_USER_ID: z
    .string()
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.string().regex(/^U[0-9a-f]{32}$/, 'LINE userId must be U + 32 hex chars')).min(1)),
  LINE_PUSH_MONTHLY_LIMIT: num(300),
  QUOTA_WARN_RATIO: num(0.8),
  QUOTA_SAVER_RATIO: num(0.95),
  MAX_PUSH_PER_ORDER: num(1),
  LIFF_PRESENCE_SECONDS: num(60),
  LIFF_ID: z.string().default(''),
  /**
   * Browser origins allowed to call /api/* (dashboard + LIFF frontend), comma-separated.
   * Per-environment value in wrangler.toml [vars]; default covers local `next dev`.
   */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean))]),
  LINE_LOGIN_CHANNEL_ID: z.string().default(''),
  /** Dev-only LIFF auth bypass (x-liff-dev-user header). Verifier also requires APP_ENV==='dev'. */
  LIFF_DEV_BYPASS: bool.default(false),

  SUPABASE_URL: z.string().default(''),
  SUPABASE_ANON_KEY: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  STORAGE_RETENTION_DAYS: num(60),
  /** Supabase auth.users id of the owner — recorded as paid_confirmed_by / created_by for LINE commands. */
  OWNER_AUTH_USER_ID: z.string().uuid(),

  USE_MOCK_AI: bool.default(true),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  GEMINI_SLIP_MODE: z.enum(['paid', 'manual', 'redacted']).default('paid'),
  GEMINI_SLIP_API_KEY: z.string().optional(),

  PROMPTPAY_ID: z.string().min(1),
  PROMPTPAY_RECEIVER_NAME: z.string().default(''),
  PAYMENT_EXPIRY_MINUTES: num(45),
  OWNER_REMINDER_MINUTES: num(15),
  ABANDON_HOURS: num(24),
  /** After DELIVERED, a non-order chat message still gets that order's status card for this long. */
  RECENT_ORDER_STATUS_HOURS: num(24),
  DEFAULT_MARKUP: num(0.25),
  OWNER_POLITENESS: z.enum(['ค่ะ', 'ครับ']).default('ค่ะ'),

  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:team-highlow@example.com'),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Raw bindings as Wrangler provides them (vars + secrets are strings). */
export type Bindings = Record<string, string | undefined>;

/** True when `userId` is one of the configured owner LINE accounts. */
export function isOwnerLineUser(cfg: Pick<Config, 'LINE_OWNER_USER_ID'>, userId: string | undefined): boolean {
  return !!userId && cfg.LINE_OWNER_USER_ID.includes(userId);
}

export function loadConfig(env: Bindings): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid worker configuration: ${fields}`);
  }
  return parsed.data;
}
