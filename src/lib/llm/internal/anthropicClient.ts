/**
 * The ONLY file allowed to import @anthropic-ai/sdk. The ESLint rule
 * (.eslintrc.cjs) exempts this path. All callers must go through
 * `dispatchInvoiceExtraction` in src/lib/llm/index.ts.
 *
 * Per addendum §2.4, the Anthropic SDK is the only place the raw prompt
 * and response payload exist outside the database.
 */
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      // baseURL defaults to api.anthropic.com (US region). Override per
      // org once we ship multi-region.
    });
  }
  return client;
}

export type AnthropicMessages = Anthropic.Messages;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
