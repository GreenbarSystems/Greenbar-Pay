/**
 * Use case: run all validation for a single (already-loaded-in-tx)
 * extracted invoice. Replaces src/lib/validation/run.ts's
 * `runValidationInTx` — same orchestration, same DB writes, now
 * expressed through repository ports instead of inline Drizzle calls.
 *
 * Called from BOTH validate-extracted-invoice.usecase.ts (the job) AND
 * directly from the PATCH /api/ap/review/:id route (a reviewer edit
 * re-validates in the same transaction) — caller controls the
 * transaction so both can compose with their own edits/audits.
 */
import type { Tx } from "@/db/client";
import {
  blockingPresent,
  validateInvoice,
  type ValidationFinding,
} from "../../domain/engine";
import { matchVendor } from "../../domain/vendor-matching";
import { isRateDrift, scoreLine } from "../../domain/line-scoring";
import { scoreLineAgainstContract } from "../../domain/contract-scoring";
import { detectRemitToDrift, type RemitToDriftResult, type RemitToInfo } from "../../domain/remit-drift";
import { matchAgainstPo, type PoMatchOutput } from "../../domain/po-matching";
import { itemKeyword } from "@/modules/shared/kernel/item-keyword";
import type {
  DocumentRepository,
  InvoiceRepository,
  LineConfidenceChange,
  LineConfidenceUpdate,
  OrgSettingsRepository,
  PoRegisterRepository,
  ValidationAuditRepository,
  ValidationResultsRepository,
  VendorCandidateRepository,
  VendorContractRepository,
  VendorMatchWriteRepository,
} from "../ports";

export interface RunInvoiceValidationDeps {
  invoiceRepository: InvoiceRepository;
  vendorCandidateRepository: VendorCandidateRepository;
  vendorContractRepository: VendorContractRepository;
  documentRepository: DocumentRepository;
  validationResultsRepository: ValidationResultsRepository;
  vendorMatchWriteRepository: VendorMatchWriteRepository;
  auditRepository: ValidationAuditRepository;
  /** Optional — PO matching only runs when this is provided. */
  poRepository?: PoRegisterRepository;
  /** Optional — loads per-org 3-way toggle; falls back to PO_THREE_WAY_ENABLED env var when absent. */
  orgSettingsRepository?: OrgSettingsRepository;
}

export interface RunInvoiceValidationArgs {
  organizationId: string;
  extractedInvoiceId: string;
  documentId: string;
}

export interface RunInvoiceValidationResult {
  findings: ValidationFinding[];
  newReviewStatus: "pending" | "needs_review";
  vendorMatch: {
    vendorId: string | null;
    confidence: "low" | "medium" | "high";
    score: number;
  } | null;
}

export async function runInvoiceValidation(
  tx: Tx,
  deps: RunInvoiceValidationDeps,
  args: RunInvoiceValidationArgs,
): Promise<RunInvoiceValidationResult> {
  // PR3 — review #13: serialize concurrent runs against the same
  // invoice — see InvoiceRepository.lockForValidation for the full
  // rationale (a job retry racing a PATCH revalidation could otherwise
  // both soft-supersede and both insert, leaving two "active" rows).
  await deps.invoiceRepository.lockForValidation(tx, args.extractedInvoiceId);

  // 1. Load the invoice + lines.
  const loaded = await deps.invoiceRepository.findForValidation(
    tx,
    args.organizationId,
    args.extractedInvoiceId,
  );
  if (!loaded) throw new Error(`invoice ${args.extractedInvoiceId} not found`);
  const { invoice, lines } = loaded;

  // 2. Duplicate-check candidate keys (vendor+number, vendor+amount)
  // from every other invoice in the org, approved/exported or still
  // in-flight. See findDuplicateCheckKeys for why in-flight is included.
  const { duplicateKeys: priorDuplicateKeys, amountKeys: priorAmountKeys } =
    await deps.invoiceRepository.findDuplicateCheckKeys(
      tx,
      args.organizationId,
      args.extractedInvoiceId,
    );

  // 3. Vendor match. Phase 7 — include aliases so previously-promoted
  // variant spellings resolve as exact instead of falling through to
  // Jaccard.
  const candidates = await deps.vendorCandidateRepository.findCandidates(
    tx,
    args.organizationId,
  );
  const vm = matchVendor(invoice.vendorName, candidates);

  // 4. Latest extraction text length.
  const textLength = await deps.documentRepository.findLatestExtractionTextLength(
    tx,
    args.documentId,
  );

  // 4b. Phase 9 — D3 + F06: score each line against vendor pricing
  // history. 4c. Phase 9.5 PR3 — score against the active contract.
  // 4d. 2026-07-13 audit F7 — compare remit-to against this vendor's
  // last approved invoice. 4e. PO matching — 2-way / 3-way.
  // None depends on the others — run in parallel.
  const [lineScores, contractScores, remitToDrift, poMatchResult] = await Promise.all([
    scoreLinesAgainstVendorHistory(
      tx,
      deps,
      vm.vendorId,
      lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        description: l.description,
        unitPrice: l.unitPrice === null ? null : Number(l.unitPrice),
      })),
    ),
    scoreLinesAgainstActiveContract(
      tx,
      deps,
      args.organizationId,
      vm.vendorId,
      lines.map((l) => ({
        lineNumber: l.lineNumber,
        description: l.description,
        unitPrice: l.unitPrice === null ? null : Number(l.unitPrice),
        currency: invoice.currency,
      })),
    ),
    checkRemitToDrift(
      tx,
      deps,
      args.organizationId,
      args.extractedInvoiceId,
      vm.vendorId,
      invoice.vendorName,
      { remitToName: invoice.remitToName, remitToAddress: invoice.remitToAddress },
    ),
    runPoMatch(tx, deps, args.organizationId, invoice),
  ]);

  // When a line was contract-adjudicated, suppress the statistical
  // unit_price_drift so the same line doesn't get two findings. The
  // contract finding takes precedence — it's grounded in negotiated
  // rates, not a noisy historical mean.
  const lineFindingsForValidator = contractScores.contractedLineNumbers.size
    ? lineScores.findings.map((f) =>
        contractScores.contractedLineNumbers.has(f.lineNumber)
          ? { ...f, rateDrift: false }
          : f,
      )
    : lineScores.findings;

  // 5. Run the pure validator.
  const findings = validateInvoice({
    invoice: {
      documentType: invoice.documentType,
      vendorName: invoice.vendorName,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      subtotal: invoice.subtotal === null ? null : Number(invoice.subtotal),
      tax: invoice.tax === null ? null : Number(invoice.tax),
      shipping: invoice.shipping === null ? null : Number(invoice.shipping),
      discount: invoice.discount === null ? null : Number(invoice.discount),
      total: invoice.total === null ? null : Number(invoice.total),
      lineItems: lines,
    },
    priorDuplicateKeys,
    priorAmountKeys,
    vendorMatch: vm.vendorId
      ? { confidence: vm.confidence, score: vm.score }
      : null,
    textLength,
    lineScores: lineFindingsForValidator,
  });

  // Phase 9.5 PR3 — fold the contract findings alongside the
  // statistical ones; both land in errors_json and reach the briefing
  // prompt / risk score consumers as just more entries.
  if (contractScores.findings.length > 0) {
    findings.push(...contractScores.findings);
  }

  // 2026-07-13 audit F7 — defense-in-depth against prompt-injected or
  // otherwise fraudulent remit-to fields. See domain/remit-drift.ts.
  if (remitToDrift.changed) {
    findings.push({
      code: "remit_to_changed",
      severity: "warning",
      message:
        "Remit-to name/address differs from this vendor's most recently approved invoice.",
      context: {
        priorRemitToName: remitToDrift.priorRemitToName,
        priorRemitToAddress: remitToDrift.priorRemitToAddress,
        currentRemitToName: invoice.remitToName,
        currentRemitToAddress: invoice.remitToAddress,
      },
    });
  }

  // PO matching — findings participate in the same severity rollup and
  // errors_json as all other finders; the match result goes to its own
  // table after the validation_results INSERT below.
  if (poMatchResult.findings.length > 0) {
    findings.push(...poMatchResult.findings);
  }

  // 5b. PR12 C4 — snapshot prior line-confidence values, write the new
  // ones, and emit a single line_confidence.recalculated audit event
  // when at least one field actually changed. The validation_results
  // row already preserves the findings chain; this preserves the
  // line-level numerical evidence that backs the findings.
  if (lineScores.persistUpdates.length > 0) {
    const lineIds = lineScores.persistUpdates.map((u) => u.lineId);
    const priorRows = await deps.invoiceRepository.findLineConfidenceSnapshots(tx, lineIds);
    const priorById = new Map(priorRows.map((r) => [r.id, r]));
    const changedSnapshots: LineConfidenceChange[] = [];

    await deps.invoiceRepository.updateLineConfidenceBatch(tx, lineScores.persistUpdates);

    for (const u of lineScores.persistUpdates) {
      const prior = priorById.get(u.lineId);
      const after = {
        confidenceScore: u.score,
        confidenceReason: u.reason,
        histSampleCount: u.histSampleCount,
        histAvgPrice: u.histAvgPrice,
        histStddevPrice: u.histStddevPrice,
        stddevDistance: u.stddevDistance,
      };
      const changed =
        !prior ||
        prior.confidenceScore !== after.confidenceScore ||
        prior.histSampleCount !== after.histSampleCount ||
        prior.histAvgPrice !== after.histAvgPrice ||
        prior.histStddevPrice !== after.histStddevPrice ||
        prior.stddevDistance !== after.stddevDistance;

      if (changed && prior) {
        changedSnapshots.push({
          lineId: u.lineId,
          lineNumber: prior.lineNumber,
          before: {
            confidenceScore: prior.confidenceScore,
            confidenceReason: prior.confidenceReason,
            histSampleCount: prior.histSampleCount,
            histAvgPrice: prior.histAvgPrice,
            histStddevPrice: prior.histStddevPrice,
            stddevDistance: prior.stddevDistance,
            recordedAt: prior.updatedAt?.toISOString() ?? null,
          },
          after,
        });
      }
    }

    if (changedSnapshots.length > 0) {
      await deps.auditRepository.recordLineConfidenceRecalculated(tx, {
        organizationId: args.organizationId,
        extractedInvoiceId: args.extractedInvoiceId,
        changes: changedSnapshots,
      });
    }
  }

  // 6. Persist — soft-supersede prior active row(s), then insert fresh.
  await deps.validationResultsRepository.supersedeActive(tx, args.extractedInvoiceId);

  // Phase 9.5 PR3 — audit when the contract validator actually fired.
  // Always emit when an active contract existed for this vendor, even
  // if all lines were within-contract, so the audit chain records that
  // the rule was evaluated.
  if (contractScores.contractId !== null) {
    await deps.auditRepository.recordContractScored(tx, {
      organizationId: args.organizationId,
      extractedInvoiceId: args.extractedInvoiceId,
      contractId: contractScores.contractId,
      contractedLineNumbers: Array.from(contractScores.contractedLineNumbers),
      contractFindingCount: contractScores.findings.length,
      contractFindingCodes: contractScores.findings.map((f) => f.code),
      contractRateCardHash: contractScores.rateCardHash,
    });
  }

  if (findings.length > 0) {
    const hasBlocking = blockingPresent(findings);
    await deps.validationResultsRepository.insert(tx, {
      organizationId: args.organizationId,
      extractedInvoiceId: args.extractedInvoiceId,
      passed: !hasBlocking,
      severity: hasBlocking ? "blocking" : "warning",
      errorsJson: findings,
    });
  } else {
    await deps.validationResultsRepository.insert(tx, {
      organizationId: args.organizationId,
      extractedInvoiceId: args.extractedInvoiceId,
      passed: true,
      severity: "warning", // placeholder; column is NOT NULL
      errorsJson: [],
    });
  }

  // 7a. PO match result — separate table (FK to purchase_orders for
  // receipt confirmation and history queries). Only written when a PO
  // number appeared on the invoice or a match was attempted.
  if (poMatchResult.status !== "no_po_number" && deps.poRepository) {
    const invoiceTotal = invoice.total === null ? null : Number(invoice.total);
    await deps.poRepository.upsertMatchResult(tx, {
      organizationId: args.organizationId,
      extractedInvoiceId: args.extractedInvoiceId,
      purchaseOrderId: poMatchResult.purchaseOrderId,
      matchType: poMatchResult.matchType,
      status: poMatchResult.status,
      invoiceTotal: invoiceTotal === null ? null : invoiceTotal.toFixed(2),
      poTotal: poMatchResult.poTotal === null ? null : poMatchResult.poTotal.toFixed(2),
      variancePct: poMatchResult.variancePct === null ? null : poMatchResult.variancePct.toFixed(4),
      lineVariancesJson: poMatchResult.lineVariances ?? null,
    });
  }

  // 7b. Vendor match row (append-only — keeps the candidate history visible).
  await deps.vendorMatchWriteRepository.insert(tx, {
    organizationId: args.organizationId,
    extractedInvoiceId: args.extractedInvoiceId,
    vendorId: vm.vendorId,
    matchConfidence: vm.confidence,
    matchScore: vm.score,
    matchMethod: vm.method,
    candidatesJson: vm.candidates,
  });

  return {
    findings,
    newReviewStatus: blockingPresent(findings) ? "needs_review" : "pending",
    vendorMatch: {
      vendorId: vm.vendorId,
      confidence: vm.confidence,
      score: vm.score,
    },
  };
}

/**
 * Phase 9 — D3 + F06: pull active vendor_pricing_history rows for each
 * keyword present on the invoice's line items, score each line, and
 * return (a) the score input the validator needs and (b) the per-line
 * update set to persist on extracted_invoice_lines.
 *
 * Returns empty arrays when there's no resolved vendor. The line-item
 * confidence column then stays NULL — the UI renders "—" rather than a
 * misleading score.
 */
async function scoreLinesAgainstVendorHistory(
  tx: Tx,
  deps: RunInvoiceValidationDeps,
  vendorId: string | null,
  lines: Array<{
    id: string;
    lineNumber: number | null;
    description: string | null;
    unitPrice: number | null;
  }>,
): Promise<{
  findings: NonNullable<Parameters<typeof validateInvoice>[0]["lineScores"]>;
  persistUpdates: LineConfidenceUpdate[];
}> {
  if (!vendorId || lines.length === 0) {
    return { findings: [], persistUpdates: [] };
  }

  const keywords = new Set<string>();
  const linesWithKeyword = lines.map((l) => {
    const kw = itemKeyword(l.description);
    if (kw) keywords.add(kw);
    return { ...l, keyword: kw };
  });
  if (keywords.size === 0) {
    return { findings: [], persistUpdates: [] };
  }

  const statsByKeyword = await deps.vendorCandidateRepository.findPricingStatsForKeywords(
    tx,
    vendorId,
    Array.from(keywords),
  );

  const findings: NonNullable<
    Parameters<typeof validateInvoice>[0]["lineScores"]
  > = [];
  const persistUpdates: LineConfidenceUpdate[] = [];

  for (const l of linesWithKeyword) {
    if (l.unitPrice === null) continue;
    const stats = l.keyword ? statsByKeyword.get(l.keyword) ?? null : null;
    const result = scoreLine({ unitPrice: l.unitPrice }, stats);
    if (!result) continue;

    const lineNumber = l.lineNumber ?? 0;
    // PR10 C1: drift gate is no longer coupled to scoreLine — the
    // sample-count constants now actually mean what they say.
    const drift = stats !== null && isRateDrift(l.unitPrice, stats);

    findings.push({
      lineNumber,
      keyword: l.keyword,
      score: result.score,
      rateDrift: drift,
      unitPrice: l.unitPrice,
      historyAvg: stats?.avgUnitPrice ?? null,
      stddevDistance: result.stddevDistance,
    });

    persistUpdates.push({
      lineId: l.id,
      score: result.score,
      reason: result.reason,
      histSampleCount: stats?.sampleCount ?? null,
      histAvgPrice: stats === null ? null : stats.avgUnitPrice.toFixed(4),
      histStddevPrice:
        stats === null || stats.stddevUnitPrice === null
          ? null
          : stats.stddevUnitPrice.toFixed(4),
      stddevDistance:
        result.stddevDistance === null ? null : result.stddevDistance.toFixed(2),
    });
  }

  return { findings, persistUpdates };
}

/**
 * 2026-07-13 audit F7 — only look up a drift baseline once the vendor
 * matcher has resolved a real vendor (vm.vendorId !== null); a low/no
 * match means there's no reliable "this vendor's history" to compare
 * against in the first place. detectRemitToDrift itself is null-safe
 * (no prior invoice → never "changed"), so this only adds the "don't
 * even query" short-circuit for the no-vendor-match case.
 */
async function checkRemitToDrift(
  tx: Tx,
  deps: RunInvoiceValidationDeps,
  organizationId: string,
  extractedInvoiceId: string,
  vendorId: string | null,
  vendorName: string | null,
  current: RemitToInfo,
): Promise<RemitToDriftResult> {
  if (!vendorId || !vendorName) {
    return { changed: false, priorRemitToName: null, priorRemitToAddress: null };
  }
  const prior = await deps.invoiceRepository.findLatestApprovedRemitTo(
    tx,
    organizationId,
    vendorName,
    extractedInvoiceId,
  );
  return detectRemitToDrift(current, prior);
}

/**
 * Phase 9.5 PR3 — load the vendor's currently-active contract (if any)
 * plus its rate-card lines, then score each invoice line against it
 * via the pure scoreLineAgainstContract helper.
 */
async function scoreLinesAgainstActiveContract(
  tx: Tx,
  deps: RunInvoiceValidationDeps,
  organizationId: string,
  vendorId: string | null,
  lines: Array<{
    lineNumber: number | null;
    description: string | null;
    unitPrice: number | null;
    currency: string | null;
  }>,
): Promise<{
  findings: ValidationFinding[];
  contractedLineNumbers: Set<number>;
  contractId: string | null;
  rateCardHash: string | null;
}> {
  if (!vendorId || lines.length === 0) {
    return {
      findings: [],
      contractedLineNumbers: new Set(),
      contractId: null,
      rateCardHash: null,
    };
  }

  const active = await deps.vendorContractRepository.findActiveContractWithLines(
    tx,
    organizationId,
    vendorId,
  );
  if (!active) {
    return {
      findings: [],
      contractedLineNumbers: new Set(),
      contractId: null,
      rateCardHash: null,
    };
  }

  if (active.lines.length === 0) {
    return {
      findings: [],
      contractedLineNumbers: new Set(),
      contractId: active.contractId,
      rateCardHash: active.rateCardHash,
    };
  }

  const findings: ValidationFinding[] = [];
  const contractedLineNumbers = new Set<number>();
  for (const l of lines) {
    if (l.unitPrice === null) continue;
    const kw = itemKeyword(l.description);
    const scored = scoreLineAgainstContract(
      {
        lineNumber: l.lineNumber,
        invoiceKeyword: kw,
        invoiceUnitPrice: l.unitPrice,
        invoiceCurrency: l.currency,
      },
      active.lines,
    );
    if (!scored) continue;
    findings.push(scored.finding);
    if (l.lineNumber !== null) {
      contractedLineNumbers.add(l.lineNumber);
    }
  }

  return {
    findings,
    contractedLineNumbers,
    contractId: active.contractId,
    rateCardHash: active.rateCardHash,
  };
}

/**
 * PO matching — load the PO from the register (if a number was extracted)
 * and run the pure matchAgainstPo domain function.
 *
 * Per-org `poThreeWayEnabled` (organizations table) controls 3-way mode.
 * The global `PO_THREE_WAY_ENABLED` env var overrides the per-org setting
 * when set to "true" (deploy-level override; useful for testing or staged rollout).
 */
async function runPoMatch(
  tx: Tx,
  deps: RunInvoiceValidationDeps,
  organizationId: string,
  invoice: { purchaseOrderNumber: string | null; total: string | null },
): Promise<PoMatchOutput> {
  const envOverride = process.env.PO_THREE_WAY_ENABLED === "true";
  const threeWayEnabled =
    envOverride ||
    (deps.orgSettingsRepository
      ? await deps.orgSettingsRepository.findPoThreeWayEnabled(tx, organizationId)
      : false);
  const poNumber = invoice.purchaseOrderNumber;

  if (!poNumber || !deps.poRepository) {
    return {
      findings: [],
      matchType: null,
      status: "no_po_number",
      purchaseOrderId: null,
      poTotal: null,
      variancePct: null,
      lineVariances: null,
    };
  }

  const po = await deps.poRepository.findByPoNumber(tx, organizationId, poNumber);

  return matchAgainstPo({
    poNumber,
    invoiceTotal: invoice.total === null ? 0 : Number(invoice.total),
    po,
    threeWayEnabled,
  });
}
