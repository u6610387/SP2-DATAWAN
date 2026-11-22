/**
 * Production config audit — Cloudflare secrets are write-only, so the only way to check that a
 * deployed Worker isn't running on template placeholders is for the Worker to check itself.
 *
 * Output is one log line of per-key verdicts: ok flag, issue code, live API status codes.
 * It NEVER contains a secret value or length. Fingerprints (sha256, first 8 hex) are only
 * emitted for values that are public anyway (LIFF ID, VAPID public key), so they can be
 * compared with the web build's NEXT_PUBLIC_* values.
 */
import type { Config } from '../env';
import { vapidKeyPairMatches } from './webpush';

export interface KeyVerdict {
  ok: boolean;
  issue?: string;
  [extra: string]: unknown;
}
export type AuditReport = Record<string, KeyVerdict>;

const PLACEHOLDER = /x{3,}|your[-_ ]?|change[-_ ]?me|placeholder|example\.(com|org)|<[^>]*>|^todo$|^test$|^dummy/i;

const good = (extra: Record<string, unknown> = {}): KeyVerdict => ({ ok: true, ...extra });
const bad = (issue: string, extra: Record<string, unknown> = {}): KeyVerdict => ({ ok: false, issue, ...extra });

function shape(value: string | undefined, re: RegExp, formatIssue: string): KeyVerdict | null {
  if (!value) return bad('empty');
  if (PLACEHOLDER.test(value)) return bad('placeholder_pattern');
  if (/^(.)\1+$/.test(value.replace(/^U/, ''))) return bad('repeated_char');
  if (!re.test(value)) return bad(formatIssue);
  return null; // shape OK — caller may add live checks
}

async function fp(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Thai national ID / tax ID checksum (13 digits). */
function thaiIdChecksumOk(id: string): boolean {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

async function status(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<number> {
  try {
    return (await fetchImpl(url, { headers })).status;
  } catch {
    return 0;
  }
}

export async function auditConfig(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<AuditReport> {
  const r: AuditReport = {};
  const lineAuth = { Authorization: `Bearer ${cfg.LINE_CHANNEL_ACCESS_TOKEN}` };

  r.LINE_CHANNEL_SECRET = shape(cfg.LINE_CHANNEL_SECRET, /^[0-9a-f]{32}$/, 'not_32_hex') ?? good();

  // Live: GET /v2/bot/info is free (no message quota) and only needs a valid channel token.
  r.LINE_CHANNEL_ACCESS_TOKEN =
    shape(cfg.LINE_CHANNEL_ACCESS_TOKEN, /^[A-Za-z0-9+/=._-]{100,}$/, 'unexpected_format') ??
    (await (async () => {
      const s = await status(fetchImpl, 'https://api.line.me/v2/bot/info', lineAuth);
      return s === 200 ? good({ lineBotInfo: s }) : bad('line_api_rejected', { lineBotInfo: s });
    })());

  // Live: GET /v2/bot/profile/{userId} — 200 only if that user has added this OA as a friend.
  const owners: KeyVerdict[] = [];
  for (const id of cfg.LINE_OWNER_USER_ID) {
    const sv = shape(id, /^U[0-9a-f]{32}$/, 'not_line_user_id');
    if (sv) owners.push(sv);
    else {
      const s = r.LINE_CHANNEL_ACCESS_TOKEN.ok ? await status(fetchImpl, `https://api.line.me/v2/bot/profile/${id}`, lineAuth) : -1;
      owners.push(s === 200 ? good({ profile: s }) : bad(s === 404 ? 'not_a_friend_of_this_oa' : 'profile_unchecked', { profile: s }));
    }
  }
  r.LINE_OWNER_USER_ID = owners.every((o) => o.ok) ? good({ count: owners.length }) : bad('see_ids', { ids: owners });

  r.LINE_LOGIN_CHANNEL_ID = shape(cfg.LINE_LOGIN_CHANNEL_ID, /^\d{10}$/, 'not_10_digits') ?? good();

  // A LIFF ID is "<LINE Login channel ID>-<8 chars>", so it must start with LINE_LOGIN_CHANNEL_ID.
  const liffShape = shape(cfg.LIFF_ID, /^\d{10}-[A-Za-z0-9]{8}$/, 'not_liff_id_format');
  r.LIFF_ID =
    liffShape ??
    (cfg.LIFF_ID.split('-')[0] === cfg.LINE_LOGIN_CHANNEL_ID
      ? good({ fp: await fp(cfg.LIFF_ID) })
      : bad('channel_prefix_mismatch', { fp: await fp(cfg.LIFF_ID) }));

  // Live: the owner's auth user must exist in THIS Supabase project and carry role=owner.
  r.OWNER_AUTH_USER_ID = await (async () => {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) return bad('supabase_unconfigured');
    try {
      const res = await fetchImpl(`${cfg.SUPABASE_URL}/auth/v1/admin/users/${cfg.OWNER_AUTH_USER_ID}`, {
        headers: { apikey: cfg.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${cfg.SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (!res.ok) return bad(res.status === 404 ? 'user_not_in_project' : 'supabase_admin_rejected', { status: res.status });
      const u = (await res.json()) as { id?: string; app_metadata?: { role?: string } };
      return u.app_metadata?.role === 'owner' ? good({ userId: u.id }) : bad('user_not_owner_role', { userId: u.id });
    } catch {
      return bad('supabase_unreachable');
    }
  })();

  // PromptPay: 10-digit mobile (0xxxxxxxxx), 13-digit national/tax ID (checksum), or 15-digit e-wallet.
  r.PROMPTPAY_ID = (() => {
    const v = cfg.PROMPTPAY_ID.replace(/[-\s]/g, '');
    const s = shape(v, /^(0\d{9}|\d{13}|\d{15})$/, 'not_phone_or_id');
    if (s) return s;
    if (['0812345678', '0800000000', '0123456789', '1234567890123'].includes(v)) return bad('known_example_value');
    if (v.length === 13 && !thaiIdChecksumOk(v)) return bad('national_id_checksum_failed');
    return good({ kind: v.length === 10 ? 'mobile' : v.length === 13 ? 'national_id' : 'ewallet' });
  })();

  r.PROMPTPAY_RECEIVER_NAME = cfg.PROMPTPAY_RECEIVER_NAME
    ? PLACEHOLDER.test(cfg.PROMPTPAY_RECEIVER_NAME) ? bad('placeholder_pattern') : good()
    : bad('empty_slip_receiver_check_disabled');

  const vapidPubShape = shape(cfg.VAPID_PUBLIC_KEY, /^[A-Za-z0-9_-]{86,88}$/, 'not_p256_public_key');
  r.VAPID_PUBLIC_KEY = vapidPubShape ?? good({ fp: await fp(cfg.VAPID_PUBLIC_KEY) });
  r.VAPID_PRIVATE_KEY =
    shape(cfg.VAPID_PRIVATE_KEY, /^[A-Za-z0-9_-]{42,44}$/, 'not_p256_private_key') ??
    (vapidPubShape ? bad('public_key_invalid') : (await vapidKeyPairMatches(cfg.VAPID_PRIVATE_KEY, cfg.VAPID_PUBLIC_KEY)) ? good() : bad('pair_mismatch'));

  r.VAPID_SUBJECT = /^(mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}|https:\/\/\S+)$/i.test(cfg.VAPID_SUBJECT)
    ? /example\.(com|org)|team-highlow@/i.test(cfg.VAPID_SUBJECT)
      ? bad('template_default')
      : good()
    : bad('not_mailto_or_https');

  return r;
}

/** One-line summary for logs: `ok` keys collapsed, failures kept in full. */
export function summarize(r: AuditReport): { ok: boolean; failing: AuditReport; passing: string[] } {
  const failing: AuditReport = {};
  const passing: string[] = [];
  for (const [k, v] of Object.entries(r)) (v.ok ? passing.push(k) : (failing[k] = v));
  const fps = Object.fromEntries(Object.entries(r).filter(([, v]) => v.ok && v.fp).map(([k, v]) => [k, v.fp]));
  return { ok: Object.keys(failing).length === 0, failing, passing: passing.map((k) => (fps[k] ? `${k}(fp=${fps[k]})` : k)) };
}
