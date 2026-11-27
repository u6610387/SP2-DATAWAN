/**
 * Typed fetch wrapper for the Worker REST API (docs/API_AND_AI_CONTRACTS.md §1–2).
 * When NEXT_PUBLIC_USE_MOCKS=true, requests are served from src/mocks instead of the network —
 * lets the dashboard/LIFF UI be exercised in Chrome with no Worker/Supabase/LINE running.
 */
import type { ApiError, B2bApplyRequest, CustomerAccountView } from '@datawan/shared';

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8787';
const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === 'true';

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  /** `If-Match: <order.version>` — mismatches return 409 VERSION_CONFLICT. */
  ifMatch?: number;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (USE_MOCKS) {
    const { mockFetch } = await import('../mocks/handlers');
    return mockFetch<T>(path, opts);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (opts.ifMatch !== undefined) headers['If-Match'] = String(opts.ifMatch);
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data as ApiError | null;
    throw new ApiRequestError(res.status, err?.error.code ?? 'INTERNAL', err?.error.message ?? res.statusText);
  }
  return data as T;
}

/** Owner dashboard calls — Authorization: Bearer <Supabase access token>. */
export function ownerFetch<T>(path: string, token: string, opts: RequestOptions = {}): Promise<T> {
  return apiFetch<T>(path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });
}

/** LIFF calls — Authorization: Bearer <LIFF ID token>, or x-liff-dev-user in dev-bypass mode. */
export function liffFetch<T>(path: string, auth: { idToken?: string | null; devUser?: string | null }, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  if (auth.idToken) headers.Authorization = `Bearer ${auth.idToken}`;
  if (auth.devUser) headers['x-liff-dev-user'] = auth.devUser;
  return apiFetch<T>(path, { ...opts, headers });
}

// ---- LIFF B2B account (docs/API_AND_AI_CONTRACTS.md §2.3a) ----
type LiffAuth = { idToken?: string | null; devUser?: string | null };

export function getAccount(auth: LiffAuth): Promise<CustomerAccountView> {
  return liffFetch<CustomerAccountView>('/api/liff/account', auth);
}

export function getB2bDocUploadUrl(auth: LiffAuth, contentType: 'image/jpeg' | 'image/png' | 'image/webp'): Promise<{ uploadUrl: string; path: string }> {
  return liffFetch<{ uploadUrl: string; path: string }>('/api/liff/account/b2b/doc-upload-url', auth, { method: 'POST', body: { contentType } });
}

export function applyB2b(auth: LiffAuth, body: B2bApplyRequest): Promise<CustomerAccountView> {
  return liffFetch<CustomerAccountView>('/api/liff/account/b2b', auth, { method: 'POST', body });
}
