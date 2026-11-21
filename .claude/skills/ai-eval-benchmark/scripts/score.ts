/**
 * score.ts — ground-truth scoring for Da Tawan Seafood AI tasks.
 *
 * Usage:
 *   npx tsx .claude/skills/ai-eval-benchmark/scripts/score.ts \
 *     --task order_parse \
 *     --samples eval/datasets/order_parse/samples.jsonl \
 *     --pred eval/results/<run>/predictions.jsonl \
 *     [--split test] [--out eval/results/<run>]
 *
 * samples.jsonl:     {"sample_id","split","ground_truth":{...}, ...}
 * predictions.jsonl: {"sample_id","prediction":{...}|null,"meta":{latencyMs,attempts,...}}
 *
 * Writes <out>/scores.json and <out>/report.md (metrics defined in docs/AI_EVALUATION.md §3).
 * No dependencies beyond Node 20.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Json = any;
type Cmp = 'exact' | 'str' | 'money' | 'time30' | 'time1' | 'set';

interface ListSpec { path: string; key: string; keyCmp: Cmp; fields: Record<string, Cmp> }
interface TaskSpec { scalars: Record<string, Cmp>; lists: ListSpec[] }

const TASKS: Record<string, TaskSpec> = {
  order_parse: {
    scalars: { intent: 'exact', 'delivery_time.iso': 'time30', missing_fields: 'set' },
    lists: [{ path: 'items', key: 'product_ref', keyCmp: 'exact', fields: { qty: 'exact', unit: 'exact', prep_type: 'exact' } }],
  },
  owner_note: {
    scalars: {},
    lists: [
      { path: 'substitutes', key: 'name_th', keyCmp: 'str', fields: { product_ref: 'exact', qty: 'exact', unit: 'exact', price_baht: 'money' } },
      { path: 'out_of_stock', key: 'item_ref', keyCmp: 'exact', fields: {} },
    ],
  },
  supplier_bill: {
    scalars: { is_bill: 'exact', supplier_name: 'str', bill_date: 'exact', bill_total: 'money' },
    lists: [{ path: 'lines', key: 'name', keyCmp: 'str', fields: { product_ref: 'exact', qty: 'exact', unit_price: 'money', line_total: 'money' } }],
  },
  payment_slip: {
    scalars: { is_slip: 'exact', bank: 'str', amount: 'money', date_time: 'time1', receiver_name_or_id: 'str', reference_no: 'str' },
    lists: [],
  },
};

// ---------------- helpers ----------------
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
function normStr(v: unknown): string {
  return String(v)
    .normalize('NFC')
    .replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
    .replace(/[\s\-_.,:;()'"\/]/g, '')
    .toLowerCase();
}
function get(obj: Json, path: string): Json {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function has(obj: Json, path: string): boolean {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts) {
    if (o == null || typeof o !== 'object' || !(p in o)) return false;
    o = o[p];
  }
  return true;
}
function isNull(v: unknown) { return v === null || v === undefined; }
function equal(a: unknown, b: unknown, cmp: Cmp): boolean {
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
  switch (cmp) {
    case 'exact': return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b;
    case 'str': return normStr(a) === normStr(b);
    case 'money': return Math.abs(Number(a) - Number(b)) <= 0.5;
    case 'time30': return Math.abs(Date.parse(String(a)) - Date.parse(String(b))) <= 30 * 60_000;
    case 'time1': return Math.abs(Date.parse(String(a)) - Date.parse(String(b))) <= 60_000;
    case 'set': {
      const sa = new Set((a as unknown[]).map(String)); const sb = new Set((b as unknown[]).map(String));
      return sa.size === sb.size && [...sa].every((x) => sb.has(x));
    }
  }
}

interface Counts { tp: number; fp: number; fn: number }
const counts = new Map<string, Counts>();
function bump(field: string, k: keyof Counts) {
  const c = counts.get(field) ?? { tp: 0, fp: 0, fn: 0 };
  c[k]++; counts.set(field, c);
}
/** Score one field value pair; returns true if no error. */
function scoreField(field: string, truth: unknown, pred: unknown, cmp: Cmp): boolean {
  if (cmp === 'set') {                                   // set fields: per-element P/R
    const t = new Set(((truth as unknown[]) ?? []).map(String));
    const p = new Set(((pred as unknown[]) ?? []).map(String));
    for (const x of p) bump(field, t.has(x) ? 'tp' : 'fp');
    for (const x of t) if (!p.has(x)) bump(field, 'fn');
    return equal(truth ?? [], pred ?? [], 'set');
  }
  if (isNull(truth) && isNull(pred)) return true;
  if (isNull(truth)) { bump(field, 'fp'); return false; }
  if (isNull(pred)) { bump(field, 'fn'); return false; }
  if (equal(truth, pred, cmp)) { bump(field, 'tp'); return true; }
  bump(field, 'fp'); bump(field, 'fn'); return false;
}

function scoreList(spec: ListSpec, truthList: Json[], predList: Json[]): { ok: boolean; edits: number; shown: number } {
  const remaining = [...(predList ?? [])];
  let ok = true; let edits = 0; let shown = 0;
  const fields = Object.entries(spec.fields);
  const keyField = `${spec.path}.${spec.key}`;
  for (const t of truthList ?? []) {
    const idx = remaining.findIndex((p) => equal(t[spec.key], p[spec.key], spec.keyCmp) && !isNull(t[spec.key]));
    shown += 1 + fields.length;
    if (idx === -1) {                                    // missed item
      ok = false; edits += 1 + fields.length;
      bump(keyField, 'fn');
      for (const [f] of fields) if (!isNull(t[f])) bump(`${spec.path}.${f}`, 'fn');
      continue;
    }
    const p = remaining.splice(idx, 1)[0];
    bump(keyField, 'tp');
    for (const [f, cmp] of fields) {
      if (!(f in t)) continue;                           // field not labeled
      if (!scoreField(`${spec.path}.${f}`, t[f], p[f], cmp)) { ok = false; edits++; }
    }
  }
  for (const p of remaining) {                           // extra predicted items
    ok = false; edits += 1; shown += 1;
    bump(keyField, 'fp');
    for (const [f] of fields) if (!isNull(p[f])) bump(`${spec.path}.${f}`, 'fp');
  }
  return { ok, edits, shown };
}

function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n; const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)];
}
function prf(c: Counts) {
  const p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0;
  const r = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0;
  return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, support: c.tp + c.fn };
}
function readJsonl(path: string): Json[] {
  return readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}
function percentile(xs: number[], q: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// ---------------- main ----------------
const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const task = args.task as string;
const spec = TASKS[task];
if (!spec || !args.samples || !args.pred) {
  console.error('usage: score.ts --task <order_parse|owner_note|supplier_bill|payment_slip> --samples <jsonl> --pred <jsonl> [--split test] [--out dir]');
  process.exit(1);
}
const split = args.split ?? 'test';
const samples = readJsonl(args.samples).filter((s) => split === 'all' || s.split === split);
const preds = new Map(readJsonl(args.pred).map((p) => [p.sample_id, p]));

let exact = 0; let edited = 0; let totalEdits = 0; let totalShown = 0; let failed = 0;
const errors: Json[] = [];
const latencies: number[] = [];

for (const s of samples) {
  const pr = preds.get(s.sample_id);
  const gt = s.ground_truth;
  const pred = pr?.prediction ?? null;
  if (pr?.meta?.latencyMs != null) latencies.push(pr.meta.latencyMs);
  if (pred === null) failed++;
  let ok = true; let edits = 0; let shown = 0;

  for (const [path, cmp] of Object.entries(spec.scalars)) {
    if (!has(gt, path)) continue;
    shown++;
    const t = get(gt, path); const p = pred ? get(pred, path) : null;
    if (!scoreField(path, t, p, cmp)) { ok = false; edits++; errors.push({ sample_id: s.sample_id, field: path, expected: t, predicted: p }); }
  }
  for (const ls of spec.lists) {
    if (!has(gt, ls.path)) continue;
    const r = scoreList(ls, get(gt, ls.path), pred ? get(pred, ls.path) : []);
    if (!r.ok) { ok = false; errors.push({ sample_id: s.sample_id, field: ls.path, expected: get(gt, ls.path), predicted: pred ? get(pred, ls.path) : null }); }
    edits += r.edits; shown += r.shown;
  }
  if (ok) exact++; else edited++;
  totalEdits += edits; totalShown += shown;
}

const n = samples.length;
const fieldMetrics = Object.fromEntries([...counts.entries()].sort().map(([f, c]) => [f, { ...prf(c), ...c }]));
const micro = prf([...counts.values()].reduce((a, c) => ({ tp: a.tp + c.tp, fp: a.fp + c.fp, fn: a.fn + c.fn }), { tp: 0, fp: 0, fn: 0 }));
const scores = {
  task, split, n,
  exact_match: n ? exact / n : 0,
  exact_match_ci95: wilson(exact, n),
  micro: micro,
  sample_her: n ? edited / n : 0,
  field_her: totalShown ? totalEdits / totalShown : 0,
  failed_calls: failed,
  latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  fields: fieldMetrics,
  missing_predictions: samples.filter((s) => !preds.has(s.sample_id)).map((s) => s.sample_id),
};

const report = [
  `# AI Benchmark — ${task} (${split})`,
  '',
  `| n | Exact Match | 95% CI | Micro F1 | Sample HER | Field HER | Failed calls | p50 / p95 ms |`,
  `|---|---|---|---|---|---|---|---|`,
  `| ${n} | ${pct(scores.exact_match)} | ${pct(scores.exact_match_ci95[0])}–${pct(scores.exact_match_ci95[1])} | ${micro.f1.toFixed(3)} | ${pct(scores.sample_her)} | ${pct(scores.field_her)} | ${failed} | ${scores.latency_ms.p50 ?? '-'} / ${scores.latency_ms.p95 ?? '-'} |`,
  '',
  '## Per-field',
  '',
  '| Field | Precision | Recall | F1 | Support |',
  '|---|---|---|---|---|',
  ...Object.entries(fieldMetrics).map(([f, m]: [string, Json]) => `| ${f} | ${m.precision.toFixed(3)} | ${m.recall.toFixed(3)} | ${m.f1.toFixed(3)} | ${m.support} |`),
  '',
  '## Errors (first 20) — categorize these by hand for the thesis',
  '',
  '| sample_id | field | expected | predicted | category | fix idea |',
  '|---|---|---|---|---|---|',
  ...errors.slice(0, 20).map((e) => `| ${e.sample_id} | ${e.field} | \`${JSON.stringify(e.expected)}\` | \`${JSON.stringify(e.predicted)}\` |  |  |`),
  '',
].join('\n');

if (args.out) {
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'scores.json'), JSON.stringify(scores, null, 2));
  writeFileSync(join(args.out, 'report.md'), report);
}
console.log(report);
