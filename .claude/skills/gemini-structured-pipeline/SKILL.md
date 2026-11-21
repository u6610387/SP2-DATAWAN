---
name: gemini-structured-pipeline
description: Standard way to call Gemini Flash in Da Tawan Seafood — @google/genai with JSON Schema structured output from Zod, PII strip/restore, retries on 429/5xx, repair retry on invalid output, anti-hallucination code checks and safe fallbacks. Use when adding or changing any of the 4 AI tasks (ORDER_PARSE, OWNER_NOTE, SUPPLIER_BILL, PAYMENT_SLIP), their prompts, or packages/ai.
---

# Gemini Structured Pipeline

Contracts: `docs/API_AND_AI_CONTRACTS.md §5–6`. Every AI call in the repo uses this pipeline; calling the SDK elsewhere is a bug.

```
input ─► stripPII ─► assertNoPII ─► build request (schema, prompt vN) ─► Gemini
      ◄─ restorePII ◄─ code checks ◄─ Zod parse ◄─ JSON ◄───────────────┘
```

## 1. Files
```
packages/ai/src/
  client.ts          # GoogleGenAI instance, callGemini()
  schema.ts          # zod → JSON Schema helpers
  pii/strip.ts       # stripPII / restorePII / assertNoPII
  tasks/orderParse.ts  ownerNote.ts  supplierBill.ts  paymentSlip.ts
  prompts/*.v<N>.md
  checks/*.ts        # deterministic post-checks per task
```
Schemas live in `packages/shared/src/contracts/ai.ts` (shared with worker + web).

## 2. The call wrapper

```ts
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export async function callGemini<S extends z.ZodTypeAny>(opts: {
  task: AiTask;
  schema: S;
  promptVersion: string;
  system: string;                 // prompt file contents
  parts: Part[];                  // already PII-stripped text and/or inlineData images
  temperature?: number;
  apiKey?: string;                // GEMINI_SLIP_API_KEY for paid slip mode
}): Promise<AiResult<z.infer<S>>> {
  const started = Date.now();
  let attempts = 0;
  let repairNote: string | null = null;

  while (attempts < 3) {
    attempts++;
    try {
      const res = await ai.models.generateContent({
        model: env.GEMINI_MODEL,                       // never hardcode
        contents: [{ role: 'user', parts: repairNote ? [...opts.parts, { text: repairNote }] : opts.parts }],
        config: {
          systemInstruction: opts.system,
          temperature: opts.temperature ?? 0,
          responseMimeType: 'application/json',
          responseJsonSchema: z.toJSONSchema(opts.schema),
        },
      });
      const parsed = opts.schema.safeParse(JSON.parse(res.text ?? ''));
      if (parsed.success) return { ok: true, data: parsed.data, meta: meta() };
      repairNote = `Your previous JSON failed validation: ${parsed.error.message}. Return corrected JSON only.`;
      if (attempts >= 2) return { ok: false, error: 'INVALID_OUTPUT', meta: meta() };
    } catch (e) {
      const status = httpStatus(e);
      if (status === 429 || (status && status >= 500)) {
        if (attempts >= 3) return { ok: false, error: status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE', meta: meta() };
        await sleep(retryAfterMs(e) ?? [1000, 3000][attempts - 1] + Math.random() * 400);
        continue;
      }
      if (isSafetyBlock(e)) return { ok: false, error: 'BLOCKED', meta: meta() };
      throw e;
    }
  }
  return { ok: false, error: 'UNAVAILABLE', meta: meta() };

  function meta(): AiCallMeta {
    return { task: opts.task, model: env.GEMINI_MODEL, promptVersion: opts.promptVersion,
             latencyMs: Date.now() - started, attempts, piiTokens: 0 };
  }
}
```

Notes:
- If the installed `@google/genai` version does not accept `responseJsonSchema`, use `responseSchema` with the OpenAPI-subset converter in `schema.ts` (drop unsupported keywords like `$schema`, `additionalProperties`).
- Keep schemas flat and small; use `nullable()` rather than optional so the model always emits every key.
- Gemini on Workers: the SDK uses `fetch`; enable `nodejs_compat` in `wrangler.toml`. Images go as `inlineData` base64 (we compress to ≤ 300 KB first).

## 3. Task wrapper pattern

```ts
export async function parseOrder(input: OrderParseRawInput, ctx: PiiContext): Promise<AiResult<OrderParseResult>> {
  const { text, map } = stripPII(input.message, ctx);
  const { refs, catalog } = toCatalogRefs(input.catalog);   // UUID -> 'p0', 'p1'
  const payload = { message: text, catalog, previousDraft: input.previousDraft, previousOrder: mapRefs(input.previousOrder, refs), nowBangkok: input.nowBangkok };
  assertNoPII(payload, ctx);

  const res = await callGemini({
    task: 'ORDER_PARSE', schema: OrderParseResult, promptVersion: 'order_parse@v3',
    system: prompts.orderParse_v3, parts: [{ text: JSON.stringify(payload) }],
  });
  if (!res.ok) return res;

  const checked = checkOrderParse(res.data, { strippedMessage: text, catalog });  // §4
  return { ...res, data: restorePII(fromCatalogRefs(checked, refs), map) };
}
```

Rules:
- Send **refs** (`p0`, `item_0`) instead of DB UUIDs; map back in code.
- Prompts are versioned files; changing one = new version + benchmark re-run (`ai-eval-benchmark`).
- `temperature: 0` for extraction; `0.4` only for `OWNER_NOTE.message_th`.
- Never log `payload` or `res.data` in production; log `meta`.

## 4. Deterministic post-checks (code, not AI)

| Task | Checks |
|---|---|
| ORDER_PARSE | `product_ref` in sent catalog; unit allowed for product; qty range sane; each `raw_text` is a substring of the stripped message; downgrade failures into `missing_fields` |
| OWNER_NOTE | each `price_baht` appears literally in the owner note; `message_th` ≤ 500 chars and mentions each substitute price; politeness particle matches settings |
| SUPPLIER_BILL | `qty×unit_price≈line_total` (±1 ฿), `Σlines≈bill_total`, พ.ศ.→ค.ศ. (year > 2400 → −543), unmatched products → flags |
| PAYMENT_SLIP | `is_slip`; amount/time/receiver/reference rules from `PROJECT_SPEC.md §5`; reference uniqueness via DB unique index |

Checks may **flag or downgrade**, never approve anything (see `seafood-domain-rules`).

## 5. Fallbacks (never block the shop)
| Failure | Behaviour |
|---|---|
| ORDER_PARSE fails | Reply "รับออเดอร์แล้ว ร้านกำลังตรวจสอบค่ะ", order `needs_owner_review=true`, owner sees raw text |
| OWNER_NOTE fails | Owner gets "AI ไม่ว่าง" and types the message manually |
| SUPPLIER_BILL fails | Empty editable table pre-filled with nothing; owner types lines |
| PAYMENT_SLIP fails / `manual` mode | Badge `WARN – อ่านไม่ออก`; owner reads the image |

## 6. Free-tier hygiene
- Respect `GEMINI_RPM_LIMIT` / `GEMINI_RPD_LIMIT` (simple counter per minute/day in a Durable Object or Supabase row); when exhausted, go straight to fallback rather than hammering 429s.
- Slip images: honour `GEMINI_SLIP_MODE`; refuse to send slips with a `free` tier key.
- When `USE_MOCK_AI=true`, `createAi()` uses `packages/ai/src/mock/provider.ts` (deterministic, offline). The mock goes through the same strip → Zod → checks → restore pipeline, so swapping to Gemini changes nothing outside `packages/ai/src/gemini/provider.ts`.

## 7. Tests
- Unit: PII strip/restore round-trip, `assertNoPII` on tricky Thai inputs (phones with spaces, "คุณแดง", "ซ.เพชรเกษม 48").
- Contract: Zod parse of recorded real responses (`packages/ai/test/recorded/*.json`).
- Post-checks: table-driven cases for each rule above.
- Accuracy: via `ai-eval-benchmark`, not unit tests.
