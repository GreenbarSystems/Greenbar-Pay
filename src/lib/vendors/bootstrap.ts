/**
 * Vendor auto-bootstrap on approval (Phase 7 — D1).
 *
 * The spec: "The vendor profile does not require manual setup. It is
 * bootstrapped automatically from the first invoice and becomes
 * meaningful after three or more invoices from the same vendor."
 *
 * Called from the approve handler inside the same tx. Three branches:
 *   - exact match: vendor already linked; no-op (caller may still
 *     enqueue the profile-recompute job).
 *   - fuzzy match with a winning vendor: the reviewer approved the
 *     Jaccard-matched vendor → promote the extracted variant into
 *     `vendors.aliases` so the NEXT invoice with the same spelling
 *     resolves via `exact_alias`.
 *   - no match: create a new vendor row from the extracted name. The
 *     profile-recompute job will populate stats on the first run.
 *
 * Returns the resolved vendorId (existing or new) so the caller can
 * stamp it on the audit event and pass to the profile recompute.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { vendors, vendorMatches, auditEvents } from "@/db/schema";
import { desc } from "drizzle-orm";
import { normalizeVendor } from "@/lib/validation";

export interface BootstrapInput {
  organizationId: string;
  clientId: string | null;
  extractedInvoiceId: string;
  extractedVendorName: string | null;
  extractedPaymentTerms: string | null;
  /**
   * The approving user — recorded as `actor_id` on the vendor.*
   * audit events emitted by this function. PR6: previously the
   * caller embedded the bootstrap outcome in invoice.approved
   * metadata, which made vendor mutations invisible to audit
   * queries scoped by entity_type='vendor'.
   */
  actorUserId: string;
}

export interface BootstrapResult {
  vendorId: string;
  /** `linked` (existing match), `aliased` (variant promoted), `created` (new row). */
  action: "linked" | "aliased" | "created";
}

export async function bootstrapVendorOnApprove(
  tx: Tx,
  input: BootstrapInput,
): Promise<BootstrapResult | null> {
  if (!input.extractedVendorName) return null;
  const normalized = normalizeVendor(input.extractedVendorName);
  if (!normalized) return null;

  // Use the validator's latest vendor_matches row for this invoice as the
  // source of truth about how the resolution went. The match runs in
  // both the worker and the PATCH handler, so the most-recent row
  // reflects the reviewer-validated state at approval time.
  const [latestMatch] = await tx
    .select({
      vendorId: vendorMatches.vendorId,
      matchMethod: vendorMatches.matchMethod,
      matchConfidence: vendorMatches.matchConfidence,
    })
    .from(vendorMatches)
    .where(eq(vendorMatches.extractedInvoiceId, input.extractedInvoiceId))
    .orderBy(desc(vendorMatches.createdAt))
    .limit(1);

  // Branch A — exact match (canonical or alias). Vendor already linked.
  //
  // PR5 — review C2: legacy `vendor_matches` rows written before Phase 7
  // have `match_method = NULL`. Migration 0011 backfills them to
  // 'exact_normalized', but be defensive: ANY vendor_id-bearing match
  // without a known method counts as already-linked. Without this guard,
  // a NULL method dropped through Branch A and B to Branch C, which
  // would try to INSERT a possibly-orphan vendor row.
  if (
    latestMatch?.vendorId &&
    (latestMatch.matchMethod === null ||
      latestMatch.matchMethod === "exact_normalized" ||
      latestMatch.matchMethod === "exact_alias")
  ) {
    return { vendorId: latestMatch.vendorId, action: "linked" };
  }

  // Branch B — fuzzy (jaccard) match that the reviewer approved. Promote
  // the extracted variant name into the vendor's aliases so the next
  // invoice with this spelling resolves exact.
  if (
    latestMatch?.vendorId &&
    latestMatch.matchMethod === "jaccard"
  ) {
    await tx
      .update(vendors)
      .set({
        aliases: sql`(
          select array_agg(distinct a)
          from unnest(array_append(${vendors.aliases}, ${normalized}::text)) as a
        )`,
      })
      .where(eq(vendors.id, latestMatch.vendorId));

    // PR6 — review #2: vendor master mutations get first-class audit
    // events so an audit query by entity_type='vendor' surfaces them.
    await tx.insert(auditEvents).values({
      organizationId: input.organizationId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "vendor.aliased",
      entityType: "vendor",
      entityId: latestMatch.vendorId,
      metadataJson: {
        extractedInvoiceId: input.extractedInvoiceId,
        promotedAlias: normalized,
        viaMatchMethod: "jaccard",
      },
    });

    return { vendorId: latestMatch.vendorId, action: "aliased" };
  }

  // Branch C — no usable match. Try once more here in case a vendor was
  // created concurrently (e.g. parallel approves of two invoices from
  // the same new vendor). INSERT … ON CONFLICT DO NOTHING is the same
  // pattern PR3 used for documents.
  const [inserted] = await tx
    .insert(vendors)
    .values({
      organizationId: input.organizationId,
      clientId: input.clientId,
      name: input.extractedVendorName,
      normalizedName: normalized,
      defaultPaymentTerms: input.extractedPaymentTerms,
    })
    .onConflictDoNothing({
      target: [vendors.organizationId, vendors.normalizedName],
    })
    .returning({ id: vendors.id });

  if (inserted) {
    // PR6 — review #2: vendor creation gets a first-class audit event.
    await tx.insert(auditEvents).values({
      organizationId: input.organizationId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "vendor.created",
      entityType: "vendor",
      entityId: inserted.id,
      metadataJson: {
        extractedInvoiceId: input.extractedInvoiceId,
        name: input.extractedVendorName,
        normalizedName: normalized,
        defaultPaymentTerms: input.extractedPaymentTerms,
      },
    });
    return { vendorId: inserted.id, action: "created" };
  }

  // Lost the race — refetch the row a concurrent approve created.
  const [existing] = await tx
    .select({ id: vendors.id })
    .from(vendors)
    .where(
      and(
        eq(vendors.organizationId, input.organizationId),
        eq(vendors.normalizedName, normalized),
      ),
    )
    .limit(1);
  return existing
    ? { vendorId: existing.id, action: "linked" }
    : null; // Vanishingly rare; the caller logs and skips.
}
