/**
 * Anthropic provider implementation. Uses native tool-use so the model
 * is constrained at decode time to emit JSON matching INVOICE_TOOL_JSON_SCHEMA.
 *
 * The function returns the *parsed and Zod-validated* extraction. Schema
 * failure throws InvoiceSchemaError so the gateway can record it on the
 * llm_runs row and decide whether to retry-with-correction.
 */
import {
  getAnthropicClient,
  type ToolUseBlock,
} from "./internal/anthropicClient";
import type { BuiltPrompt } from "./prompt";
import {
  InvoiceExtractionSchema,
  type InvoiceExtractionResult,
} from "./schema";
import { scrubError } from "./scrub";

export class InvoiceSchemaError extends Error {
  readonly code = "schema_failed";
  readonly issues: unknown;
  constructor(message: string, issues: unknown) {
    super(message);
    this.issues = issues;
  }
}

export class ProviderError extends Error {
  readonly code = "provider_error";
  readonly cause: unknown;
  constructor(cause: unknown) {
    // SDK errors (esp. Anthropic 4xx) frequently echo fragments of the
    // request body in `.message`. Run the cause through scrubError before
    // building this message so the resulting `.message` never carries
    // raw payload data — it's the value stored on `llm_runs.error_message`
    // and surfaced anywhere this Error.message is read.
    const scrubbed = scrubError(cause);
    super(`anthropic dispatch failed: ${scrubbed.message}`);
    // Keep the (already-scrubbed) cause so consumers can introspect.
    this.cause = scrubbed;
  }
}

interface DispatchInput {
  apiModelId: string;
  prompt: BuiltPrompt;
  /** When set, prepended as a correction nudge to a retry attempt. */
  correctionContext?: string;
}

export interface DispatchOutput {
  result: InvoiceExtractionResult;
  rawToolInput: unknown;
}

/**
 * Single dispatch. The gateway in index.ts wraps this in compliance,
 * circuit, quota, and retry logic.
 */
export async function dispatchAnthropic(
  input: DispatchInput,
): Promise<DispatchOutput> {
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
      tools: [input.prompt.tool],
      // Force the model to use the tool — no chatter, no free text.
      tool_choice: { type: "tool", name: input.prompt.tool.name },
      messages: [{ role: "user", content: input.prompt.userText }],
    });
  } catch (err) {
    throw new ProviderError(err);
  }

  // The tool-choice forcing means there must be exactly one tool_use block.
  const toolUse = response.content.find(
    (b): b is ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new InvoiceSchemaError(
      "anthropic returned no tool_use block",
      { responseType: response.stop_reason },
    );
  }

  const parsed = InvoiceExtractionSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new InvoiceSchemaError(
      "tool_use input failed Zod validation",
      parsed.error.issues,
    );
  }

  return { result: parsed.data, rawToolInput: toolUse.input };
}
