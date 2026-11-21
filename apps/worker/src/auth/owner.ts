/**
 * Owner dashboard auth: verify the Supabase access token and require app_metadata.role==='owner'
 * (API_AND_AI_CONTRACTS.md §1). Raw fetch against Auth's /user endpoint — no supabase-js client
 * needed for this, consistent with the other REST-backed services (storage.ts, realtime.ts).
 */
export function createSupabaseOwnerVerifier(supabaseUrl: string, anonKey: string, fetchImpl: typeof fetch = fetch) {
  return async function verifyOwner(bearerToken: string | null): Promise<{ id: string } | null> {
    if (!bearerToken || !supabaseUrl) return null;
    const res = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { id: string; app_metadata?: { role?: string } };
    return user.app_metadata?.role === 'owner' ? { id: user.id } : null;
  };
}
