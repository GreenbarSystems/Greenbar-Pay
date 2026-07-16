/**
 * LLM gateway — the single entry point for ALL invoice-related model
 * dispatches (extraction, briefing card, coaching).
 *
 * Concerns owned here (addendum):
 *   - §2.2  compliance check before any dispatch;
 *   - §2.3  prompts are built via dedicated builders (buildExtractionPrompt,
 *           buildBriefingCardPrompt, …) — nothing else;
 *   - §2.4  no payload-bearing logging (callers use scrub() if needed);
 *   - §2.7  pre-flight: token cap, daily quota, circuit breaker;
 *           post-flight: circuit recordOutcome();
 *   - §"Retry malformed JSON": one correction retry on schema_failed
 *                              before bubbling the failure.
 *
 * Phase 8 generalized the dispatch path so a single core (runDispatch<T>)
 * serves Call 1 (invoice), Call 2 (briefing), and Call 3 (coaching).
 * Each public entry point is a thin wrapper that supplies its own prompt
 * builder + Zod schema; the wrapper records its own promptName/version
 * on the llm_runs row.
 *
 * The gateway DOES NOT write to the database. It returns a structured
 * outcome describing what happened (success, schema fail, etc.); the
 * caller decides the persistence story.
 */
import type { ZodType } from "zod";
import { buildExtractionPrompt, PROMPT_NAME, PROMPT_VERSION } from "./prompt";
import {
  buildBriefingCardPrompt,
  BRIEFING_PROMPT_NAME,
  BRIEFING_PROMPT_VERSION,
  type BriefingPromptInput,
} from "./briefing-card-prompt";
import {
  assertCompliantForInvoiceData,
  DEFAULT_INVOICE_MODEL,
  NonCompliantModelError,
} from "./registry";
import {
  dispatchAnthropic,
  LlmSchemaError,
  ProviderError,
} from "./anthropic";
import { InvoiceExtractionSchema, type InvoiceExtractionResult } from "./schema";
import {
  BriefingCardSchema,
  type BriefingCardResult,
} from "./briefing-card-schema";
import {
  ContractExtractionSchema,
  type ContractExtractionResult,
} from "./contract-schema";
import {
  buildContractExtractionPrompt,
  CONTRACT_PROMPT_NAME,
  CONTRACT_PROMPT_VERSION,
} from "./contract-prompt";
import { checkCircuit, recordOutcome } from "./circuit";
import { quotaRemaining } from "./quota";
import type { BuiltPrompt } from "./prompt";

/** Phase 3 cap (§2.7): ~80k tokens ≈ 320k chars. */
export const MAX_INPUT_CHARS = 320_000;

export type DispatchOutcome<T> =
  | { kind: "succeeded"; result: T; meta: DispatchMeta }
  | { kind: "schema_failed"; error: LlmSchemaError; meta: DispatchMeta }
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
  /** Actual input tokens from the provider response. */
  inputTokens: number;
  /** Actual output tokens from the provider response. */
  outputTokens: number;
  /** Estimated cost in USD: (inputTokens * inputCostPerMToken + outputTokens * outputCostPerMToken) / 1_000_000. */
  estimatedCostUsd: number;
  durationMs: number;
  /** Raw tool_use input only present on success. */
  rawToolInput?: unknown;
}

/**
 * Core dispatch — generic over the parsed result type. Handles
 * compliance, token cap, quota, circuit, dispatch, and the §"Retry
 * malformed JSON" single correction retry.
 *
 * Callers supply:
 *   - inputCharCount: drives the §2.7 text_too_large pre-flight
 *   - prompt: pre-built BuiltPrompt (already hashed + tokens estimated)
 *   - outputSchema: Zod schema for decoding the tool_use input
 *
 * Compliance + quota use the existing invoice-traffic gates — Phase 8's
 * three call types all carry the same vendor/financial data and so
 * share the same registry whitelist.
 */
async function runDispatch<T>(args: {
  organizationId: string;
  inputCharCount: number;
  prompt: BuiltPrompt;
  outputSchema: ZodType<T>;
  promptName: string;
  promptVersion: string;
  modelId?: string;
  now?: number;
}): Promise<DispatchOutcome<T>> {
  const modelId = args.modelId ?? DEFAULT_INVOICE_MODEL;
  const now = args.now ?? Date.now();
  const baseMeta: PreFlightMeta = {
    modelId,
    promptName: args.promptName,
    promptVersion: args.promptVersion,
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
  if (args.inputCharCount > MAX_INPUT_CHARS) {
    return {
      kind: "text_too_large",
      charCount: args.inputCharCount,
      meta: baseMeta,
    };
  }

  // ── Pre-flight: daily quota (§2.7) ────────────────────────────────────
  const remaining = await quotaRemaining(args.organizationId);
  if (remaining <= 0) {
    return { kind: "quota_exceeded", remaining: 0, meta: baseMeta };
  }

  // ── Pre-flight: circuit (§2.7) ────────────────────────────────────────
  const breaker = await checkCircuit(model.provider, now);
  if (breaker.open) {
    return { kind: "circuit_open", meta: baseMeta };
  }

  const baseDispatchMeta = {
    ...baseMeta,
    inputHash: args.prompt.inputHash,
    inputTokensEstimate: args.prompt.estimatedTokens,
  };

  const computeCost = (inputTokens: number, outputTokens: number) =>
    (inputTokens * model.inputCostPerMToken + outputTokens * model.outputCostPerMToken) /
    1_000_000;

  // ── First dispatch ────────────────────────────────────────────────────
  const t0 = now;
  try {
    const out = await dispatchAnthropic({
      apiModelId: model.apiModelId,
      prompt: args.prompt,
      outputSchema: args.outputSchema,
    });
    await recordOutcome(model.provider, "ok", Date.now());
    return {
      kind: "succeeded",
      result: out.result,
      meta: {
        ...baseDispatchMeta,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        estimatedCostUsd: computeCost(out.inputTokens, out.outputTokens),
        durationMs: Date.now() - t0,
        rawToolInput: out.rawToolInput,
      },
    };
  } catch (err) {
    if (err instanceof LlmSchemaError) {
      // §"Retry malformed JSON": one correction attempt.
      const t1 = Date.now();
      try {
        const out = await dispatchAnthropic({
          apiModelId: model.apiModelId,
          prompt: args.prompt,
          outputSchema: args.outputSchema,
          correctionContext:
            "Your previous output failed schema validation with these issues: " +
            JSON.stringify(err.issues).slice(0, 500) +
            ". Emit the tool again with the corrections.",
        });
        await recordOutcome(model.provider, "ok", Date.now());
        return {
          kind: "succeeded",
          result: out.result,
          meta: {
            ...baseDispatchMeta,
            inputTokens: out.inputTokens,
            outputTokens: out.outputTokens,
            estimatedCostUsd: computeCost(out.inputTokens, out.outputTokens),
            durationMs: Date.now() - t0,
            rawToolInput: out.rawToolInput,
          },
        };
      } catch (retryErr) {
        await recordOutcome(model.provider, "error", Date.now());
        if (retryErr instanceof LlmSchemaError) {
          return {
            kind: "schema_failed",
            error: retryErr,
            meta: {
              ...baseDispatchMeta,
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostUsd: 0,
              durationMs: Date.now() - t0,
            },
          };
        }
        return {
          kind: "provider_error",
          error: retryErr as ProviderError,
          meta: {
            ...baseDispatchMeta,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
            durationMs: Date.now() - t1,
          },
        };
      }
    }
    if (err instanceof ProviderError) {
      recordOutcome(model.provider, "error", Date.now());
      return {
        kind: "provider_error",
        error: err,
        meta: {
          ...baseDispatchMeta,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          durationMs: Date.now() - t0,
        },
      };
    }
    throw err;
  }
}

// ─── Call 1: invoice extraction ──────────────────────────────────────────

interface InvoiceGatewayInput {
  organizationId: string;
  documentText: string;
  mimeType: string;
  pageCount: number | null;
  modelId?: string;
  now?: number;
}

export async function dispatchInvoiceExtraction(
  input: InvoiceGatewayInput,
): Promise<DispatchOutcome<InvoiceExtractionResult>> {
  const prompt = buildExtractionPrompt({
    documentText: input.documentText,
    mimeType: input.mimeType,
    pageCount: input.pageCount,
  });
  return runDispatch({
    organizationId: input.organizationId,
    inputCharCount: input.documentText.length,
    prompt,
    outputSchema: InvoiceExtractionSchema,
    promptName: PROMPT_NAME,
    promptVersion: PROMPT_VERSION,
    modelId: input.modelId,
    now: input.now,
  });
}

// ─── Call 2: briefing card (Phase 8) ─────────────────────────────────────

interface BriefingGatewayInput extends BriefingPromptInput {
  organizationId: string;
  modelId?: string;
  now?: number;
}

export async function dispatchBriefingCardGeneration(
  input: BriefingGatewayInput,
): Promise<DispatchOutcome<BriefingCardResult>> {
  const prompt = buildBriefingCardPrompt(input);
  return runDispatch({
    organizationId: input.organizationId,
    inputCharCount: prompt.userText.length,
    prompt,
    outputSchema: BriefingCardSchema,
    promptName: BRIEFING_PROMPT_NAME,
    promptVersion: BRIEFING_PROMPT_VERSION,
    modelId: input.modelId,
    now: input.now,
  });
}

// ─── Call 3: vendor-contract extraction (Phase 9.5) ─────────────────────

interface ContractGatewayInput {
  organizationId: string;
  documentText: string;
  mimeType: string;
  pageCount: number | null;
  modelId?: string;
  now?: number;
}

export async function dispatchContractExtraction(
  input: ContractGatewayInput,
): Promise<DispatchOutcome<ContractExtractionResult>> {
  const prompt = buildContractExtractionPrompt({
    documentText: input.documentText,
    mimeType: input.mimeType,
    pageCount: input.pageCount,
  });
  return runDispatch({
    organizationId: input.organizationId,
    inputCharCount: input.documentText.length,
    prompt,
    outputSchema: ContractExtractionSchema,
    promptName: CONTRACT_PROMPT_NAME,
    promptVersion: CONTRACT_PROMPT_VERSION,
    modelId: input.modelId,
    now: input.now,
  });
}

export { LlmSchemaError, ProviderError };
// Re-export the prior name so existing callers keep working until they migrate.
export { LlmSchemaError as InvoiceSchemaError } from "./anthropic";
export type { InvoiceExtractionResult, ContractExtractionResult };
export type { BriefingCardResult };
