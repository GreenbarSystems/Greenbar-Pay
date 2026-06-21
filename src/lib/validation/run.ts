/**
 * Shared validation runner. Called from:
 *   - validate-extracted-invoice job (post-LLM-extraction)
 *   - PATCH /api/ap/review/:id (after a reviewer edits a field)
 *
 * Owns the DB I/O around the pure `validateInvoice()` engine:
 *   - load extracted invoice + lines + latest extraction text length;
 *   - load prior-approved (vendor, invoice_number) pairs for duplicate check;
 *   - load vendor candidates and run matchVendor();
 *   - SOFT-supersede prior validation_results (UPDATE … SET superseded_at)
 *     so the evidence chain stays intact (PR2);
 *   - insert fresh rows.
 *
 * Returns the findings so the caller can decide review_status transitions.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  extractedInvoices,
  extractedInvoiceLines,
  documentExtractions,
  vendors,
  vendorMatches,
  vendorPricingHistory,
  vendorContracts,
  vendorContractLines,
  validationResults,
  auditEvents,
} from "@/db/schema";
import { desc } from "drizzle-orm";
import {
  validateInvoice,
  blockingPresent,
  duplicateKey,
  type ValidationFinding,
} from ".";
import { matchVendor } from "./vendor-match";
import { scoreLine, isRateDrift, type LinePricingStats } from "./line-score";
import {
  scoreLineAgainstContract,
  type ContractLineMatch,
} from "./contract-score";
import { itemKeyword } from "@/jobs/recomputeVendorProfile";

export interface RunValidationResult {
  findings: ValidationFinding[];
  newReviewStatus: "pending" | "needs_review";
  vendorMatch: {
    vendorId: string | null;
    confidence: "low" | "medium" | "high";
    score: number;
  } | null;
}

/**
 * Runs all validation for a single (already-loaded-in-tx) extracted
 * invoice. Caller controls the transaction so we can compose with edits.
 */
export async function runValidationInTx(
  tx: Tx,
  args: {
    organizationId: string;
    extractedInvoiceId: string;
    documentId: string;
  },
): Promise<RunValidationResult> {
  // PR3 — review #13: serialize concurrent runs against the same invoice.
  //
  // A validate-extracted-invoice job retry can race a PATCH-triggered
  // revalidation. Both would soft-supersede (no rows match) → both
  // insert → two "active" rows for one entity, with the approve route
  // picking the more recent by created_at. With same-millisecond
  // timestamps the tie-breaker is undefined.
  //
  // pg_advisory_xact_lock holds the lock until the transaction commits
  // or rolls back, so the second tx blocks at this point and processes
  // the row only AFTER the first tx's INSERT + UPDATE land. Keyed on
  // the hash of the entity UUID so distinct invoices don't contend.
  //
  // hashtextextended takes a bigint salt; 0 is fine since the key
  // space is per-entity-UUID and collisions across invoices only mean
  // serialization, never correctness loss.
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended('validation:' || ${args.extractedInvoiceId}::text, 0)
    )
  `);

  // 1. Load the invoice + lines.
  const [invoice] = await tx
    .select()
    .from(extractedInvoices)
    .where(
      and(
        eq(extractedInvoices.id, args.extractedInvoiceId),
        eq(extractedInvoices.organizationId, args.organizationId),
      ),
    )
    .limit(1);
  if (!invoice) throw new Error(`invoice ${args.extractedInvoiceId} not found`);

  const lines = await tx
    .select()
    .from(extractedInvoiceLines)
    .where(eq(extractedInvoiceLines.extractedInvoiceId, args.extractedInvoiceId));

  // 2. Prior approved/exported (vendor, invoice_number) pairs for dedup.
  //
  // We select id explicitly so the self-exclusion filter below actually
  // compares uuid-to-uuid. The earlier version omitted id from the
  // projection, making `r.id !== args.extractedInvoiceId` an
  // `undefined !== uuid` test that always passed.
  const priorRows = await tx
    .select({
      id: extractedInvoices.id,
      vendorName: extractedInvoices.vendorName,
      invoiceNumber: extractedInvoices.invoiceNumber,
    })
    .from(extractedInvoices)
    .where(
      and(
        eq(extractedInvoices.organizationId, args.organizationId),
        inArray(extractedInvoices.reviewStatus, ["approved", "exported"]),
      ),
    );
  const priorApprovedKeys = new Set(
    priorRows
      .filter((r) => r.vendorName && r.invoiceNumber && r.id !== args.extractedInvoiceId)
      .map((r) => duplicateKey(r.vendorName!, r.invoiceNumber!)),
  );

  // 3. Vendor match. Phase 7 — include aliases so previously-promoted
  // variant spellings resolve as exact instead of falling through to
  // Jaccard.
  const candidates = await tx
    .select({
      id: vendors.id,
      name: vendors.name,
      normalizedName: vendors.normalizedName,
      aliases: vendors.aliases,
    })
    .from(vendors)
    .where(eq(vendors.organizationId, args.organizationId));
  const vm = matchVendor(invoice.vendorName, candidates);

  // 4. Latest extraction text length.
  const [latestExtraction] = await tx
    .select({ textLength: documentExtractions.textLength })
    .from(documentExtractions)
    .where(eq(documentExtractions.documentId, args.documentId))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);

  // 4b. Phase 9 — D3 + F06: load vendor pricing stats for each keyword
  // present in the line items, then score each line. Skip when there's
  // no resolved vendor — we have no per-keyword history to compare to.
  // 4c. Phase 9.5 PR3 — score lines against the vendor's active
  // contract (D3 second half). Done in parallel with the statistical
  // pass — neither depends on the other.
  const [lineScores, contractScores] = await Promise.all([
    scoreLinesAgainstVendorHistory(
      tx,
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
      vm.vendorId,
      lines.map((l) => ({
        lineNumber: l.lineNumber,
        description: l.description,
        unitPrice: l.unitPrice === null ? null : Number(l.unitPrice),
        currency: invoice.currency,
      })),
    ),
  ]);

  // When a line was contract-adjudicated, suppress the statistical
  // unit_price_drift so the same line doesn't get two findings (and
  // the briefing card doesn't double-weight the same signal). The
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
    priorApprovedKeys,
    vendorMatch: vm.vendorId
      ? { confidence: vm.confidence, score: vm.score }
      : null,
    textLength: latestExtraction?.textLength ?? null,
    lineScores: lineFindingsForValidator,
  });

  // Phase 9.5 PR3 — fold the contract findings into the result. They
  // sit alongside the statistical findings; the briefing card prompt
  // and risk score consumers see them as just more entries in
  // errors_json. The withinContract info-level entries provide
  // positive lineage that the rule fired at all.
  if (contractScores.findings.length > 0) {
    findings.push(...contractScores.findings);
  }

  // 5b. PR12 C4 — per-line confidence used to be a bare in-place UPDATE,
  // which silently destroyed the evidence that supported any previously
  // active briefing card. We now snapshot the prior values, write the
  // new ones with a DB-clock updated_at marker, and emit a single
  // `line_confidence.recalculated` audit event when at least one field
  // actually changed. The validation_results row already preserves the
  // findings chain; this preserves the line-level numerical evidence
  // that backs the findings.
  if (lineScores.persistUpdates.length > 0) {
    const lineIds = lineScores.persistUpdates.map((u) => u.lineId);
    const priorRows = await tx
      .select({
        id: extractedInvoiceLines.id,
        lineNumber: extractedInvoiceLines.lineNumber,
        confidenceScore: extractedInvoiceLines.confidenceScore,
        confidenceReason: extractedInvoiceLines.confidenceReason,
        histSampleCount: extractedInvoiceLines.histSampleCount,
        histAvgPrice: extractedInvoiceLines.histAvgPrice,
        histStddevPrice: extractedInvoiceLines.histStddevPrice,
        stddevDistance: extractedInvoiceLines.stddevDistance,
        updatedAt: extractedInvoiceLines.updatedAt,
      })
      .from(extractedInvoiceLines)
      .where(inArray(extractedInvoiceLines.id, lineIds));
    const priorById = new Map(priorRows.map((r) => [r.id, r]));
    const changedSnapshots: Array<{
      lineId: string;
      lineNumber: number | null;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }> = [];

    // PR18 C4 — batch the per-line confidence writes into one CASE
    // UPDATE. The prior loop issued one round trip per line inside
    // the user-facing validation tx (PATCH path), so a 30-line
    // invoice serialized 30 RTs (~300ms felt latency on a managed
    // DB). The CASE form collapses to one round trip while preserving
    // the per-line UPDATE semantics.
    //
    // Build CASE expressions inline. Per-value bindings go through the
    // sql tag — only the static column name and CASE keyword reach
    // sql.raw, both of which are hard-coded literals.
    const caseExpr = (
      column: string,
      pick: (u: PersistLineUpdate) => unknown,
    ) => {
      const chunks = lineScores.persistUpdates.map(
        (u) => sql`WHEN ${u.lineId}::uuid THEN ${pick(u)}`,
      );
      return sql.join(
        [sql.raw(`CASE ${column}`), ...chunks, sql.raw("END")],
        sql.raw(" "),
      );
    };

    await tx
      .update(extractedInvoiceLines)
      .set({
        confidenceScore: caseExpr("id", (u) => u.score),
        confidenceReason: caseExpr("id", (u) => u.reason),
        histSampleCount: caseExpr("id", (u) => u.histSampleCount),
        histAvgPrice: caseExpr("id", (u) => u.histAvgPrice),
        histStddevPrice: caseExpr("id", (u) => u.histStddevPrice),
        stddevDistance: caseExpr("id", (u) => u.stddevDistance),
        updatedAt: sql`now()`,
      })
      .where(inArray(extractedInvoiceLines.id, lineIds));

    // Then derive the changed snapshots from priorById + persistUpdates
    // for the audit event. No DB I/O — pure JS.
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
      await tx.insert(auditEvents).values({
        organizationId: args.organizationId,
        actorType: "worker",
        action: "line_confidence.recalculated",
        entityType: "extracted_invoice",
        entityId: args.extractedInvoiceId,
        metadataJson: {
          // The structured before/after carries the pre-edit numerical
          // evidence that any prior briefing card was generated from.
          // Phase 11's evidence packet joins by extractedInvoiceId to
          // reconstruct the full lineage. Numbers here are sanctioned —
          // same pattern as validation_results.errors_json.
          changes: changedSnapshots,
        },
      });
    }
  }

  // 6. Persist — soft-supersede prior active row(s), then insert fresh.
  //    PR2: hard DELETE destroyed prior-blocking evidence (review #4).
  //    The active view is WHERE superseded_at IS NULL (indexed).
  await tx
    .update(validationResults)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        eq(validationResults.entityType, "extracted_invoice"),
        eq(validationResults.entityId, args.extractedInvoiceId),
        isNull(validationResults.supersededAt),
      ),
    );

  // Phase 9.5 PR3 — audit when the contract validator actually
  // fired. Always emit when an active contract existed for this
  // vendor, even if all lines were within-contract, so the audit
  // chain records that the rule was evaluated. The contractId is
  // null when no active contract exists; in that case we don't
  // bother emitting.
  if (contractScores.contractId !== null) {
    await tx.insert(auditEvents).values({
      organizationId: args.organizationId,
      actorType: "worker",
      action: "validation.contract_scored",
      entityType: "extracted_invoice",
      entityId: args.extractedInvoiceId,
      metadataJson: {
        contractId: contractScores.contractId,
        contractedLineNumbers: Array.from(
          contractScores.contractedLineNumbers,
        ),
        contractFindingCount: contractScores.findings.length,
        contractFindingCodes: contractScores.findings.map((f) => f.code),
      },
    });
  }

  if (findings.length > 0) {
    const hasBlocking = blockingPresent(findings);
    await tx.insert(validationResults).values({
      organizationId: args.organizationId,
      entityType: "extracted_invoice",
      entityId: args.extractedInvoiceId,
      passed: !hasBlocking,
      severity: hasBlocking ? "blocking" : "warning",
      errorsJson: findings,
    });
  } else {
    await tx.insert(validationResults).values({
      organizationId: args.organizationId,
      entityType: "extracted_invoice",
      entityId: args.extractedInvoiceId,
      passed: true,
      severity: "warning", // placeholder; column is NOT NULL
      errorsJson: [],
    });
  }

  // 7. Vendor match row (append-only — keeps the candidate history visible).
  await tx.insert(vendorMatches).values({
    organizationId: args.organizationId,
    extractedInvoiceId: args.extractedInvoiceId,
    vendorId: vm.vendorId,
    matchConfidence: vm.confidence,
    matchScore: String(vm.score),
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
interface PersistLineUpdate {
  lineId: string;
  score: "high" | "medium" | "low" | "new";
  reason: string;
  histSampleCount: number | null;
  histAvgPrice: string | null;
  histStddevPrice: string | null;
  stddevDistance: string | null;
}

async function scoreLinesAgainstVendorHistory(
  tx: Tx,
  vendorId: string | null,
  lines: Array<{
    id: string;
    lineNumber: number | null;
    description: string | null;
    unitPrice: number | null;
  }>,
): Promise<{
  findings: NonNullable<Parameters<typeof validateInvoice>[0]["lineScores"]>;
  persistUpdates: PersistLineUpdate[];
}> {
  if (!vendorId || lines.length === 0) {
    return { findings: [], persistUpdates: [] };
  }

  // Collect unique keywords needed this run. Pull all active stats rows
  // for the vendor in one query, then build a per-keyword lookup. This
  // is fewer round-trips than scoring line-by-line and the row count is
  // bounded by the per-vendor keyword cap.
  const keywords = new Set<string>();
  const linesWithKeyword = lines.map((l) => {
    const kw = itemKeyword(l.description);
    if (kw) keywords.add(kw);
    return { ...l, keyword: kw };
  });
  if (keywords.size === 0) {
    return { findings: [], persistUpdates: [] };
  }

  const statRows = await tx
    .select({
      itemKeyword: vendorPricingHistory.itemKeyword,
      avgUnitPrice: vendorPricingHistory.avgUnitPrice,
      stddevUnitPrice: vendorPricingHistory.stddevUnitPrice,
      samples: vendorPricingHistory.samples,
    })
    .from(vendorPricingHistory)
    .where(
      and(
        eq(vendorPricingHistory.vendorId, vendorId),
        isNull(vendorPricingHistory.supersededAt),
        inArray(vendorPricingHistory.itemKeyword, Array.from(keywords)),
      ),
    );

  const statsByKeyword = new Map<string, LinePricingStats>();
  for (const r of statRows) {
    statsByKeyword.set(r.itemKeyword, {
      sampleCount: r.samples,
      avgUnitPrice: Number(r.avgUnitPrice),
      stddevUnitPrice:
        r.stddevUnitPrice === null ? null : Number(r.stddevUnitPrice),
    });
  }

  const findings: NonNullable<
    Parameters<typeof validateInvoice>[0]["lineScores"]
  > = [];
  const persistUpdates: PersistLineUpdate[] = [];

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
        result.stddevDistance === null
          ? null
          : result.stddevDistance.toFixed(2),
    });
  }

  return { findings, persistUpdates };
}

/**
 * Phase 9.5 PR3 — load the vendor's currently-active contract (if any)
 * plus its rate-card lines, then score each invoice line against it
 * via the pure scoreLineAgainstContract helper.
 *
 * Returns:
 *   · `findings` — ValidationFinding[] to merge into the main result
 *   · `contractedLineNumbers` — Set used by the caller to suppress the
 *     statistical `unit_price_drift` finding for any line the contract
 *     already adjudicated. Statistical history is the fallback, not a
 *     stacking signal.
 *   · `contractId` — the active contract id; null when none exists.
 *     Used downstream for the contract.findings_emitted audit event.
 */
async function scoreLinesAgainstActiveContract(
  tx: Tx,
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
}> {
  if (!vendorId || lines.length === 0) {
    return { findings: [], contractedLineNumbers: new Set(), contractId: null };
  }

  const [contract] = await tx
    .select({ id: vendorContracts.id })
    .from(vendorContracts)
    .where(
      and(
        eq(vendorContracts.vendorId, vendorId),
        eq(vendorContracts.status, "active"),
        isNull(vendorContracts.supersededAt),
      ),
    )
    .limit(1);

  if (!contract) {
    return { findings: [], contractedLineNumbers: new Set(), contractId: null };
  }

  // Pull the relevant subset of contract lines — only those with a
  // non-null itemKeyword (lines without one can't match) AND whose
  // unitPrice is set (a line declaring "Quoted per project" carries
  // no actionable rate).
  const contractLineRows = await tx
    .select({
      itemKeyword: vendorContractLines.itemKeyword,
      unitPrice: vendorContractLines.unitPrice,
      currency: vendorContractLines.currency,
      priceBasis: vendorContractLines.priceBasis,
    })
    .from(vendorContractLines)
    .where(eq(vendorContractLines.contractId, contract.id));

  const contractLines: ContractLineMatch[] = [];
  for (const row of contractLineRows) {
    if (row.itemKeyword === null || row.unitPrice === null) continue;
    contractLines.push({
      itemKeyword: row.itemKeyword,
      unitPrice: Number(row.unitPrice),
      currency: row.currency,
      priceBasis: row.priceBasis,
    });
  }

  if (contractLines.length === 0) {
    return {
      findings: [],
      contractedLineNumbers: new Set(),
      contractId: contract.id,
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
      contractLines,
    );
    if (!scored) continue;
    findings.push(scored.finding);
    if (l.lineNumber !== null) {
      contractedLineNumbers.add(l.lineNumber);
    }
  }

  return { findings, contractedLineNumbers, contractId: contract.id };
}
