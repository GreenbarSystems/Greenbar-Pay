/**
 * Job handler registry. The worker entrypoint (scripts/worker.ts) iterates
 * this list and calls `boss.work(name, opts, handler)` for each.
 */
import type PgBoss from "pg-boss";
import { JOB, type JobPayloads } from "@/lib/queue";
import { handleProcessDocument } from "./processDocument";
import { handleExtractInvoiceData } from "./extractInvoiceData";
import { handleValidateExtractedInvoice } from "./validateExtractedInvoice";
import { handleExportInvoices } from "./exportInvoices";
import { handleRecomputeVendorProfile } from "./recomputeVendorProfile";
import { handleGenerateBriefingCard } from "./generateBriefingCard";
import { handleAssembleEvidencePacket } from "./assembleEvidencePacket";

type Handler<N extends keyof JobPayloads> = (
  job: PgBoss.Job<JobPayloads[N]>,
) => Promise<unknown>;

export const HANDLERS: Array<{
  name: keyof JobPayloads;
  options: PgBoss.WorkOptions;
  handler: Handler<keyof JobPayloads>;
}> = [
  {
    // PR3 — review #12: teamConcurrency capped at 1. Tesseract.js's worker
    // is not reentrant; with concurrency 2 the second job's worker.recognize
    // could interleave with the first, producing empty extractions or
    // mixed text. teamSize 4 still lets four documents process serially
    // per worker process; bursts queue. A proper Tesseract worker pool is
    // a PR4 perf optimization once we measure real throughput.
    name: JOB.processDocument,
    options: { teamSize: 4, teamConcurrency: 1 },
    handler: handleProcessDocument as Handler<keyof JobPayloads>,
  },
  {
    // Lower concurrency: LLM dispatches are expensive and we want the
    // circuit breaker / quota to see traffic, not a burst spike.
    name: JOB.extractInvoiceData,
    options: { teamSize: 4, teamConcurrency: 1 },
    handler: handleExtractInvoiceData as Handler<keyof JobPayloads>,
  },
  {
    name: JOB.validateExtractedInvoice,
    options: { teamSize: 4, teamConcurrency: 4 },
    handler: handleValidateExtractedInvoice as Handler<keyof JobPayloads>,
  },
  {
    name: JOB.exportInvoices,
    options: { teamSize: 2, teamConcurrency: 2 },
    handler: handleExportInvoices as Handler<keyof JobPayloads>,
  },
  {
    // Phase 7 — D1. Idempotent on vendorId; advisory-locked per-vendor.
    name: JOB.recomputeVendorProfile,
    options: { teamSize: 4, teamConcurrency: 2 },
    handler: handleRecomputeVendorProfile as Handler<keyof JobPayloads>,
  },
  {
    // Phase 8 — D2. Idempotent on extractedInvoiceId; advisory-locked.
    // Low concurrency to keep LLM dispatch traffic visible to the
    // circuit breaker (§2.7), matching extract-invoice-data.
    name: JOB.generateBriefingCard,
    options: { teamSize: 4, teamConcurrency: 1 },
    handler: handleGenerateBriefingCard as Handler<keyof JobPayloads>,
  },
  {
    // Phase 11 — D4. Idempotent via UNIQUE (org, invoiceId); duplicate
    // delivery becomes a no-op INSERT. No LLM dispatch — just a
    // Promise.all snapshot + hash + insert.
    //
    // PR17 H-Pool — teamConcurrency reduced from 4 to 2. The worker
    // pool is sized at max=10 (src/db/internal/rawClient.ts); with
    // validate-extracted-invoice running at 4×4=16 and this job
    // previously also at 4×4=16, an approval burst could push
    // pool demand to ~40 against a 10-connection pool, starving
    // other handlers. The job is I/O-light (a handful of selects
    // + insert), so high concurrency wasn't buying throughput
    // — just contention.
    name: JOB.assembleEvidencePacket,
    options: { teamSize: 4, teamConcurrency: 2 },
    handler: handleAssembleEvidencePacket as Handler<keyof JobPayloads>,
  },
];
