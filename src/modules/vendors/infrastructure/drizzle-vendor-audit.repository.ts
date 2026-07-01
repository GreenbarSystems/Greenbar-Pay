/**
 * VendorAuditRepository implementation. Moved verbatim from
 * src/lib/vendors/bootstrap.ts (writes — PR6 review #2: vendor master
 * mutations get first-class audit events so an audit query by
 * entity_type='vendor' surfaces them), src/jobs/recomputeVendorProfile.ts
 * (recompute write), and src/app/(app)/vendors/[id]/page.tsx (read —
 * the profile event log).
 */
import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { auditEvents } from "@/db/schema";
import type { VendorAuditEventRow, VendorAuditRepository } from "../application/ports";

async function recordVendorCreated(
  tx: Tx,
  args: {
    organizationId: string;
    actorUserId: string;
    vendorId: string;
    extractedInvoiceId: string;
    name: string;
    normalizedName: string;
    defaultPaymentTerms: string | null;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    organizationId: args.organizationId,
    actorType: "user",
    actorId: args.actorUserId,
    action: "vendor.created",
    entityType: "vendor",
    entityId: args.vendorId,
    metadataJson: {
      extractedInvoiceId: args.extractedInvoiceId,
      name: args.name,
      normalizedName: args.normalizedName,
      defaultPaymentTerms: args.defaultPaymentTerms,
    },
  });
}

async function recordVendorAliased(
  tx: Tx,
  args: {
    organizationId: string;
    actorUserId: string;
    vendorId: string;
    extractedInvoiceId: string;
    promotedAlias: string;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    organizationId: args.organizationId,
    actorType: "user",
    actorId: args.actorUserId,
    action: "vendor.aliased",
    entityType: "vendor",
    entityId: args.vendorId,
    metadataJson: {
      extractedInvoiceId: args.extractedInvoiceId,
      promotedAlias: args.promotedAlias,
      viaMatchMethod: "jaccard",
    },
  });
}

async function recordProfileRecomputed(
  tx: Tx,
  args: {
    organizationId: string;
    vendorId: string;
    invoiceCount: number;
    spend30d: number;
    spend90d: number;
    termsDriftDetected: boolean;
    duplicateSubmissionCount: number;
    pricingKeywords: number;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    organizationId: args.organizationId,
    actorType: "worker",
    action: "vendor.profile_recomputed",
    entityType: "vendor",
    entityId: args.vendorId,
    metadataJson: {
      invoiceCount: args.invoiceCount,
      spend30d: args.spend30d,
      spend90d: args.spend90d,
      termsDriftDetected: args.termsDriftDetected,
      duplicateSubmissionCount: args.duplicateSubmissionCount,
      pricingKeywords: args.pricingKeywords,
    },
  });
}

async function findRecentVendorEvents(
  tx: Tx,
  vendorId: string,
  limit: number,
): Promise<VendorAuditEventRow[]> {
  return tx
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      createdAt: auditEvents.createdAt,
      metadataJson: auditEvents.metadataJson,
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "vendor"), eq(auditEvents.entityId, vendorId)))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}

export const drizzleVendorAuditRepository: VendorAuditRepository = {
  recordVendorCreated,
  recordVendorAliased,
  recordProfileRecomputed,
  findRecentVendorEvents,
};
