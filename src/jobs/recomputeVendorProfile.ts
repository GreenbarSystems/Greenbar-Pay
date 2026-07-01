/**
 * recompute-vendor-profile job (Phase 7 — D1).
 *
 * Trigger: enqueued by the approve handler after every successful
 * approval. All business logic (aggregation, pricing-keyword grouping,
 * duplicate-submission counting) lives in
 * src/modules/vendors/application/use-cases/recompute-vendor-profile.usecase.ts
 * — this file is just the pg-boss adapter: unwrap the payload, open the
 * worker transaction, call the use case.
 */
import type PgBoss from "pg-boss";
import { withOrgAsWorker } from "@/db/client";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";
import { recomputeVendorProfile, vendorsModule } from "@/modules/vendors";

export async function handleRecomputeVendorProfile(
  job: PgBoss.Job<JobPayloads[typeof JOB.recomputeVendorProfile]>,
): Promise<void> {
  const { vendorId, organizationId } = job.data;

  await withOrgAsWorker(organizationId, (tx) =>
    recomputeVendorProfile(tx, vendorsModule, { organizationId, vendorId }),
  );
}
