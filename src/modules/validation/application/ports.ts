/**
 * Dependency-inversion boundary for the invoice-validation module.
 * Domain and application code depend only on these interfaces;
 * src/modules/validation/infrastructure/* implements them. Every
 * method takes the existing `Tx` from `@/db/client`'s
 * `withOrg`/`withOrgAsWorker` — this refactor layers boundaries on top
 * of the tenant-isolation transaction boundary, it does not replace it.
 *
 * Note on cross-module reads: this module queries `vendors`,
 * `vendorPricingHistory`, and `vendorContracts`/`vendorContractLines` —
 * tables the `vendors` module also reads. Each bounded context owns its
 * own read-model/repository for what IT needs (context mapping, not
 * shared infrastructure) rather than importing another module's
 * repository — the query shapes are genuinely different (e.g. "all
 * active pricing stats for these keywords" vs. the vendors module's
 * "vendor list page" projections).
 */
import type { Tx } from "@/db/client";
import type { VendorCandidate } from "../domain/vendor-matching";
import type { LinePricingStats } from "../domain/line-scoring";
import type { ContractLineMatch } from "../domain/contract-scoring";
import type { RemitToInfo } from "../domain/remit-drift";
import type { PoWithLines } from "../domain/po-matching";

export interface InvoiceHeaderForValidation {
  documentType: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  shipping: string | null;
  discount: string | null;
  total: string | null;
  /** 2026-07-13 audit F7 — used for remit-to drift detection. */
  remitToName: string | null;
  remitToAddress: string | null;
  /** PO matching — 2-way / 3-way. */
  purchaseOrderNumber: string | null;
}

export interface InvoiceLineForValidation {
  id: string;
  lineNumber: number | null;
  description: string | null;
  unitPrice: string | null;
}

export interface LineConfidenceUpdate {
  lineId: string;
  score: "high" | "medium" | "low" | "new";
  reason: string;
  histSampleCount: number | null;
  histAvgPrice: string | null;
  histStddevPrice: string | null;
  stddevDistance: string | null;
}

export interface LineConfidenceSnapshot {
  id: string;
  lineNumber: number | null;
  confidenceScore: string | null;
  confidenceReason: string | null;
  histSampleCount: number | null;
  histAvgPrice: string | null;
  histStddevPrice: string | null;
  stddevDistance: string | null;
  updatedAt: Date | null;
}

export interface InvoiceStatusForValidation {
  id: string;
  documentId: string;
  reviewStatus: string;
}

export interface InvoiceRepository {
  /**
   * pg_advisory_xact_lock keyed on the invoice id, held until the tx
   * commits/rolls back. Serializes a validate-extracted-invoice job
   * retry against a concurrent PATCH-triggered revalidation — without
   * it both could soft-supersede (no rows match) and both insert,
   * leaving two "active" validation_results rows for one entity.
   */
  lockForValidation(tx: Tx, extractedInvoiceId: string): Promise<void>;

  findForValidation(
    tx: Tx,
    organizationId: string,
    extractedInvoiceId: string,
  ): Promise<{
    invoice: InvoiceHeaderForValidation;
    lines: InvoiceLineForValidation[];
  } | null>;

  /** (vendor_name, invoice_number) pairs already approved/exported, excluding this invoice. */
  findPriorApprovedKeys(
    tx: Tx,
    organizationId: string,
    excludeInvoiceId: string,
  ): Promise<Set<string>>;

  /**
   * 2026-07-13 audit F7 — the vendor's most recently APPROVED (by
   * reviewedAt, not the untrusted extracted invoiceDate) invoice's
   * remit-to fields, matched by normalized vendor name. Null when
   * this vendor has no approved invoice yet — nothing to compare
   * against, so drift can never fire on a vendor's first invoice.
   */
  findLatestApprovedRemitTo(
    tx: Tx,
    organizationId: string,
    vendorName: string,
    excludeInvoiceId: string,
  ): Promise<RemitToInfo | null>;

  findLineConfidenceSnapshots(
    tx: Tx,
    lineIds: string[],
  ): Promise<LineConfidenceSnapshot[]>;

  /** Single batched CASE UPDATE across all changed lines. */
  updateLineConfidenceBatch(
    tx: Tx,
    updates: LineConfidenceUpdate[],
  ): Promise<void>;

  /** Job-only: the row + status the validate-extracted-invoice job guards on. */
  findStatusForValidation(
    tx: Tx,
    organizationId: string,
    extractedInvoiceId: string,
  ): Promise<InvoiceStatusForValidation | null>;

  /** Job-only: mutate review_status only while still in an active (validator-owned) state. */
  updateReviewStatusIfActive(
    tx: Tx,
    invoiceId: string,
    newStatus: "pending" | "needs_review",
    activeStatuses: string[],
  ): Promise<void>;
}

export interface VendorCandidateRepository {
  findCandidates(tx: Tx, organizationId: string): Promise<VendorCandidate[]>;

  findPricingStatsForKeywords(
    tx: Tx,
    vendorId: string,
    keywords: string[],
  ): Promise<Map<string, LinePricingStats>>;
}

export interface ActiveVendorContract {
  contractId: string;
  lines: ContractLineMatch[];
  /**
   * sha256 over the exact rate-card rows read (sorted by id), so the
   * validation.contract_scored audit event can bind to the rate-card
   * content actually used — vendor_contract_lines is mutable.
   */
  rateCardHash: string;
}

export interface VendorContractRepository {
  /** Null only when the vendor has no active, non-superseded contract. */
  findActiveContractWithLines(
    tx: Tx,
    organizationId: string,
    vendorId: string,
  ): Promise<ActiveVendorContract | null>;
}

export interface DocumentRepository {
  findLatestExtractionTextLength(
    tx: Tx,
    documentId: string,
  ): Promise<number | null>;

  /** Job-only: compare-and-set document status while still in an allowed current state. */
  updateStatusIfIn(
    tx: Tx,
    documentId: string,
    newStatus: string,
    allowedCurrent: string[],
  ): Promise<void>;
}

export interface ValidationResultInput {
  organizationId: string;
  extractedInvoiceId: string;
  passed: boolean;
  severity: "blocking" | "warning";
  errorsJson: unknown;
}

export interface ValidationResultsRepository {
  /** Soft-supersede: UPDATE ... SET superseded_at = now() WHERE active. */
  supersedeActive(tx: Tx, extractedInvoiceId: string): Promise<void>;
  insert(tx: Tx, result: ValidationResultInput): Promise<void>;
}

export interface VendorMatchWriteInput {
  organizationId: string;
  extractedInvoiceId: string;
  vendorId: string | null;
  matchConfidence: "low" | "medium" | "high";
  matchScore: number;
  matchMethod: string;
  candidatesJson: unknown;
}

export interface VendorMatchWriteRepository {
  /** Append-only — keeps the candidate history visible. */
  insert(tx: Tx, match: VendorMatchWriteInput): Promise<void>;
}

export interface LineConfidenceChange {
  lineId: string;
  lineNumber: number | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface PoMatchResultWrite {
  organizationId: string;
  extractedInvoiceId: string;
  purchaseOrderId: string | null;
  matchType: string | null;
  status: string;
  invoiceTotal: string | null;
  poTotal: string | null;
  variancePct: string | null;
  lineVariancesJson: unknown;
}

export interface PoRegisterRepository {
  /** Returns null when no PO with that number exists in the org's register. */
  findByPoNumber(tx: Tx, orgId: string, poNumber: string): Promise<PoWithLines | null>;
  /** Soft-supersedes the prior active match result, then inserts a new one. */
  upsertMatchResult(tx: Tx, result: PoMatchResultWrite): Promise<void>;
}

export interface OrgSettingsRepository {
  /** Returns the org's po_three_way_enabled flag. */
  findPoThreeWayEnabled(tx: Tx, organizationId: string): Promise<boolean>;
}

export interface ValidationAuditRepository {
  recordLineConfidenceRecalculated(
    tx: Tx,
    args: {
      organizationId: string;
      extractedInvoiceId: string;
      changes: LineConfidenceChange[];
    },
  ): Promise<void>;

  recordContractScored(
    tx: Tx,
    args: {
      organizationId: string;
      extractedInvoiceId: string;
      contractId: string;
      contractedLineNumbers: number[];
      contractFindingCount: number;
      contractFindingCodes: string[];
      contractRateCardHash: string | null;
    },
  ): Promise<void>;

  /** Job-only. */
  recordInvoiceValidated(
    tx: Tx,
    args: {
      organizationId: string;
      extractedInvoiceId: string;
      newReviewStatus: string;
      findingCount: number;
      blocking: boolean;
      vendorMatch: { vendorId: string | null; confidence: string; score: number } | null;
    },
  ): Promise<void>;
}
