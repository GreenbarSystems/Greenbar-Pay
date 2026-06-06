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

type Handler<N extends keyof JobPayloads> = (
  job: PgBoss.Job<JobPayloads[N]>,
) => Promise<unknown>;

export const HANDLERS: Array<{
  name: keyof JobPayloads;
  options: PgBoss.WorkOptions;
  handler: Handler<keyof JobPayloads>;
}> = [
  {
    name: JOB.processDocument,
    options: { teamSize: 4, teamConcurrency: 2 },
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
];
