/**
 * Owner dashboard auth: verify the Supabase access token and require app_metadata.role==='owner'
 * (API_AND_AI_CONTRACTS.md §1). Raw fetch against Auth's /user endpoint — no supabase-js client
 * needed for this, consistent with the other REST-backed services (storage.ts, realtime.ts).
 *
 * Every rejection logs one `[auth:owner]` line with the reason, Supabase's status/error_code and
 * the Supabase host (public — the browser has the same URL). Never the token or keys.
 */
export function createSupabaseOwnerVerifier(
  supabaseUrl: string,
  anonKey: string,
  fetchImpl: typeof fetch = fetch,
  log: (msg: string) => void = (m) => console.warn(m),
) {
  let host = '(unset)';
  try {
    if (supabaseUrl) host = new URL(supabaseUrl).host;
  } catch {
    host = '(invalid url)';
  }
  const reject = (reason: string, extra: Record<string, unknown> = {}) => {
    log(`[auth:owner] rejected ${JSON.stringify({ reason, supabaseHost: host, ...extra })}`);
    return null;
  };

  return async function verifyOwner(bearerToken: string | null): Promise<{ id: string } | null> {
    if (!bearerToken) return reject('no_bearer_token');
    if (!supabaseUrl) return reject('supabase_url_unset');
    const res = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error_code?: string; msg?: string; message?: string };
      return reject('supabase_rejected', { status: res.status, errorCode: body.error_code, msg: body.msg ?? body.message });
    }
    const user = (await res.json()) as { id: string; app_metadata?: { role?: string } };
    if (user.app_metadata?.role !== 'owner') return reject('not_owner_role', { userId: user.id, role: user.app_metadata?.role ?? null });
    return { id: user.id };
  };
}
