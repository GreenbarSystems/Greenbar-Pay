/**
 * Briefing Card prompt builder (Phase 8 — D2).
 *
 * Per addendum §2.3 this is the ONLY allowed entry point for building
 * a briefing-card payload — the ESLint rule that blocks direct
 * `@anthropic-ai/sdk` imports applies here too.
 *
 * Inputs are bounded and scoped to the single invoice being reviewed:
 *   - the invoice's extracted JSON
 *   - the vendor profile snapshot (Phase 7 — D1)
 *   - active validation findings (drives the anomaly flags array)
 *   - the prior approved invoice from this vendor (for delta summary),
 *     header fields only — never full text
 *   - the deterministic risk score the model is justifying
 *
 * Cross-org leakage is structurally impossible: the caller pulls all
 * data inside withOrg, so RLS guarantees same-org provenance.
 */
import { createHash } from "node:crypto";
import { BRIEFING_TOOL_JSON_SCHEMA } from "./briefing-card-schema";
import type { BuiltPrompt } from "./prompt";

export const BRIEFING_PROMPT_NAME = "briefing-card";
export const BRIEFING_PROMPT_VERSION = "2026-06-20-pr11";

export const BRIEFING_SYSTEM_PROMPT = `You generate an approver-facing Briefing Card for an accounts-payable invoice.

You always have:
- the structured invoice JSON the LLM extracted
- a vendor profile snapshot (spend, count, terms, drift status)
- a list of structured validation findings (already computed)
- optionally, the most recent prior invoice from this vendor for delta comparison
- a deterministic risk score (0–100) — you do not change the number, you justify it

Output the emit_briefing tool exactly once with:

- glCode: suggested GL account code (string) or null. Prefer the vendor's
  default_gl_code if present and the line items match prior patterns.
  Use null only when you cannot make a defensible suggestion.
- glRationale: one short paragraph (≤ 500 chars). Reference the vendor's
  history, dominant line keyword, or default code. Never invent data.
- anomalyFlags: an array of {code, severity, message, evidenceChain}
  objects. Translate each structured validation finding into a
  one-sentence approver-facing message. Add vendor-signal flags
  (terms_drift, duplicate_pattern, spend_run_rate, rate_drift,
  new_line_item) when present in the inputs. Severity mapping:
    info     — informational, no action expected
    warning  — review recommended; approver can still approve
    critical — should NOT be approved without resolving
  Mirror "blocking" validation severity → critical; "warning" → warning.
  Phase 9 — F07: EVERY anomaly flag MUST include an evidenceChain array
  of 2–6 labelled steps showing the reasoning the approver can audit.
  Canonical labels in order (omit any that don't apply):
    "Evidence"        — the historical data supporting the flag
                        (n invoices, avg price, date range)
    "This invoice"    — the specific extracted value that triggered it
    "Trend signal"    — what direction the vendor's prior data was
                        moving (stable / rising / falling)
    "Contract reference" — cite contract_rate when present in inputs
    "Stddev distance" — only when stats include stddev; quote σ
    "Recommendation"  — one sentence: what the approver should do next
  Each detail must use statistical descriptors (e.g. "Last 8 invoices
  averaged near the historical mean", "within 1 standard deviation",
  "above 80th percentile") rather than exact dollar figures. The PII
  rules above still apply — never quote the vendor name, invoice
  number, or exact dollar amounts in chain details. Sample counts and
  percentage drifts ARE OK ("8 prior samples", "+18%"); raw currency
  amounts are NOT.
- deltaSummary: ≤ 500 chars. What changed vs the prior invoice
  (amount, terms, line items, due date). Empty string if no prior
  invoice was supplied.
- riskJustification: ONE sentence (≤ 280 chars) explaining the
  deterministic risk score. Do NOT include the number — the UI prints
  it separately. Reference the strongest contributing factor.

Rules:
- Plain English the approver can act on. No technical jargon, no
  references to internal systems or prompt names.
- Never invent values not present in the inputs.
- PII / payload hygiene (applies to glRationale, deltaSummary,
  riskJustification, and every anomalyFlags message):
    * Never write the vendor name. Use generic phrases like
      "this vendor", "the vendor", "their prior invoice".
    * Never write invoice numbers, PO numbers, addresses, EINs,
      tax IDs, account numbers, or routing numbers.
    * Refer to amounts in approximate ranges if directly quoting
      would identify the invoice (e.g. "about $4k" not "$3,987.42").
  These fields persist in plain text and surface in evidence packets;
  they must be re-readable without leaking customer payload.
- Return only the tool call.`;

export interface BriefingPromptInput {
  /** The extracted invoice JSON (header fields + line items). */
  invoice: BriefingInvoice;
  /** Vendor profile snapshot — Phase 7. Null if no vendor matched yet. */
  vendorProfile: BriefingVendorProfile | null;
  /** Active validation findings driving the anomaly flags. */
  findings: Array<{ code: string; severity: string; message: string }>;
  /** Latest approved invoice from this vendor, header fields only. */
  priorInvoice: BriefingPriorInvoice | null;
  /** Deterministic 0–100 risk score the LLM is asked to justify. */
  riskScore: number;
  /**
   * Contributing factors so the prose can reference them.
   *
   * PR11 M9 — `note` (e.g. "8 line items priced materially above vendor
   * history") was omitted: it crosses the Anthropic boundary as
   * per-vendor behavioural signal with no offsetting benefit. The
   * builder maps factor codes to canonical descriptions in the prompt
   * itself; we don't need the LLM to paraphrase a free-text note.
   */
  riskFactors: Array<{ code: string; weight: number }>;
}

export interface BriefingInvoice {
  documentType: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  paymentTerms: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  shipping: number | null;
  discount: number | null;
  total: number | null;
  lineItems: Array<{
    description: string | null;
    quantity: number | null;
    unitPrice: number | null;
    amount: number | null;
  }>;
}

export interface BriefingVendorProfile {
  invoiceCount: number;
  lastInvoiceDate: string | null;
  spend30d: string;
  spend90d: string;
  avgInvoiceAmount: string;
  defaultPaymentTerms: string | null;
  defaultGlCode: string | null;
  termsDriftDetected: boolean;
  duplicateSubmissionCount: number;
  aliases: string[];
}

export interface BriefingPriorInvoice {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  paymentTerms: string | null;
  currency: string | null;
  total: string | null;
  topLineDescriptions: string[];
}

export function buildBriefingCardPrompt(input: BriefingPromptInput): BuiltPrompt {
  const userText = JSON.stringify(
    {
      invoice: input.invoice,
      vendorProfile: input.vendorProfile,
      findings: input.findings,
      priorInvoice: input.priorInvoice,
      riskScore: input.riskScore,
      riskFactors: input.riskFactors,
    },
    null,
    2,
  );

  // Char count ≈ token estimate via the same /4 heuristic as the
  // extraction prompt. Briefing inputs are bounded by the schemas
  // above — typically a few KB.
  const estimatedTokens = Math.ceil(userText.length / 4);

  const inputHash = createHash("sha256")
    .update(BRIEFING_SYSTEM_PROMPT)
    .update("\n")
    .update(userText)
    .digest("hex");

  return {
    systemPrompt: BRIEFING_SYSTEM_PROMPT,
    userText,
    inputHash,
    estimatedTokens,
    tool: {
      name: "emit_briefing",
      description:
        "Emit the structured Briefing Card for this AP invoice review.",
      input_schema: BRIEFING_TOOL_JSON_SCHEMA,
    },
  };
}
