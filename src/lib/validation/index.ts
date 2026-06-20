/**
 * Deterministic invoice validation (PRD §"Validation Rules").
 *
 * The validator is pure: input is the extracted invoice + line items
 * + (optional) prior-approved-invoices for duplicate check + (optional)
 * vendor candidates for matching. Output is a list of findings.
 *
 * The job (validate-extracted-invoice) wraps this with DB I/O.
 */

export type FindingSeverity = "blocking" | "warning";

export type FindingCode =
  // Blocking rules
  | "missing_invoice_number"
  | "missing_vendor_name"
  | "missing_invoice_date"
  | "missing_total"
  | "invalid_invoice_date"
  | "duplicate_invoice"
  | "not_an_invoice"
  // Warning rules
  | "missing_due_date"
  | "due_date_before_invoice_date"
  | "missing_currency"
  | "missing_line_items"
  | "math_mismatch"
  | "low_vendor_match"
  | "low_text_quality"
  // Phase 9 — D3 (Contract Validation)
  | "unit_price_drift"
  | "new_line_item";

export interface ValidationFinding {
  code: FindingCode;
  severity: FindingSeverity;
  message: string;
  /** Free-form context. JSON-serializable. */
  context?: Record<string, unknown>;
}

/** PRD §"Tolerance Rules" — absolute difference ≤ 0.02. */
export const MATH_TOLERANCE = 0.02;

/** PRD §"Tolerance Rules" — low text length warning threshold. */
export const LOW_TEXT_LENGTH = 100;

export interface InvoiceForValidation {
  documentType: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
  dueDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  shipping: number | null;
  discount: number | null;
  total: number | null;
  lineItems: Array<unknown>;
}

export interface ValidationInputs {
  invoice: InvoiceForValidation;
  /** Set of (vendor_name, invoice_number) pairs already approved/exported in this org. */
  priorApprovedKeys: Set<string>;
  /** Vendor match: best confidence label and score, or null if no candidates. */
  vendorMatch: {
    confidence: "low" | "medium" | "high";
    score: number;
  } | null;
  /** Latest document_extractions.text_length for the underlying doc. */
  textLength: number | null;
  /**
   * Phase 9 — D3 + F06. Per-line scoring inputs. Each entry pairs a
   * line index with the score result returned by scoreLine() and the
   * optional drift signal. Empty array when no vendor matched or when
   * the caller doesn't run line scoring (e.g. PATCH revalidate with no
   * line changes). Findings emitted for items flagged `new` or
   * `unit_price_drift`; the per-line confidence itself is persisted to
   * extracted_invoice_lines by the caller, not surfaced here.
   */
  lineScores?: Array<{
    lineNumber: number;
    keyword: string | null;
    score: "high" | "medium" | "low" | "new";
    rateDrift: boolean;
    unitPrice: number;
    historyAvg: number | null;
    stddevDistance: number | null;
  }>;
}

export function validateInvoice(inputs: ValidationInputs): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const inv = inputs.invoice;

  // ── Blocking rules ─────────────────────────────────────────────────
  if (inv.documentType !== "invoice" && inv.documentType !== "credit_memo") {
    findings.push({
      code: "not_an_invoice",
      severity: "blocking",
      message: `documentType is '${inv.documentType}', not 'invoice' or 'credit_memo'`,
    });
  }
  if (!inv.invoiceNumber) {
    findings.push({
      code: "missing_invoice_number",
      severity: "blocking",
      message: "invoice number is required",
    });
  }
  if (!inv.vendorName) {
    findings.push({
      code: "missing_vendor_name",
      severity: "blocking",
      message: "vendor name is required",
    });
  }
  if (!inv.invoiceDate) {
    findings.push({
      code: "missing_invoice_date",
      severity: "blocking",
      message: "invoice date is required",
    });
  } else if (!isValidIsoDate(inv.invoiceDate)) {
    findings.push({
      code: "invalid_invoice_date",
      severity: "blocking",
      message: `invoice date '${inv.invoiceDate}' is not a valid YYYY-MM-DD`,
    });
  }
  if (inv.total === null) {
    findings.push({
      code: "missing_total",
      severity: "blocking",
      message: "total is required",
    });
  }
  if (inv.vendorName && inv.invoiceNumber) {
    const key = duplicateKey(inv.vendorName, inv.invoiceNumber);
    if (inputs.priorApprovedKeys.has(key)) {
      findings.push({
        code: "duplicate_invoice",
        severity: "blocking",
        // PR11 M8 — message reaches Anthropic via the briefing prompt.
        // PR7's PII guard forbids vendor name + invoice number in
        // outputs; keep them out of inputs too. The structured context
        // still carries duplicateKey for the sanctioned errors_json.
        message: "A prior approved invoice with the same vendor and invoice number was found.",
        context: { duplicateKey: key },
      });
    }
  }

  // ── Warning rules ──────────────────────────────────────────────────
  if (!inv.dueDate) {
    findings.push({
      code: "missing_due_date",
      severity: "warning",
      message: "due date is missing",
    });
  } else if (
    inv.invoiceDate &&
    isValidIsoDate(inv.invoiceDate) &&
    isValidIsoDate(inv.dueDate) &&
    inv.dueDate < inv.invoiceDate
  ) {
    findings.push({
      code: "due_date_before_invoice_date",
      severity: "warning",
      message: `due date ${inv.dueDate} is before invoice date ${inv.invoiceDate}`,
    });
  }
  if (!inv.currency) {
    findings.push({
      code: "missing_currency",
      severity: "warning",
      message: "currency is missing",
    });
  }
  if (inv.lineItems.length === 0) {
    findings.push({
      code: "missing_line_items",
      severity: "warning",
      message: "no line items extracted",
    });
  }
  if (
    inv.subtotal !== null &&
    inv.total !== null &&
    !mathReconciles(inv)
  ) {
    const computed = (inv.subtotal ?? 0) + (inv.tax ?? 0) + (inv.shipping ?? 0) - (inv.discount ?? 0);
    findings.push({
      code: "math_mismatch",
      severity: "warning",
      message: `subtotal + tax + shipping − discount = ${round2(computed)} but total is ${inv.total}`,
      context: { computed: round2(computed), declared: inv.total, tolerance: MATH_TOLERANCE },
    });
  }
  if (inputs.vendorMatch && inputs.vendorMatch.confidence === "low") {
    findings.push({
      code: "low_vendor_match",
      severity: "warning",
      message: "best vendor match has low confidence",
      context: { score: inputs.vendorMatch.score },
    });
  }
  if (inputs.textLength !== null && inputs.textLength < LOW_TEXT_LENGTH) {
    findings.push({
      code: "low_text_quality",
      severity: "warning",
      message: `OCR/native text length ${inputs.textLength} is below ${LOW_TEXT_LENGTH}`,
    });
  }

  // ── Phase 9 — D3 Contract Validation rules ────────────────────────
  // Emit at most one `new_line_item` warning summarising all new keywords
  // (per-line spam helps no one), and one `unit_price_drift` warning per
  // drifting line so reviewers can map directly back to the row.
  if (inputs.lineScores && inputs.lineScores.length > 0) {
    const newItems = inputs.lineScores.filter((s) => s.score === "new");
    if (newItems.length > 0) {
      const summary =
        newItems.length === 1
          ? `Line ${newItems[0].lineNumber}${newItems[0].keyword ? ` ("${newItems[0].keyword}")` : ""} not seen before from this vendor.`
          : `${newItems.length} line items not seen before from this vendor (lines ${newItems.map((s) => s.lineNumber).join(", ")}).`;
      findings.push({
        code: "new_line_item",
        severity: "warning",
        message: summary,
        context: {
          lineNumbers: newItems.map((s) => s.lineNumber),
          keywords: newItems.map((s) => s.keyword).filter(Boolean),
        },
      });
    }

    for (const s of inputs.lineScores) {
      if (!s.rateDrift) continue;
      const pct =
        s.historyAvg && s.historyAvg !== 0
          ? Math.round(((s.unitPrice - s.historyAvg) / s.historyAvg) * 1000) / 10
          : null;
      // PR11 C6 — message goes to Anthropic via the briefing prompt.
      // Use directional/range language instead of exact dollar amounts.
      // Precise figures stay in the sanctioned `context` field for
      // validation_results.errors_json (and the UI rendering path).
      findings.push({
        code: "unit_price_drift",
        severity: "warning",
        message:
          pct === null
            ? `Line ${s.lineNumber} unit price differs materially from prior history.`
            : `Line ${s.lineNumber} unit price is materially ${pct > 0 ? "above" : "below"} historical average.`,
        context: {
          lineNumber: s.lineNumber,
          keyword: s.keyword,
          unitPrice: s.unitPrice,
          historyAvg: s.historyAvg,
          stddevDistance: s.stddevDistance,
          variancePct: pct,
        },
      });
    }
  }

  return findings;
}

/** Single-pair duplicate key — normalized vendor + raw invoice number. */
export function duplicateKey(vendorName: string, invoiceNumber: string): string {
  return `${normalizeVendor(vendorName)}|${invoiceNumber.trim().toLowerCase()}`;
}

/**
 * Lowercase, strip punctuation, collapse whitespace. Same normalizer
 * used for vendor matching (uniq_vendors_org_normalized).
 */
export function normalizeVendor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function mathReconciles(inv: InvoiceForValidation): boolean {
  const computed =
    (inv.subtotal ?? 0) +
    (inv.tax ?? 0) +
    (inv.shipping ?? 0) -
    (inv.discount ?? 0);
  return Math.abs(computed - (inv.total ?? 0)) <= MATH_TOLERANCE;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compose findings into a single severity for the parent record. */
export function blockingPresent(findings: ValidationFinding[]): boolean {
  return findings.some((f) => f.severity === "blocking");
}
