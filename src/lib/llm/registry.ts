/**
 * LLM model compliance registry (addendum §2.2).
 *
 * The gateway refuses to dispatch invoice payloads to any model whose
 * registry entry doesn't satisfy:
 *   - allowsCustomerData === true
 *   - retentionDays === 0
 *   - region matches an approved list (US for V1)
 *
 * Adding a model means recording its compliance posture HERE — not in
 * a comment, not in docs. The unit test in src/lib/llm/__tests__/
 * asserts the gateway refuses to dispatch to a non-compliant entry.
 */
export type ModelRegion = "us" | "eu";

export interface LlmModel {
  /** "provider:model-id" — e.g. "anthropic:claude-sonnet-4-5-20251001". */
  id: string;
  provider: "anthropic" | "openai";
  /** The provider-side model identifier passed in API calls. */
  apiModelId: string;
  /** False blocks invoice traffic (§2.2). */
  allowsCustomerData: boolean;
  /** Must be 0 for production traffic (§2.2). */
  retentionDays: 0 | number;
  region: ModelRegion;
  /** USD cost per million input tokens (for estimatedCostUsd on llm_runs). */
  inputCostPerMToken: number;
  /** USD cost per million output tokens (for estimatedCostUsd on llm_runs). */
  outputCostPerMToken: number;
  /** Recorded for context; not enforced. */
  notes?: string;
}

/**
 * V1 registry. Anthropic API has zero data retention by default and no
 * training on customer data — both contractual (§2.2). US inference
 * endpoints by default.
 *
 * To add a model: confirm provider_compliance.md is up to date, then
 * add the entry. Don't ship without the BAA / DPA on file.
 */
export const MODELS: Record<string, LlmModel> = {
  "anthropic:claude-sonnet-4-5-20251001": {
    id: "anthropic:claude-sonnet-4-5-20251001",
    provider: "anthropic",
    apiModelId: "claude-sonnet-4-5-20251001",
    allowsCustomerData: true,
    retentionDays: 0,
    region: "us",
    inputCostPerMToken: 3.0,
    outputCostPerMToken: 15.0,
    notes: "Primary extraction model. ZDR by default; BAA on file.",
  },
};

export class NonCompliantModelError extends Error {
  readonly code = "non_compliant_model";
  constructor(modelId: string, reason: string) {
    super(`model ${modelId} is not compliant for invoice traffic: ${reason}`);
  }
}

/**
 * Throws NonCompliantModelError if the model is missing, retains data,
 * or has the wrong region. The gateway calls this on every dispatch.
 */
export function assertCompliantForInvoiceData(modelId: string): LlmModel {
  const m = MODELS[modelId];
  if (!m) {
    throw new NonCompliantModelError(modelId, "not in registry");
  }
  if (!m.allowsCustomerData) {
    throw new NonCompliantModelError(modelId, "allowsCustomerData=false");
  }
  if (m.retentionDays !== 0) {
    throw new NonCompliantModelError(
      modelId,
      `retentionDays=${m.retentionDays}, must be 0`,
    );
  }
  if (m.region !== "us") {
    throw new NonCompliantModelError(
      modelId,
      `region=${m.region}, V1 requires US`,
    );
  }
  return m;
}

/** Default model — selected per org/feature once we add per-org overrides. */
export const DEFAULT_INVOICE_MODEL = "anthropic:claude-sonnet-4-5-20251001";
