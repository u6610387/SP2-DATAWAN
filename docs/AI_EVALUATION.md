# AI_EVALUATION.md — Accuracy Benchmark for the 4 Gemini Tasks

Owner: Thanakrit Kodklangdon · Used in: SP2 thesis chapter "Evaluation", Exhibition poster, Final Defence slides.

**Question we answer:** *How often is each AI task right, and how much does the owner still have to fix?*
Because the system is human-in-the-loop, the headline number is not only accuracy but **Human Edit Rate**: how much work is left for the owner after AI.

---

## 1. Tasks Under Test

| Task | Input | Output | Unit of evaluation |
|---|---|---|---|
| T1 ORDER_PARSE | Customer chat text (+ catalog, + previous order) | `OrderParseResult` | one message |
| T2 OWNER_NOTE | Owner shorthand note (+ order items) | `OwnerNoteResult` | one note |
| T3 SUPPLIER_BILL | Bill photo | `SupplierBillResult` | one bill (fields per line) |
| T4 PAYMENT_SLIP | Slip photo | `SlipReadResult` | one slip |

## 2. Dataset

### 2.1 Size & sourcing
- **Target 30 samples per task (minimum 20)**, from the real shop, collected Dec 2026 – Jan 2027 with the owner's written permission.
- T1: real LINE chats, stratified: ≥ 8 B2B, ≥ 5 reorders, ≥ 5 with missing info, ≥ 3 not-an-order, ≥ 5 with slang/typos ("โล", "ตัวละ", "กก", "ครึ่งโล").
- T2: real owner notes; if too few, the owner writes notes for real past situations.
- T3: ≥ 10 handwritten, ≥ 10 printed bills; include blurry/angled photos as they really get taken.
- T4: ≥ 4 different banks (KBANK, SCB, BBL, KTB, Krungsri, TTB, PromptPay e-wallet); include ≥ 3 non-slip images (negative cases).
- **Hold-out rule:** split 70/30 (dev/test) once, by `sample_id` hash. Tune prompts on dev only; report test numbers. Never edit prompts after looking at test errors without re-splitting and saying so in the thesis.

### 2.2 Anonymization (before anything is committed)
- Replace real names/phones/addresses in chat text with realistic fakes (keep the *format*, so PII stripping is still tested).
- Slip images: black-box the payer name and account **in the stored copy**; keep the original only on the owner-approved team drive, deleted after defence.
- `eval/datasets/` is committed **only** with anonymized samples. Raw data goes in `eval/raw/` (git-ignored).

### 2.3 Folder layout

```
eval/
├── datasets/
│   ├── order_parse/
│   │   ├── samples.jsonl          # one JSON per line: input + ground truth
│   │   └── catalog.json           # catalog snapshot used for this dataset
│   ├── owner_note/samples.jsonl
│   ├── supplier_bill/
│   │   ├── samples.jsonl
│   │   └── images/bill_001.jpg
│   └── payment_slip/
│       ├── samples.jsonl
│       └── images/slip_001.jpg
├── scripts/                        # run + score (see .claude/skills/ai-eval-benchmark)
└── results/
    └── 2027-01-20_order_parse@v3_gemini-flash/
        ├── predictions.jsonl
        ├── scores.json
        └── report.md
```

### 2.4 Sample format (`samples.jsonl`)

```json
{"sample_id":"op_017","split":"test","tags":["b2b","slang"],
 "input":{"message":"พรุ่งนี้ 6 โมง เอากุ้งขาวไซส์ 40 สามโล หมึกกล้วยโลนึงครับ โทร 081-234-5678","previous_order":null,"now_bangkok":"2027-01-10T15:00:00+07:00"},
 "ground_truth":{"intent":"new_order",
   "items":[{"product_ref":"p2","qty":3,"unit":"kg","prep_type":"any"},{"product_ref":"p7","qty":1,"unit":"kg","prep_type":"any"}],
   "delivery_time":{"iso":"2027-01-11T06:00:00+07:00"},
   "missing_fields":[]},
 "labeled_by":"thanakrit","reviewed_by":"kitirat"}
```
Ground truth contains **only fields we score** (no `raw_text`, no Thai message wording).

### 2.5 Labeling protocol
1. Two members label each sample independently using `eval/LABELING_GUIDE.md` (unit rules: "โล" = kg, "ตัว" = piece, unknown product = `null`).
2. Disagreements → third member decides; record **inter-annotator agreement** (% of fields agreeing before adjudication). Report it, it bounds how good the AI can look.
3. Owner spot-checks 10 samples per task for domain correctness (product mapping, prices).

---

## 3. Metrics

### 3.1 Exact Match (EM), per sample
A sample is EM-correct if every scored field equals ground truth after normalization.
- Item lists compared as **multisets** (order doesn't matter), matched on `product_ref`.
- Numbers: qty exact; money within ±0.5 baht; datetimes within ±30 min (T1) or ±1 min (T4).
- Strings (supplier names, receiver): NFC normalize, trim, remove spaces/punctuation, Thai digits → Arabic.

`EM = correct_samples / total_samples`

### 3.2 Field-level Precision / Recall / F1
For each field (e.g. `items.qty`, `slip.amount`):
- TP: predicted non-null and correct · FP: predicted non-null and wrong (or extra item) · FN: ground truth non-null but predicted null/wrong/missing item.
- `P = TP/(TP+FP)`, `R = TP/(TP+FN)`, `F1 = 2PR/(P+R)`.
- Report per field and micro-averaged per task.
- For T1/T3 item lists: an extra predicted item = FP for all its fields; a missed item = FN for all its fields.

### 3.3 Human Edit Rate (HER)
Measures owner/customer effort left after AI.
- **Field HER** = fields the human had to change ÷ total fields shown. Measured on the test set by simulation (diff prediction vs truth) **and** in the pilot from real `order_events` (AI draft vs final saved value).
- **Sample HER** = % of samples needing ≥ 1 edit.
- T2 only: owner rates each `message_th` *send as-is / minor edit / rewrite* → report the three percentages.

### 3.4 Task-specific safety metrics
| Metric | Task | Definition | Target |
|---|---|---|---|
| Missing-field recall | T1 | of samples that truly lack info, % where AI flagged it in `missing_fields` | ≥ 90% |
| Invented price rate | T2 | % of outputs with a price not in the note (before code check) | report; code check must catch 100% |
| Math-flag recall | T3 | % of truly inconsistent lines flagged by code (`LINE_MATH`) | 100% (deterministic) |
| Fake/negative slip rejection | T4 | % of non-slips with `is_slip=false` + % of altered slips ending FAIL/WARN | report |
| Amount accuracy | T4 | `amount` exact match | ≥ 95% |

### 3.5 PII leak rate (applies to T1, T2)
Run `assertNoPII` on every payload that *would* be sent. `leak_rate = payloads with ≥ 1 PII span / total payloads`. Ground truth PII spans are labeled in the dataset (`pii_spans` field). **Target: 0 phone numbers, 0 known names.** Report addresses separately (heuristic).

### 3.6 Operational metrics (log, don't optimize)
p50/p95 latency, retry count, `INVALID_OUTPUT` rate, model name, prompt version, free-tier 429 count.

### 3.7 Uncertainty
With n = 20–30, a single error moves accuracy by 3–5 points. Report **95% Wilson confidence intervals** for EM and key field accuracies, and avoid claiming differences smaller than the interval.

---

## 4. Running the Benchmark

```bash
pnpm eval:run   --task order_parse --split test --prompt v3
pnpm eval:score --run eval/results/<run_dir>
pnpm eval:report --run eval/results/<run_dir>   # writes report.md
```
- Uses the same `packages/ai` code path as production (incl. PII stripping), with `temperature 0`.
- Run each configuration **3 times**; report mean ± min/max to show output stability.
- Pin `GEMINI_MODEL` in the run folder name. If the model changes (risk D6), re-run all tasks.
- Baselines for the thesis: (a) **regex/keyword baseline** for T1 (catalog alias match + number regex), (b) **no-AI manual time** from owner (seconds per order/bill/slip, stopwatch, 10 samples).

---

## 5. Reporting Templates

### 5.1 Summary table (thesis + defence slide)

| Task | n (test) | Exact Match (95% CI) | Micro F1 | Sample HER | Key safety metric |
|---|---|---|---|---|---|
| T1 Order parse | | | | | Missing-field recall: |
| T2 Owner note | | – | Substitute F1: | As-is / minor / rewrite: | Invented prices caught: |
| T3 Supplier bill | | | Line F1: | | Math-flag recall: |
| T4 Payment slip | | | | | Amount accuracy: |

Model: `____` · Prompt versions: `____` · Date: `____` · Runs: 3

### 5.2 Per-field table (one per task)

| Field | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| items.product_ref | | | | |
| items.qty | | | | |
| items.unit | | | | |
| items.prep_type | | | | |
| delivery_time.iso | | | | |

### 5.3 Error analysis (top 5 per task)

| # | sample_id | Field | Expected | Predicted | Category | Fix idea |
|---|---|---|---|---|---|---|
| 1 | | | | | slang / handwriting / layout / ambiguity / model error | |

Categories feed the thesis discussion: what the prompt can fix vs what needs human review by design.

### 5.4 Pilot (real-shop) table

| Metric | Week 1 | Week 2 | Week 3 |
|---|---|---|---|
| Orders through system | | | |
| Field HER (T1) from audit log | | | |
| Slips: PASS / WARN / FAIL | | | |
| Owner seconds per order (vs baseline) | | | |
| LINE pushes used / orders | | | |

### 5.5 Thesis wording guidance
- Say "AI-assisted, human-confirmed". Do not write "AI verifies payments".
- Present HER alongside accuracy: a 90% EM task still means the owner edits 1 in 10.
- State dataset size and CI honestly; n=30 is a pilot-scale evaluation.

---

## 6. Schedule

| When | Milestone |
|---|---|
| By 18 Dec 2026 | Labeling guide + 10 samples/task labeled (dev) |
| By 15 Jan 2027 | 30 samples/task, split frozen, baseline run |
| 15 Jan – 5 Feb 2027 | Prompt iteration on dev; pilot HER logging |
| 12 Feb 2027 | Final test-set run (3×), report generated → Exhibition poster |
| 5 Mar 2027 | Thesis evaluation chapter final; defence slides |
