/** Enforces CLAUDE.md §3 code rules mechanically, so a PR can't silently break them. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'test') return [];
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const src = [...files(join(ROOT, 'apps')), ...files(join(ROOT, 'packages'))].map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

describe('repo rules', () => {
  it('§3.4 only line/quota.ts sends LINE pushes', () => {
    const offenders = src.filter((f) => /unsafePush\(|pushMessage\(|\/v2\/bot\/message\/push/.test(f.text)).map((f) => f.path);
    expect(offenders.sort()).toEqual(['apps/worker/src/line/api.ts', 'apps/worker/src/line/quota.ts']);
  });
  it('§3.3 Gemini SDK is only used inside packages/ai/src/gemini', () => {
    const offenders = src.filter((f) => /@google\/genai|generativelanguage\.googleapis/.test(f.text) && !f.path.startsWith('packages/ai/src/gemini/')).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
  it('§4 order status only changes via applyEvent()', () => {
    const offenders = src
      .filter((f) => !f.path.endsWith('services/orders.ts') && !f.path.includes('repo.'))
      .filter((f) => /updateOrder\([^)]*\{[^}]*\bstatus\s*:/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
  it('§3.1 paid_confirmed_by is only written by ownerConfirmPayment(), from an ownerId parameter', () => {
    // The single write site takes `ownerId` as a parameter — it is never a literal, and never
    // read from deps.cfg directly there, so it can't silently become an AI/system value.
    const sets = src.filter((f) => !f.path.endsWith('db.ts') && !f.path.includes('repo.')).flatMap((f) => [...f.text.matchAll(/paid_confirmed_by:\s*([^,\n}]+)/g)].map((m) => `${f.path}: ${m[1]!.trim()}`));
    expect(sets).toEqual(['apps/worker/src/services/orderActions.ts: ownerId']);

    // Every caller of ownerConfirmPayment must supply an owner-authenticated id: the LINE
    // command's configured owner (handlers/owner.ts), or the REST route's verified Supabase
    // user (routes/owner.ts) — never a literal, never anything from packages/ai.
    const callers = src.flatMap((f) => [...f.text.matchAll(/ownerConfirmPayment\(deps,\s*order,\s*([^,]+),/g)].map((m) => `${f.path}: ${m[1]!.trim()}`));
    for (const c of callers) {
      expect(c.startsWith('apps/worker/src/handlers/owner.ts:') || c.startsWith('apps/worker/src/routes/owner.ts:')).toBe(true);
    }
    expect(callers.length).toBeGreaterThan(0);
  });
});
