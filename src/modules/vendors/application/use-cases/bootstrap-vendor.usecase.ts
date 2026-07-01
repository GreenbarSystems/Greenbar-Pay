/**
 * Use case: vendor auto-bootstrap on approval (Phase 7 — D1). Moved
 * out of src/lib/vendors/bootstrap.ts. Called from the approve route
 * inside the same withOrg transaction the route already opens.
 *
 * The spec: "The vendor profile does not require manual setup. It is
 * bootstrapped automatically from the first invoice and becomes
 * meaningful after three or more invoices from the same vendor."
 *
 * Three branches, decided by the most recent vendor_matches row for
 * this invoice (the validator runs in both the worker and the PATCH
 * handler, so the latest row reflects the reviewer-validated state at
 * approval time):
 *   - exact match: vendor already linked; no-op.
 *   - fuzzy (jaccard) match the reviewer approved: promote the
 *     extracted variant into vendors.aliases so the next invoice with
 *     this spelling resolves via exact_alias.
 *   - no match: create a new vendor row. The recompute-vendor-profile
 *     use case populates stats on the first run.
 */
import { normalizeVendor } from "@/modules/validation";
import type { Tx } from "@/db/client";
import { MAX_VENDOR_ALIASES } from "../../domain/vendor";
import type { VendorAuditRepository, VendorRepository } from "../ports";

export interface BootstrapVendorInput {
  organizationId: string;
  clientId: string | null;
  extractedInvoiceId: string;
  extractedVendorName: string | null;
  extractedPaymentTerms: string | null;
  /** The approving user — recorded as actor_id on vendor.* audit events. */
  actorUserId: string;
}

export interface BootstrapVendorResult {
  vendorId: string;
  /** `linked` (existing match), `aliased` (variant promoted), `created` (new row). */
  action: "linked" | "aliased" | "created";
}

export interface BootstrapVendorDeps {
  vendorRepository: VendorRepository;
  auditRepository: VendorAuditRepository;
}

export async function bootstrapVendorOnApprove(
  tx: Tx,
  deps: BootstrapVendorDeps,
  input: BootstrapVendorInput,
): Promise<BootstrapVendorResult | null> {
  if (!input.extractedVendorName) return null;
  const normalized = normalizeVendor(input.extractedVendorName);
  if (!normalized) return null;

  const latestMatch = await deps.vendorRepository.findLatestMatch(
    tx,
    input.extractedInvoiceId,
  );

  // Branch A — exact match (canonical or alias). Vendor already linked.
  //
  // PR5 — review C2: legacy vendor_matches rows written before Phase 7
  // have match_method = NULL; migration 0011 backfills them to
  // 'exact_normalized', but be defensive: ANY vendor_id-bearing match
  // without a known method counts as already-linked. Without this
  // guard, a NULL method dropped through Branch A and B to Branch C,
  // which would try to INSERT a possibly-orphan vendor row.
  if (
    latestMatch?.vendorId &&
    (latestMatch.matchMethod === null ||
      latestMatch.matchMethod === "exact_normalized" ||
      latestMatch.matchMethod === "exact_alias")
  ) {
    return { vendorId: latestMatch.vendorId, action: "linked" };
  }

  // Branch B — fuzzy (jaccard) match the reviewer approved. Promote the
  // extracted variant name into the vendor's aliases so the next
  // invoice with this spelling resolves exact.
  if (latestMatch?.vendorId && latestMatch.matchMethod === "jaccard") {
    await deps.vendorRepository.appendAlias(
      tx,
      latestMatch.vendorId,
      normalized,
      MAX_VENDOR_ALIASES,
    );

    // PR6 — review #2: vendor master mutations get first-class audit
    // events so an audit query by entity_type='vendor' surfaces them.
    await deps.auditRepository.recordVendorAliased(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      vendorId: latestMatch.vendorId,
      extractedInvoiceId: input.extractedInvoiceId,
      promotedAlias: normalized,
    });

    return { vendorId: latestMatch.vendorId, action: "aliased" };
  }

  // Branch C — no usable match. Try once more here in case a vendor was
  // created concurrently (e.g. parallel approves of two invoices from
  // the same new vendor). INSERT … ON CONFLICT DO NOTHING is the same
  // pattern PR3 used for documents.
  const inserted = await deps.vendorRepository.createVendor(tx, {
    organizationId: input.organizationId,
    clientId: input.clientId,
    name: input.extractedVendorName,
    normalizedName: normalized,
    defaultPaymentTerms: input.extractedPaymentTerms,
  });

  if (inserted) {
    await deps.auditRepository.recordVendorCreated(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      vendorId: inserted.id,
      extractedInvoiceId: input.extractedInvoiceId,
      name: input.extractedVendorName,
      normalizedName: normalized,
      defaultPaymentTerms: input.extractedPaymentTerms,
    });
    return { vendorId: inserted.id, action: "created" };
  }

  // Lost the race — refetch the row a concurrent approve created.
  const existing = await deps.vendorRepository.findByNormalizedName(
    tx,
    input.organizationId,
    normalized,
  );
  return existing
    ? { vendorId: existing.id, action: "linked" }
    : null; // Vanishingly rare; the caller logs and skips.
}
