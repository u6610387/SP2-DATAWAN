/**
 * Payload contract between apps/web and apps/worker, read from the web's real source code:
 *   1. every `/api/...` call the web makes (method + path) is served by a worker route
 *      (catches "documented and called but never implemented", like the owner cancel bug);
 *   2. every literal `body: { ... }` the web sends uses exactly the keys of the shared Zod
 *      request schema the worker validates with: no unknown keys, no missing required keys;
 *   3. every POST that changes an order sends `ifMatch: order.version`.
 * Run as part of the e2e-system-test skill.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as Contracts from '@datawan/shared';
import type { ZodObject, ZodType } from 'zod';
import { describe, expect, it } from 'vitest';
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
  'POST /api/owner/push-subscriptions': 'PushSubscriptionRequest',
  'POST /api/liff/orders/:param/counter': 'CounterOfferRequest',
  'POST /api/liff/orders/:param/recipient': 'RecipientContactRequest',
  'POST /api/liff/orders/:param/slip-upload-url': 'SlipUploadUrlRequest',
  'POST /api/liff/orders/:param/slip': 'SlipSubmitRequest',
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
