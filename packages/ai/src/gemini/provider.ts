/**
 * Gemini provider — TODO(Thanakrit). Implement following
 * .claude/skills/gemini-structured-pipeline/SKILL.md §2:
 *   - @google/genai, model from GEMINI_MODEL (never hardcode)
 *   - responseMimeType 'application/json' + responseJsonSchema: z.toJSONSchema(<Schema>)
 *   - temperature 0 (0.4 for OWNER_NOTE), retries on 429/5xx, 1 repair retry on invalid JSON
 *   - PAYMENT_SLIP: ignore input.mockOnly; use slipApiKey when GEMINI_SLIP_MODE=paid
 *
 * Inputs arrive already PII-stripped with catalog refs; return raw JSON — the service
 * validates with Zod and runs code checks, so nothing else in the system changes.
 */
import type { AiProvider, ProviderResult } from '../types';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  slipApiKey?: string;
}

export function createGeminiProvider(cfg: GeminiConfig): AiProvider {
  const notYet = async (): Promise<ProviderResult> => ({ ok: false, error: 'UNAVAILABLE', model: cfg.model, attempts: 0 });
  return {
    name: 'gemini',
    orderParse: notYet,
    ownerNote: notYet,
    supplierBill: notYet,
    paymentSlip: notYet,
  };
}
