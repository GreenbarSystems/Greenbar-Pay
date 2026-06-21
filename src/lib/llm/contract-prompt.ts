/**
 * Phase 9.5 — Vendor-contract extraction prompt.
 *
 * Strictly text-in, tool-call-out. Same compliance-boundary rules as
 * buildExtractionPrompt: no cross-document data, no vendor master,
 * no email context. Only the contract's own bytes + meta.
 */
import { createHash } from "node:crypto";
import { CONTRACT_TOOL_JSON_SCHEMA } from "./contract-schema";
import type { BuiltPrompt } from "./prompt";

export const CONTRACT_PROMPT_NAME = "contract-extraction";
export const CONTRACT_PROMPT_VERSION = "2026-06-21";

export const CONTRACT_SYSTEM_PROMPT = `You extract structured rate-card and term data from accounts-payable vendor contracts.

Rules:
- Call the emit_contract tool exactly once with your extraction.
- Do not invent missing values. Use null when a field is unavailable.
- Use ISO date format YYYY-MM-DD for effectiveDate and expiryDate. Set expiryDate to null when the contract is open-ended (no expiry date specified).
- Use numeric values (not strings) for unitPrice, earlyPaymentDiscountPct, earlyPaymentDiscountDays, minQuantity, maxQuantity.
- Preserve the currency shown on the contract (ISO 4217 code).
- For each lineItems[i].priceBasis, choose the closest match: per_unit, per_hour, per_month, per_year, flat, tiered. If none fit, return the literal phrase from the contract (e.g. "per linear foot").
- For tiered pricing tables, emit ONE lineItem per bracket. Set minQuantity and maxQuantity. The last bracket may have null maxQuantity.
- earlyPaymentDiscountPct and earlyPaymentDiscountDays must BOTH be non-null or BOTH be null. A line like "2% discount if paid within 10 days" yields pct=2, days=10.
- Add a warning string when:
  - the document does not appear to be a vendor contract (e.g. it looks like an invoice or a generic letter);
  - the effective or expiry date is ambiguous;
  - the rate card is partial or unclear (e.g. rates given as "varies" or "see schedule A");
  - the payment terms are written as multiple conflicting clauses.
- Set confidence:
  - "high" when dates, payment terms, and a clear rate card are all present;
  - "medium" when the header is clear but the rate card is partial;
  - "low" when substantial OCR/quality issues are evident or large portions are illegible.

Return only the tool call. Do not output free text.`;

interface BuildInput {
  documentText: string;
  mimeType: string;
  pageCount: number | null;
}

export function buildContractExtractionPrompt(input: BuildInput): BuiltPrompt {
  const meta = [
    `MIME type: ${input.mimeType}`,
    `Page count: ${input.pageCount ?? "unknown"}`,
  ].join("\n");

  const userText = `${meta}\n\n--- CONTRACT TEXT ---\n${input.documentText}\n--- END ---`;
  const estimatedTokens = Math.ceil(userText.length / 4);
  const inputHash = createHash("sha256")
    .update(CONTRACT_SYSTEM_PROMPT)
    .update("\n")
    .update(userText)
    .digest("hex");

  return {
    systemPrompt: CONTRACT_SYSTEM_PROMPT,
    userText,
    inputHash,
    estimatedTokens,
    tool: {
      name: "emit_contract",
      description: "Emit the structured vendor-contract extraction.",
      input_schema: CONTRACT_TOOL_JSON_SCHEMA,
    },
  };
}
