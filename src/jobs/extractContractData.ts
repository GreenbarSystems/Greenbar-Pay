/**
 * Phase 9.5 — extract-contract-data — D3 second half.
 *
 * Mirrors extract-invoice-data's shape:
 *   1. Load doc + latest extraction
 *   2. Dispatch the contract LLM extraction (gateway in lib/llm)
 *   3. Persist outcome:
 *      - succeeded → INSERT vendor_contract + vendor_contract_lines
 *        (with itemKeyword() pre-normalized for future matching),
 *        advance documents.status to llm_extracted
 *      - failed kinds → record on llm_runs + set vendor_contract status
 *        to 'failed' and documents.status to 'validation_failed' so an
 *        operator can see and re-run
 *
 * Single contract row per (doc, run) — contracts are append-only via
 * supersededAt. A re-extract of the same document will create a new
 * vendor_contracts row; activation logic in a future PR will decide
 * which is canonical for matching.
 */
import type PgBoss from "pg-boss";
import { desc, eq } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import {
  documents,
  documentExtractions,
  llmRuns,
  vendorContracts,
  vendorContractLines,
  auditEvents,
} from "@/db/schema";
import { storage } from "@/lib/storage";
import {
  dispatchContractExtraction,
  MAX_INPUT_CHARS,
  type DispatchOutcome,
  type ContractExtractionResult,
} from "@/lib/llm";
import { scrub, scrubError } from "@/lib/llm/scrub";
import { itemKeyword } from "@/jobs/recomputeVendorProfile";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

export async function handleExtractContractData(
  job: PgBoss.Job<JobPayloads[typeof JOB.extractContractData]>,
): Promise<void> {
  const { documentId, organizationId } = job.data;

  // ── 1. Load doc + latest extraction. The 'kind' column was verified
  //       upstream by process-document — we don't re-check here. If a
  //       caller mis-dispatches a non-contract doc we still persist a
  //       contract row, but with low confidence + a warning.
  const setup = await withOrgAsWorker(organizationId, async (tx) => {
    const doc = await tx.query.documents.findFirst({
      where: (d, { and, eq }) =>
        and(eq(d.id, documentId), eq(d.organizationId, organizationId)),
      columns: {
        id: true,
        status: true,
        mimeType: true,
        pageCount: true,
        kind: true,
      },
    });
    if (!doc) return { kind: "missing_doc" as const };

    const latest = await tx
      .select({
        rawTextStorageKey: documentExtractions.rawTextStorageKey,
        textLength: documentExtractions.textLength,
      })
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, documentId))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1);

    if (!latest[0]) return { kind: "no_extraction" as const };

    return {
      kind: "ready" as const,
      doc,
      extraction: latest[0],
    };
  });

  if (setup.kind === "missing_doc") {
    console.warn(`[extract-contract-data] doc=${documentId} missing; skipping`);
    return;
  }
  if (setup.kind === "no_extraction") {
    throw new Error(`no document_extractions row for ${documentId}`);
  }

  const { doc, extraction } = setup;

  // ── 2. Load raw text
  const textBuf = await storage.getObject(extraction.rawTextStorageKey);
  const documentText = textBuf.toString("utf8");

  const mimeType = doc.mimeType ?? "application/octet-stream";
  const pageCount = doc.pageCount ?? null;

  // ── 3. Dispatch
  const outcome = await dispatchContractExtraction({
    organizationId,
    documentText,
    mimeType,
    pageCount,
  });

  // ── 4. Persist outcome
  await persistOutcome(organizationId, documentId, outcome, documentText.length);
}

async function persistOutcome(
  organizationId: string,
  documentId: string,
  outcome: DispatchOutcome<ContractExtractionResult>,
  charCount: number,
): Promise<void> {
  await withOrgAsWorker(organizationId, async (tx) => {
    const meta = outcome.meta;

    // Common llm_runs row fields. scrubError on every error path so
    // vendor strings / line-item text can't leak into llm_runs.error_
    // message (§2.4).
    const runStatus = mapOutcomeToRunStatus(outcome);
    const errorMessage =
      outcome.kind === "schema_failed"
        ? "schema validation failed after retry"
        : outcome.kind === "provider_error"
          ? scrubError(outcome.error).message.slice(0, 500)
          : outcome.kind === "non_compliant_model"
            ? `non_compliant_model: ${scrubError(outcome.error).message.slice(0, 300)}`
            : outcome.kind === "text_too_large"
              ? `input ${charCount} chars exceeds max ${MAX_INPUT_CHARS}`
              : outcome.kind === "quota_exceeded"
                ? "daily quota exhausted"
                : outcome.kind === "circuit_open"
                  ? "provider circuit open"
                  : null;

    const [run] = await tx
      .insert(llmRuns)
      .values({
        organizationId,
        documentId,
        provider: meta.modelId.split(":")[0],
        model: meta.modelId,
        promptName: meta.promptName,
        promptVersion: meta.promptVersion,
        inputHash: "inputHash" in meta ? meta.inputHash : null,
        inputTokensEstimate:
          "inputTokensEstimate" in meta ? meta.inputTokensEstimate : null,
        outputJson: outcome.kind === "succeeded" ? outcome.result : null,
        status: runStatus,
        errorMessage,
        durationMs: "durationMs" in meta ? meta.durationMs : null,
      })
      .returning({ id: llmRuns.id });

    if (outcome.kind === "succeeded") {
      const r = outcome.result;

      // Header row. vendorId stays NULL — bootstrap + activation are
      // out-of-scope for this PR.
      const [contract] = await tx
        .insert(vendorContracts)
        .values({
          organizationId,
          documentId,
          llmRunId: run.id,
          contractNumber: r.contractNumber,
          effectiveDate: r.effectiveDate,
          expiryDate: r.expiryDate,
          paymentTerms: r.paymentTerms,
          currency: r.currency,
          earlyPaymentDiscountPct:
            r.earlyPaymentDiscountPct === null
              ? null
              : String(r.earlyPaymentDiscountPct),
          earlyPaymentDiscountDays: r.earlyPaymentDiscountDays,
          status: "extracted",
          confidence: r.confidence,
          warningsJson: r.warnings,
        })
        .returning({ id: vendorContracts.id });

      if (r.lineItems.length > 0) {
        // Pre-normalize via itemKeyword() so a future contract→invoice
        // line match is a single indexed equality. NULL is acceptable
        // — descriptions that yield no meaningful keyword (e.g. "Misc")
        // just don't participate in matching.
        await tx.insert(vendorContractLines).values(
          r.lineItems.map((li) => ({
            organizationId,
            contractId: contract.id,
            description: li.description,
            itemKeyword: itemKeyword(li.description),
            unitPrice: li.unitPrice === null ? null : String(li.unitPrice),
            currency: li.currency,
            priceBasis: li.priceBasis,
            minQuantity:
              li.minQuantity === null ? null : String(li.minQuantity),
            maxQuantity:
              li.maxQuantity === null ? null : String(li.maxQuantity),
            notes: li.notes,
          })),
        );
      }

      await tx
        .update(documents)
        .set({ status: "llm_extracted" })
        .where(eq(documents.id, documentId));

      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "worker",
        action: "contract.extracted",
        entityType: "document",
        entityId: documentId,
        metadataJson: {
          contractId: contract.id,
          lineCount: r.lineItems.length,
          confidence: r.confidence,
          warningsCount: r.warnings.length,
          // Phase 9.5 — keep vendor name in scrubbed metadata to help
          // an operator route the contract to a vendor later. scrub()
          // strips obvious PII patterns; the vendor name is the
          // primary linkage field so we leave it readable.
          vendorName: scrub(r.vendorName ?? ""),
        },
      });
      return;
    }

    // Failure paths — record on the doc + audit so an operator sees it.
    await tx
      .insert(vendorContracts)
      .values({
        organizationId,
        documentId,
        llmRunId: run.id,
        status: "failed",
        warningsJson: errorMessage ? [errorMessage] : [],
      });

    await tx
      .update(documents)
      .set({ status: "validation_failed" })
      .where(eq(documents.id, documentId));

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "contract.extraction_failed",
      entityType: "document",
      entityId: documentId,
      metadataJson: {
        kind: outcome.kind,
        message: errorMessage,
      },
    });
  });
}

function mapOutcomeToRunStatus(
  outcome: DispatchOutcome<ContractExtractionResult>,
): "succeeded" | "schema_failed" | "provider_error" | "text_too_large" | "quota_exceeded" | "circuit_open" {
  switch (outcome.kind) {
    case "succeeded":
      return "succeeded";
    case "schema_failed":
      return "schema_failed";
    case "provider_error":
      return "provider_error";
    case "text_too_large":
      return "text_too_large";
    case "quota_exceeded":
      return "quota_exceeded";
    case "circuit_open":
      return "circuit_open";
    case "non_compliant_model":
      return "provider_error";
    default:
      throw new Error(
        `unhandled DispatchOutcome kind: ${(outcome as { kind: string }).kind}`,
      );
  }
}

