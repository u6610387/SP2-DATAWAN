---
name: ai-eval-benchmark
description: Run and report Da Tawan Seafood's ground-truth AI accuracy benchmark (Exact Match, field-level P/R/F1, Human Edit Rate, Wilson 95% CI, PII leak rate) for the 4 Gemini tasks on real shop chats, owner notes, supplier bills and slips. Use when labeling eval data, running a benchmark after a prompt/model change, or writing thesis/defence accuracy tables.
---

# AI Eval Benchmark

Methodology and metric definitions: `docs/AI_EVALUATION.md` (source of truth). This skill is the hands-on workflow.

## 1. Prepare data
1. Raw shop data → `eval/raw/` (git-ignored). Never commit raw chats or unredacted slips.
2. Anonymize: fake names/phones/addresses in text (keep the format), black-box payer name/account on slip copies.
3. Write one JSON line per sample into `eval/datasets/<task>/samples.jsonl` (see `samples.example.jsonl`):
   - `sample_id` (`op_`, `on_`, `sb_`, `ps_` + 3 digits), `split`, `tags`, `input`, `ground_truth`, `pii_spans`, `labeled_by`, `reviewed_by`.
   - `ground_truth` holds **only scored fields**. Omit a field to leave it unscored; use `null` to assert "should be null".
   - Images: `input.image` = relative path under `images/`.
4. Freeze the split once (70/30 by hash of `sample_id`): `split = (sha1(sample_id) % 10) < 3 ? 'test' : 'dev'`. Record the freeze date in `eval/datasets/README.md`.
5. Double-label; record inter-annotator agreement before adjudication.

## 2. Run predictions
Use the production code path (`packages/ai`, PII stripping on, `temperature 0`). Script template for `eval/scripts/run.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseOrder, readOwnerNote, readSupplierBill, readSlip } from '@datawan/ai';
import { assertNoPII } from '@datawan/ai/pii';

const [task, split = 'test', prompt = 'latest'] = process.argv.slice(2);
const runDir = `eval/results/${new Date().toISOString().slice(0, 10)}_${task}@${prompt}_${process.env.GEMINI_MODEL}`;
mkdirSync(runDir, { recursive: true });
const samples = readFileSync(`eval/datasets/${task}/samples.jsonl`, 'utf8').trim().split('\n').map(JSON.parse)
  .filter((s) => split === 'all' || s.split === split);
const fn = { order_parse: parseOrder, owner_note: readOwnerNote, supplier_bill: readSupplierBill, payment_slip: readSlip }[task]!;

const out: string[] = []; let leaks = 0;
for (const s of samples) {
  const res = await fn(s.input, { knownNames: s.input.known_names ?? [], productAliases: [], onPayload: (p) => {
    try { assertNoPII(p, { spans: s.pii_spans }); } catch { leaks++; }
  } });
  out.push(JSON.stringify({ sample_id: s.sample_id, prediction: res.ok ? res.data : null, meta: res.meta }));
  await new Promise((r) => setTimeout(r, Number(process.env.EVAL_DELAY_MS ?? 4000)));   // stay under free-tier RPM
}
writeFileSync(`${runDir}/predictions.jsonl`, out.join('\n') + '\n');
writeFileSync(`${runDir}/pii.json`, JSON.stringify({ payloads: samples.length, leaks, leak_rate: leaks / samples.length }));
console.log(runDir);
```
Run 3 times per configuration (`_r1`, `_r2`, `_r3` suffix) to report stability.

## 3. Score

```bash
npx tsx .claude/skills/ai-eval-benchmark/scripts/score.ts \
  --task order_parse \
  --samples eval/datasets/order_parse/samples.jsonl \
  --pred eval/results/<run>/predictions.jsonl \
  --split test --out eval/results/<run>
```
Outputs `scores.json` + `report.md`: Exact Match with Wilson 95% CI, micro and per-field P/R/F1, Sample HER, Field HER, failed calls, latency p50/p95, and an error table to categorize by hand.

Matching rules implemented by `score.ts`:
- Item lists are multisets matched on a key (`product_ref` for orders, normalized `name` for bill lines, `name_th` for substitutes, `item_ref` for out-of-stock).
- Wrong value → FP **and** FN; predicted value where truth is `null` → FP; `null` prediction where truth has a value → FN; extra item → FP; missed item → FN.
- Tolerances: money ±0.5 ฿; order delivery time ±30 min; slip time ±1 min; strings NFC + Thai digits → Arabic + punctuation/space stripped.
- `null` prediction (failed call) counts against every field.

## 4. Task-specific extras (compute alongside `score.ts`)
| Task | Extra metric | How |
|---|---|---|
| T1 | Missing-field recall | samples with non-empty truth `missing_fields`; per-element recall = `missing_fields` field recall in report |
| T1 | Regex baseline | run `eval/scripts/baseline_order.ts` (alias match + number regex) through the same scorer |
| T2 | Invented-price rate | count `price_baht` not literally in note **before** code checks (log raw output) |
| T2 | Owner rating | `eval/datasets/owner_note/ratings.csv`: `sample_id,as_is|minor|rewrite` |
| T3 | Math-flag recall | compare code `BillFlag[]` to labeled inconsistent lines; must be 100% |
| T4 | Negative rejection | `is_slip` field precision/recall on tagged `negative` samples |
| T1, T2 | PII leak rate | `pii.json` from the run; target 0 phones / 0 known names |

## 5. Report
1. Copy numbers into the summary table template in `docs/AI_EVALUATION.md §5.1` (mean of 3 runs, min–max in brackets, CI from the mean run).
2. Fill the top-5 error analysis with categories: slang · handwriting · layout · ambiguity · model error · labeling error.
3. Always state: model id, prompt versions, n, split freeze date, run dates.
4. Wording: "AI-assisted, human-confirmed". With n ≈ 30, don't claim differences smaller than the CI.

## 6. When to re-run
- Prompt version bump → that task (dev during iteration, test once at the end).
- `GEMINI_MODEL` change → all four tasks.
- PII stripper change → T1, T2 leak test.
- Final numbers for the Exhibition: test split, 3 runs, by 12 Feb 2027.
