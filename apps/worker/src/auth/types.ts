/**
 * Auth verification, injected via Deps so routes never call Supabase/LINE directly and tests
 * can supply a deterministic fake (same pattern as line/api.ts's LineApi).
 */
export interface AuthVerifier {
  /** Supabase access token → the owner's auth.users id, or null if missing/invalid/not-owner. */
  verifyOwner(bearerToken: string | null): Promise<{ id: string } | null>;
  /**
   * LIFF ID token → the LINE user id ('sub'). `devUserHeader` (x-liff-dev-user) is honoured only
   * by the dev-bypass verifier (apps/worker/src/auth/liff.ts), which itself only activates when
   * APP_ENV === 'dev' — never in exhibition/defence/production regardless of other config.
   */
  verifyLiffUser(idToken: string | null, devUserHeader: string | null): Promise<{ lineUserId: string } | null>;
}
