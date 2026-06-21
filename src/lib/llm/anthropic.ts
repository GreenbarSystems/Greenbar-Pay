/**
 * Anthropic provider implementation. Uses native tool-use so the model
 * is constrained at decode time to emit JSON matching the supplied tool
 * schema.
 *
 * Phase 8 — generalized over the output schema so the same dispatch
 * primitive can serve invoice extraction (Call 1), briefing card
 * generation (Call 2), and coaching prompt generation (Call 3). The
 * caller passes a Zod schema; we decode the tool_use input through it
 * and return the parsed result.
 *
 * Schema failure throws LlmSchemaError so the gateway can record it on
 * llm_runs and decide whether to retry with a correction prompt.
 */
import type { ZodType } from "zod";
import {
  getAnthropicClient,
  type ToolUseBlock,
} from "./internal/anthropicClient";
import type { BuiltPrompt } from "./prompt";
import { scrubError } from "./scrub";

/**
 * Schema failure on a tool-use response. Renamed from `InvoiceSchemaError`
 * in Phase 8 since multiple call types share it; the old name is
 * re-exported for back-compat.
 */
export class LlmSchemaError extends Error {
  readonly code = "schema_failed";
  readonly issues: unknown;
  constructor(message: string, issues: unknown) {
    super(message);
    this.issues = issues;
  }
}
/** @deprecated Phase 8 renamed to LlmSchemaError; kept for back-compat. */
export const InvoiceSchemaError = LlmSchemaError;

export class ProviderError extends Error {
  readonly code = "provider_error";
  readonly cause: unknown;
  constructor(cause: unknown) {
    const scrubbed = scrubError(cause);
    super(`anthropic dispatch failed: ${scrubbed.message}`);
    this.cause = scrubbed;
  }
}

interface DispatchInput<T> {
  apiModelId: string;
  prompt: BuiltPrompt;
  /**
   * Zod schema used to decode the tool_use input. Phase 8 made this
   * a required parameter so the same dispatch function serves Call 1
   * (invoice), Call 2 (briefing), Call 3 (coaching). Each caller
   * supplies its own schema and gets back a typed result.
   */
  outputSchema: ZodType<T>;
  /** When set, prepended as a correction nudge to a retry attempt. */
  correctionContext?: string;
}

export interface DispatchOutput<T> {
  result: T;
  rawToolInput: unknown;
}

/**
 * Single dispatch. The gateway in index.ts wraps this in compliance,
 * circuit, quota, and retry logic.
 */
export async function dispatchAnthropic<T>(
  input: DispatchInput<T>,
): Promise<DispatchOutput<T>> {
  const client = getAnthropicClient();
  const systemPrompt = input.correctionContext
    ? `${input.prompt.systemPrompt}\n\nCORRECTION NOTE: ${input.correctionContext}`
    : input.prompt.systemPrompt;

  let response;
  try {
    response = await client.messages.create({
      model: input.apiModelId,
      max_tokens: 4096,
      system: systemPrompt,
      // Typecheck-sweep — Anthropic SDK 0.32+ tightened the Tool.input_
      // schema type to require literal `type: "object"` plus the JSON-
      // Schema shape. Our BuiltPrompt.tool.input_schema is intentionally
      // typed as the looser Record<string, unknown> so it can carry any
      // of the Phase 7/8/9 schemas without coupling prompt.ts to the
      // SDK. Cast here at the call site rather than tightening the
      // BuiltPrompt type — the schemas we build are guaranteed
      // JSON-Schema objects by construction.
      tools: [input.prompt.tool] as Parameters<typeof client.messages.create>[0]["tools"],
      // Force the model to use the tool — no chatter, no free text.
      tool_choice: { type: "tool", name: input.prompt.tool.name },
      messages: [{ role: "user", content: input.prompt.userText }],
    });
  } catch (err) {
    throw new ProviderError(err);
  }

  const toolUse = response.content.find(
    (b): b is ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new LlmSchemaError(
      "anthropic returned no tool_use block",
      { responseType: response.stop_reason },
    );
  }

  const parsed = input.outputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new LlmSchemaError(
      "tool_use input failed Zod validation",
      parsed.error.issues,
    );
  }

  return { result: parsed.data, rawToolInput: toolUse.input };
}
