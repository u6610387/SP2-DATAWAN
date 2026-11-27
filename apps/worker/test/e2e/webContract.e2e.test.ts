/**
 * Payload contract between apps/web and apps/worker, read from the web's real source code:
 *   1. every `/api/...` call the web makes (method + path) is served by a worker route
 *      (catches "documented and called but never implemented", like the owner cancel bug);
 *   2. every literal `body: { ... }` the web sends uses exactly the keys of the shared Zod
 *      request schema the worker validates with: no unknown keys, no missing required keys;
 *   3. every POST that changes an order sends `ifMatch: order.version`;
 *   4. each B2B account function in apps/web/src/lib/api.ts, called once against the worker, gets
 *      a response that parses as its view type (no missing or unknown keys).
 * Run as part of the e2e-system-test skill.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as Contracts from '@datawan/shared';
import type { CustomerAccountView, OwnerB2bDetailView, OwnerB2bSummaryView } from '@datawan/shared';
import { z, type ZodObject, type ZodType } from 'zod';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { makeHarness, LIFF_TOKEN, OWNER_TOKEN } from '../harness';

const WEB_SRC = join(__dirname, '../../../web/src');

interface WebCall {
  file: string;
  line: number;
  client: 'ownerFetch' | 'liffFetch' | 'apiFetch';
  method: string;
  /** path with every `${...}` replaced by `:param` */
  route: string;
  bodyKeys: string[] | null; // null = no body, or not a literal object
  hasIfMatch: boolean;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'mocks' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

/** Text from `open` to its matching closer, tracking (), {}, [] and skipping strings. */
function balanced(src: string, start: number): string {
  const open = src[start]!;
  const close = ({ '(': ')', '{': '}', '[': ']' } as Record<string, string>)[open]!;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (depth === 0) return src.slice(start, i + 1);
    void close;
  }
  throw new Error('unbalanced');
}

/** Top-level keys of an object literal like `{ a, b: f(x, y), c }`. */
function topLevelKeys(obj: string): string[] {
  const inner = obj.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner + ',') {
    if ('({['.includes(ch)) depth++;
    if (')}]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      const t = cur.trim();
      if (t) keys.push(/^([A-Za-z_$][\w$]*)/.exec(t)![1]!);
      cur = '';
    } else cur += ch;
  }
  return keys;
}

function findWebCalls(): WebCall[] {
  const calls: WebCall[] = [];
  for (const file of walk(WEB_SRC)) {
    const src = readFileSync(file, 'utf8');
    const re = /\b(ownerFetch|liffFetch|apiFetch)\s*(?:<[^>(]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const args = balanced(src, m.index + m[0].length - 1);
      const pathM = /^\(\s*(['`])(\/api\/[^'`]*)\1/.exec(args);
      if (!pathM) continue; // the function definitions themselves
      const route = pathM[2]!.replace(/\$\{[^}]*\}/g, ':param');
      const methodM = /method:\s*'([A-Z]+)'/.exec(args);
      const bodyIdx = args.search(/\bbody:\s*\{/);
      const bodyKeys = bodyIdx >= 0 ? topLevelKeys(balanced(args, args.indexOf('{', bodyIdx))) : null;
      calls.push({
        file: relative(WEB_SRC, file),
        line: src.slice(0, m.index).split('\n').length,
        client: m[1] as WebCall['client'],
        method: methodM?.[1] ?? 'GET',
        route,
        bodyKeys,
        hasIfMatch: /\bifMatch:\s*order\.version\b/.test(args),
      });
    }
  }
  return calls;
}

/** Shared Zod schema the worker validates each body with (apps/worker/src/routes/*.ts). */
const BODY_SCHEMA: Record<string, keyof typeof Contracts> = {
  'POST /api/owner/orders/:param/price': 'SetPriceRequest',
  'POST /api/owner/orders/:param/negotiation': 'NegotiationRequest',
  'POST /api/owner/orders/:param/shipping': 'ShippingRequest',
  'POST /api/owner/payments/:param/confirm': 'ConfirmPaymentRequest',
  'POST /api/owner/payments/:param/reject': 'RejectSlipRequest',
  'POST /api/owner/payments/:param/qr': 'SlipQrRequest',
  'POST /api/owner/orders/:param/dispatch': 'DispatchRequest',
  'POST /api/owner/orders/:param/delivered': 'DeliveredRequest',
  'POST /api/owner/orders/:param/cancel': 'CancelOrderRequest',
  'POST /api/owner/stock': 'StockAdjustRequest',
  'POST /api/owner/categories': 'CategoryCreateRequest',
  'POST /api/owner/products': 'ProductCreateRequest',
  'PATCH /api/owner/products/:param': 'ProductUpdateRequest',
  'POST /api/owner/push-subscriptions': 'PushSubscriptionRequest',
  'POST /api/liff/orders/:param/counter': 'CounterOfferRequest',
  'POST /api/liff/orders/:param/recipient': 'RecipientContactRequest',
  'POST /api/liff/orders/:param/slip-upload-url': 'SlipUploadUrlRequest',
  'POST /api/liff/orders/:param/slip': 'SlipSubmitRequest',
  'POST /api/liff/account/b2b/doc-upload-url': 'B2bDocUploadUrlRequest',
  'POST /api/owner/customers/:param/approve': 'OwnerB2bDecisionRequest',
  'POST /api/owner/customers/:param/acknowledge': 'OwnerB2bDecisionRequest',
  'POST /api/owner/customers/:param/reject': 'OwnerB2bReasonRequest',
  'POST /api/owner/customers/:param/revoke': 'OwnerB2bReasonRequest',
};

/** Order-changing calls that must carry `ifMatch: order.version`. */
const NEEDS_IF_MATCH = new Set([
  'POST /api/owner/orders/:param/price',
  'POST /api/owner/orders/:param/negotiation',
  'POST /api/owner/orders/:param/shipping',
  'POST /api/owner/payments/:param/confirm',
  'POST /api/owner/payments/:param/reject',
  'POST /api/owner/orders/:param/dispatch',
  'POST /api/owner/orders/:param/delivered',
  'POST /api/owner/orders/:param/cancel',
  'POST /api/liff/orders/:param/accept',
  'POST /api/liff/orders/:param/counter',
  'POST /api/liff/orders/:param/recipient',
]);

const calls = findWebCalls();
const key = (c: WebCall) => `${c.method} ${c.route}`;

describe('web ↔ worker payload contract (from apps/web source)', () => {
  it('finds the web API calls', () => {
    expect(calls.length).toBeGreaterThanOrEqual(20);
  });

  it.each(calls.map((c) => [key(c), c] as const))('%s is served by a worker route', async (_k, c) => {
    const h = makeHarness();
    const app = createApp(h.deps);
    const path = c.route.replace(/:param/g, '00000000-0000-4000-8000-000000000000');
    const auth = c.client === 'liffFetch' ? LIFF_TOKEN : OWNER_TOKEN;
    const res = await app.request(path, {
      method: c.method,
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      ...(c.method !== 'GET' ? { body: '{}' } : {}),
    });
    // An unmatched Hono route answers the plain-text default 404; real handlers answer JSON
    // (including JSON NOT_FOUND for the placeholder id) or 204.
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    expect(res.status === 204 || isJson, `${c.file}:${c.line} ${key(c)} → ${res.status} (no worker route)`).toBe(true);
  });

  it.each(calls.filter((c) => c.bodyKeys).map((c) => [key(c), c] as const))('%s body keys match the shared Zod schema', (_k, c) => {
    const name = BODY_SCHEMA[key(c)];
    expect(name, `${c.file}:${c.line}: add ${key(c)} to BODY_SCHEMA`).toBeDefined();
    const schema = Contracts[name!] as unknown as ZodObject<Record<string, ZodType>>;
    const shape = schema.shape;
    const unknownKeys = c.bodyKeys!.filter((k) => !(k in shape));
    const required = Object.keys(shape).filter((k) => !shape[k]!.safeParse(undefined).success);
    const missing = required.filter((k) => !c.bodyKeys!.includes(k));
    expect({ unknownKeys, missing }, `${c.file}:${c.line} ${key(c)} vs ${name}`).toEqual({ unknownKeys: [], missing: [] });
  });

  it.each(calls.filter((c) => NEEDS_IF_MATCH.has(key(c))).map((c) => [key(c), c] as const))('%s sends ifMatch: order.version', (_k, c) => {
    expect(c.hasIfMatch, `${c.file}:${c.line}`).toBe(true);
  });
});

// ---- 4. B2B account functions: real web client → real worker routes → response shape ----
// Strict runtime mirrors of the shared view interfaces; `satisfies` keeps them in step with the types.
const B2B_STATUS = z.enum(['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED']);
const BUSINESS_TYPE = z.enum(['restaurant', 'reseller', 'hotel', 'other']);
const CustomerAccountViewSchema = z.strictObject({
  type: z.enum(['B2C', 'B2B']),
  b2b: z.strictObject({
    status: B2B_STATUS, businessName: z.string(), businessType: BUSINESS_TYPE, addressText: z.string(),
    lat: z.number().nullable(), lng: z.number().nullable(), deliveryWindow: z.string().nullable(), taxId: z.string().nullable(),
    rejectionReason: z.string().nullable(), needsRereview: z.boolean(), documents: z.array(z.strictObject({ id: z.string() })),
  }).nullable(),
}) satisfies ZodType<CustomerAccountView>;
const summaryShape = {
  userId: z.string(), customerName: z.string().nullable(), businessName: z.string(), businessType: BUSINESS_TYPE,
  status: B2B_STATUS, needsRereview: z.boolean(), submittedAt: z.string(),
};
const OwnerB2bSummaryViewSchema = z.strictObject(summaryShape) satisfies ZodType<OwnerB2bSummaryView>;
const OwnerB2bDetailViewSchema = z.strictObject({
  ...summaryShape,
  phone: z.string().nullable(), addressText: z.string(), lat: z.number().nullable(), lng: z.number().nullable(),
  mapUrl: z.string().nullable(), deliveryWindow: z.string().nullable(), taxId: z.string().nullable(),
  taxIdValid: z.boolean().nullable(), rereviewFields: z.array(z.string()), rejectionReason: z.string().nullable(),
  decidedAt: z.string().nullable(), verifiedAt: z.string().nullable(), updatedAt: z.string(),
  documents: z.array(z.strictObject({ id: z.string(), url: z.string() })),
}) satisfies ZodType<OwnerB2bDetailView>;
const UploadUrlSchema = z.strictObject({ uploadUrl: z.string(), path: z.string() });

describe('web B2B api.ts functions against the worker (response parses as its view type)', () => {
  const API = 'http://worker.contract';
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('getAccount, getB2bDocUploadUrl, applyB2b, list/get/approve/acknowledge/revoke/reject B2bCustomer', async () => {
    const h = makeHarness();
    const app = createApp(h.deps);
    const called: string[] = [];
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', API);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (!req.url.startsWith(API)) throw new Error(`unexpected network call ${req.url}`);
      const u = new URL(req.url);
      const res = await app.request(u.pathname + u.search, { method: req.method, headers: req.headers, body: init?.body });
      // Hono's default 404 for an unmatched route is plain text; handlers answer JSON.
      if (res.status === 404 && !(res.headers.get('content-type') ?? '').includes('application/json')) {
        throw new Error(`no worker route for ${req.method} ${u.pathname}`);
      }
      called.push(`${req.method} ${u.pathname}`);
      return res;
    });
    const web = await import('../../../web/src/lib/api');
    const liff = { idToken: LIFF_TOKEN, devUser: null };
    const userId = 'u-customer'; // the harness's LIFF_TOKEN user
    const body = (businessName: string, documentPaths: string[]) => ({
      businessName, businessType: 'restaurant' as const, addressText: '1 ถนนทดสอบสัญญา', lat: null, lng: null,
      deliveryWindow: null, taxId: '0105536000313', documentPaths, pdpaConsent: true as const,
    });

    CustomerAccountViewSchema.parse(await web.getAccount(liff));
    const upload = UploadUrlSchema.parse(await web.getB2bDocUploadUrl(liff, 'image/png'));
    CustomerAccountViewSchema.parse(await web.applyB2b(liff, body('ร้านทดสอบสัญญา', [upload.path])));
    const list = z.array(OwnerB2bSummaryViewSchema).parse(await web.listB2bCustomers(OWNER_TOKEN, 'pending'));
    expect(list.map((x) => x.userId)).toEqual([userId]);
    const seen = OwnerB2bDetailViewSchema.parse(await web.getB2bCustomer(OWNER_TOKEN, userId));
    const approved = OwnerB2bDetailViewSchema.parse(await web.approveB2bCustomer(OWNER_TOKEN, userId, seen.updatedAt));
    expect(approved.status).toBe('VERIFIED');
    // Each later decision sends the updatedAt the owner's (re-fetched) detail view would show.
    const stamp = async () => (await h.repo.getBusinessProfile(userId))!.updated_at;
    await web.applyB2b(liff, body('ร้านทดสอบสัญญา ใหม่', [upload.path])); // rename → needs re-review
    OwnerB2bDetailViewSchema.parse(await web.acknowledgeB2bCustomer(OWNER_TOKEN, userId, await stamp()));
    OwnerB2bDetailViewSchema.parse(await web.revokeB2bCustomer(OWNER_TOKEN, userId, 'ทดสอบ', await stamp()));
    await web.applyB2b(liff, body('ร้านทดสอบสัญญา', [])); // re-apply after the revoke → pending again
    expect(OwnerB2bDetailViewSchema.parse(await web.rejectB2bCustomer(OWNER_TOKEN, userId, 'ทดสอบ', await stamp())).status).toBe('REJECTED');

    expect(called).toEqual([
      'GET /api/liff/account',
      'POST /api/liff/account/b2b/doc-upload-url',
      'POST /api/liff/account/b2b',
      'GET /api/owner/customers',
      `GET /api/owner/customers/${userId}`,
      `POST /api/owner/customers/${userId}/approve`,
      'POST /api/liff/account/b2b',
      `POST /api/owner/customers/${userId}/acknowledge`,
      `POST /api/owner/customers/${userId}/revoke`,
      'POST /api/liff/account/b2b',
      `POST /api/owner/customers/${userId}/reject`,
    ]);
  });
});
