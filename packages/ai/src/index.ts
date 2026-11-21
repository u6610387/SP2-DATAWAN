/**
 * @datawan/ai — the only entry point for AI in the codebase.
 *
 *   const ai = createAi({ USE_MOCK_AI: true, GEMINI_SLIP_MODE: 'paid' });
 *   await ai.parseOrder({ message, products, knownNames, now });
 *
 * USE_MOCK_AI=true  → deterministic mock provider (no network, no cost)
 * USE_MOCK_AI=false → Gemini provider (TODO: packages/ai/src/gemini/provider.ts)
 */
import { createGeminiProvider } from './gemini/provider';
import { createMockProvider } from './mock/provider';
import { createAiService, type AiService, type AiServiceOptions } from './service';

export interface AiConfig {
  USE_MOCK_AI: boolean;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_SLIP_API_KEY?: string;
  GEMINI_SLIP_MODE: 'paid' | 'manual' | 'redacted';
}

export function createAi(cfg: AiConfig, hooks: Omit<AiServiceOptions, 'slipMode'> = {}, now?: () => Date): AiService {
  const provider = cfg.USE_MOCK_AI
    ? createMockProvider(now ? { now } : {})
    : createGeminiProvider({
        apiKey: cfg.GEMINI_API_KEY ?? '',
        model: cfg.GEMINI_MODEL ?? '',
        ...(cfg.GEMINI_SLIP_API_KEY ? { slipApiKey: cfg.GEMINI_SLIP_API_KEY } : {}),
      });
  return createAiService(provider, { ...hooks, slipMode: cfg.GEMINI_SLIP_MODE });
}

export * from './service';
export * from './types';
export { stripPII, restorePII, assertNoPII, PiiLeakError, type PiiContext, type PiiMap } from './pii/strip';
export { createMockProvider, mockOrderParse, mockOwnerNote, mockSupplierBill, mockPaymentSlip } from './mock/provider';
export { createGeminiProvider } from './gemini/provider';
export { checkOrderParse, checkOwnerNote, checkSupplierBill } from './checks';
