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
import { handleExtractContractData } from "./extractContractData";
import { handleCaptureAndEmbedCorrection } from "./captureAndEmbedCorrection";

type Handler<N extends keyof JobPayloads> = (
  job: PgBoss.Job<JobPayloads[N]>,
) => Promise<unknown>;

/**
 * Typecheck-sweep migration to pg-boss v10:
 *   · teamSize → batchSize (same semantics: how many jobs to fetch per
 *     polling cycle).
 *   · teamConcurrency removed by upstream — concurrency is now driven
 *     by batchSize × intra-batch Promise.all in the worker loop.
 *     We preserve the prior throughput by setting batchSize to the
 *     product of the old teamSize × teamConcurrency where appropriate.
 *     Conservative jobs (Tesseract reentrancy in processDocument; LLM
 *     dispatch in extract/briefing) keep batchSize at 1 so they run
 *     one-at-a-time per polling cycle, matching the prior
 *     teamConcurrency: 1 intent.
 */
export const HANDLERS: Array<{
  name: keyof JobPayloads;
  options: PgBoss.WorkOptions;
  handler: Handler<keyof JobPayloads>;
}> = [
  {
    // PR3 — Tesseract.js's worker is not reentrant. batchSize: 1 keeps
    // exactly one job per polling cycle per worker process, replacing
    // the prior teamSize:4, teamConcurrency:1 (which already serialised
    // within the batch via Tesseract's own lock).
    name: JOB.processDocument,
    options: { batchSize: 1 },
    handler: handleProcessDocument as Handler<keyof JobPayloads>,
  },
  {
    // LLM dispatches are expensive — keep visibility to the circuit
    // breaker / quota gate by capping at one in-flight.
    name: JOB.extractInvoiceData,
    options: { batchSize: 1 },
    handler: handleExtractInvoiceData as Handler<keyof JobPayloads>,
  },
  {
    // Validation is pure DB + Zod — batch up to 16 (was teamSize:4 ×
    // teamConcurrency:4) and Promise.all in the worker loop.
    name: JOB.validateExtractedInvoice,
    options: { batchSize: 16 },
    handler: handleValidateExtractedInvoice as Handler<keyof JobPayloads>,
  },
  {
    // CSV/JSON render + S3 upload — moderate batch.
    name: JOB.exportInvoices,
    options: { batchSize: 4 },
    handler: handleExportInvoices as Handler<keyof JobPayloads>,
  },
  {
    // Phase 7 — D1. Advisory-locked per-vendor, so collisions inside a
    // batch resolve via SKIP LOCKED on the recompute lock.
    name: JOB.recomputeVendorProfile,
    options: { batchSize: 8 },
    handler: handleRecomputeVendorProfile as Handler<keyof JobPayloads>,
  },
  {
    // Phase 8 — D2. LLM dispatch — keep batchSize 1 for circuit-breaker
    // visibility, same logic as extractInvoiceData.
    name: JOB.generateBriefingCard,
    options: { batchSize: 1 },
    handler: handleGenerateBriefingCard as Handler<keyof JobPayloads>,
  },
  {
    // Phase 11 — D4. PR17 H-Pool: cap batchSize at the connection-pool
    // budget. The worker pool is max=25 in dev (rawClient.ts) and this
    // is one of three handlers contending for it. 8 keeps a comfortable
    // margin for the request path + validate-extracted-invoice (16).
    name: JOB.assembleEvidencePacket,
    options: { batchSize: 8 },
    handler: handleAssembleEvidencePacket as Handler<keyof JobPayloads>,
  },
  {
    // Phase 9.5 — D3 second half. LLM dispatch — keep batchSize: 1 for
    // circuit-breaker visibility, same logic as extract-invoice-data
    // and generate-briefing-card.
    name: JOB.extractContractData,
    options: { batchSize: 1 },
    handler: handleExtractContractData as Handler<keyof JobPayloads>,
  },
  {
    // Slice 2 — correction capture + Voyage AI embedding. Network-bound
    // (one REST call per job); batchSize 4 keeps enough concurrency to
    // drain a burst of approvals without overwhelming the embedding API.
    name: JOB.captureAndEmbedCorrection,
    options: { batchSize: 4 },
    handler: handleCaptureAndEmbedCorrection as Handler<keyof JobPayloads>,
  },
];
