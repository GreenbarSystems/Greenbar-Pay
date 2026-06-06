/**
 * The ONLY entry point for constructing an LLM payload (addendum §2.3).
 * String-concatenating arbitrary data into a provider call from anywhere
 * else is forbidden by the ESLint rule that blocks direct SDK imports.
 *
 * Allowed inputs:
 *   - the raw text of the current document (post-OCR / native extraction);
 *   - the document's MIME type and page count (helps the model reason
 *     about completeness — "I've seen 1 of 3 pages, expect more lines");
 *   - the static system instructions below and the strict JSON Schema.
 *
 * FORBIDDEN inputs (called out explicitly by the addendum):
 *   - any other org's data;
 *   - any other document's text from the same org;
 *   - vendor lists, prior invoices, or user metadata;
 *   - email subject or body that delivered the attachment.
 *
 * If a future caller needs vendor matching, that's a downstream
 * validation step — not an LLM input.
 */
import { createHash } from "node:crypto";
import { INVOICE_TOOL_JSON_SCHEMA } from "./schema";

export const PROMPT_NAME = "invoice-extraction";
export const PROMPT_VERSION = "2026-06-01";

export const SYSTEM_PROMPT = `You extract structured data from accounts-payable invoice text.

Rules:
- Call the emit_invoice tool exactly once with your extraction.
- Do not invent missing values. Use null when a field is unavailable.
- Use ISO date format YYYY-MM-DD for invoiceDate and dueDate.
- Use numeric values (not strings) for all money fields.
- Preserve the currency shown on the document (ISO 4217 code).
- Add a warning string when:
  - subtotal + tax + shipping − discount does not equal total within $0.02;
  - the document does not appear to be an invoice;
  - any line item lacks a description, quantity, or amount;
  - dates are missing or ambiguous.
- Set documentType:
  - "invoice" for normal vendor bills;
  - "credit_memo" for refunds or credit notes;
  - "statement" for monthly account statements;
  - "receipt" for paid receipts not requiring AP entry;
  - "unknown" if the document is clearly something else (e.g. a contract).
- Set confidence:
  - "high" if all header fields and totals are clearly present;
  - "medium" if most are present but some are inferred;
  - "low" if substantial OCR/quality issues are evident.

Return only the tool call. Do not output free text.`;

export interface BuiltPrompt {
  systemPrompt: string;
  userText: string;
  /** sha256 over the prompt — stored on llm_runs.input_hash (§2.4). */
  inputHash: string;
  /** Char count is a reasonable proxy for tokens for §2.7's cap. */
  estimatedTokens: number;
  tool: {
    name: string;
    description: string;
    input_schema: typeof INVOICE_TOOL_JSON_SCHEMA;
  };
}

interface BuildInput {
  documentText: string;
  mimeType: string;
  pageCount: number | null;
}

export function buildExtractionPrompt(input: BuildInput): BuiltPrompt {
  const meta = [
    `MIME type: ${input.mimeType}`,
    `Page count: ${input.pageCount ?? "unknown"}`,
  ].join("\n");

  const userText = `${meta}\n\n--- DOCUMENT TEXT ---\n${input.documentText}\n--- END ---`;

  // Token estimate: ~4 chars per token for English text. Real tokenizer
  // calls aren't worth the dependency for a soft cap.
  const estimatedTokens = Math.ceil(userText.length / 4);

  const inputHash = createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update("\n")
    .update(userText)
    .digest("hex");

  return {
    systemPrompt: SYSTEM_PROMPT,
    userText,
    inputHash,
    estimatedTokens,
    tool: {
      name: "emit_invoice",
      description: "Emit the structured invoice extraction.",
      input_schema: INVOICE_TOOL_JSON_SCHEMA,
    },
  };
}
