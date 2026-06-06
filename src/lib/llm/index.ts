/**
 * LLM gateway — the single entry point for invoice extraction.
 *
 * Concerns owned here (addendum):
 *   - §2.2  compliance check before any dispatch;
 *   - §2.3  prompt is built via buildExtractionPrompt — nothing else;
 *   - §2.4  no payload-bearing logging (callers use scrub() if needed);
 *   - §2.7  pre-flight: token cap, daily quota, circuit breaker;
 *           post-flight: circuit recordOutcome();
 *   - §"Retry malformed JSON": one correction retry on schema_failed
 *                              before bubbling the failure.
 *
 * The gateway DOES NOT write to the database. It returns a structured
 * outcome describing what happened (success, schema fail, etc.) plus
 * the data the caller needs to write llm_runs / extracted_invoices.
 * The job decides the persistence story.
 */
import { buildExtractionPrompt, PROMPT_NAME, PROMPT_VERSION } from "./prompt";
import {
  assertCompliantForInvoiceData,
  DEFAULT_INVOICE_MODEL,
  NonCompliantModelError,
} from "./registry";
import {
  dispatchAnthropic,
  InvoiceSchemaError,
  ProviderError,
} from "./anthropic";
import type { InvoiceExtractionResult } from "./schema";
import { checkCircuit, recordOutcome } from "./circuit";
import { quotaRemaining } from "./quota";

/** Phase 3 cap (§2.7): ~80k tokens ≈ 320k chars. */
export const MAX_INPUT_CHARS = 320_000;

export type DispatchOutcome =
  | { kind: "succeeded"; result: InvoiceExtractionResult; meta: DispatchMeta }
  | { kind: "schema_failed"; error: InvoiceSchemaError; meta: DispatchMeta }
  | { kind: "provider_error"; error: ProviderError; meta: DispatchMeta }
  | { kind: "text_too_large"; charCount: number; meta: PreFlightMeta }
  | { kind: "quota_exceeded"; remaining: 0; meta: PreFlightMeta }
  | { kind: "circuit_open"; meta: PreFlightMeta }
  | { kind: "non_compliant_model"; error: NonCompliantModelError; meta: PreFlightMeta };

export interface PreFlightMeta {
  modelId: string;
  promptName: string;
  promptVersion: string;
}

export interface DispatchMeta extends PreFlightMeta {
  inputHash: string;
  inputTokensEstimate: number;
  durationMs: number;
  /** Raw tool_use input only present on success. */
  rawToolInput?: unknown;
}

interface GatewayInput {
  organizationId: string;
  documentText: string;
  mimeType: string;
  pageCount: number | null;
  modelId?: string;
  now?: number;
}

/**
 * Run an invoice extraction through the full gateway pipeline.
 * Performs the §"Retry malformed JSON" single correction retry inline:
 * if the first dispatch returns schema_failed, we retry once with the
 * Zod issue list as the correction context.
 */
export async function dispatchInvoiceExtraction(
  input: GatewayInput,
): Promise<DispatchOutcome> {
  const modelId = input.modelId ?? DEFAULT_INVOICE_MODEL;
  const now = input.now ?? Date.now();
  const baseMeta: PreFlightMeta = {
    modelId,
    promptName: PROMPT_NAME,
    promptVersion: PROMPT_VERSION,
  };

  // ── Pre-flight: compliance (§2.2) ─────────────────────────────────────
  let model;
  try {
    model = assertCompliantForInvoiceData(modelId);
  } catch (err) {
    return {
      kind: "non_compliant_model",
      error: err as NonCompliantModelError,
      meta: baseMeta,
    };
  }

  // ── Pre-flight: input size (§2.7) ─────────────────────────────────────
  if (input.documentText.length > MAX_INPUT_CHARS) {
    return {
      kind: "text_too_large",
      charCount: input.documentText.length,
      meta: baseMeta,
    };
  }

  // ── Pre-flight: daily quota (§2.7) ────────────────────────────────────
  const remaining = await quotaRemaining(input.organizationId);
  if (remaining <= 0) {
    return { kind: "quota_exceeded", remaining: 0, meta: baseMeta };
  }

  // ── Pre-flight: circuit (§2.7) ────────────────────────────────────────
  const breaker = checkCircuit(model.provider, now);
  if (breaker.open) {
    return { kind: "circuit_open", meta: baseMeta };
  }

  // ── Build prompt (§2.3) ───────────────────────────────────────────────
  const prompt = buildExtractionPrompt({
    documentText: input.documentText,
    mimeType: input.mimeType,
    pageCount: input.pageCount,
  });

  const dispatchMeta: DispatchMeta = {
    ...baseMeta,
    inputHash: prompt.inputHash,
    inputTokensEstimate: prompt.estimatedTokens,
    durationMs: 0,
  };

  // ── First dispatch ────────────────────────────────────────────────────
  const t0 = now;
  let outcome: DispatchOutcome;
  try {
    const out = await dispatchAnthropic({
      apiModelId: model.apiModelId,
      prompt,
    });
    outcome = {
      kind: "succeeded",
      result: out.result,
      meta: {
        ...dispatchMeta,
        durationMs: Date.now() - t0,
        rawToolInput: out.rawToolInput,
      },
    };
    recordOutcome(model.provider, "ok", Date.now());
    return outcome;
  } catch (err) {
    if (err instanceof InvoiceSchemaError) {
      // §"Retry malformed JSON": one correction attempt.
      const t1 = Date.now();
      try {
        const out = await dispatchAnthropic({
          apiModelId: model.apiModelId,
          prompt,
          correctionContext:
            "Your previous output failed schema validation with these issues: " +
            JSON.stringify(err.issues).slice(0, 500) +
            ". Emit the tool again with the corrections.",
        });
        recordOutcome(model.provider, "ok", Date.now());
        return {
          kind: "succeeded",
          result: out.result,
          meta: {
            ...dispatchMeta,
            durationMs: Date.now() - t0,
            rawToolInput: out.rawToolInput,
          },
        };
      } catch (retryErr) {
        recordOutcome(model.provider, "error", Date.now());
        if (retryErr instanceof InvoiceSchemaError) {
          return {
            kind: "schema_failed",
            error: retryErr,
            meta: { ...dispatchMeta, durationMs: Date.now() - t0 },
          };
        }
        return {
          kind: "provider_error",
          error: retryErr as ProviderError,
          meta: { ...dispatchMeta, durationMs: Date.now() - t1 },
        };
      }
    }
    if (err instanceof ProviderError) {
      recordOutcome(model.provider, "error", Date.now());
      return {
        kind: "provider_error",
        error: err,
        meta: { ...dispatchMeta, durationMs: Date.now() - t0 },
      };
    }
    throw err;
  }
}

export { InvoiceSchemaError, ProviderError };
export type { InvoiceExtractionResult };
