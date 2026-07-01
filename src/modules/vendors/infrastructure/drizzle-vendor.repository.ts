/**
 * VendorRepository implementation. Every query here is moved verbatim
 * from where it used to live inline (src/lib/vendors/list-query.ts,
 * src/app/(app)/vendors/[id]/page.tsx, src/lib/vendors/bootstrap.ts,
 * src/jobs/recomputeVendorProfile.ts) — see git history on those paths
 * for the PR-by-PR rationale behind each query shape. This file is the
 * ONLY place in the codebase that knows the `vendors` / `vendorMatches`
 * table shapes; every other layer talks to `VendorRepository`.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  documents,
  extractedInvoices,
  validationResults,
  vendorMatches,
  vendors,
} from "@/db/schema";
import type {
  NewVendorInput,
  ProfileStatsUpdate,
  RecentApprovedInvoiceRow,
  VendorDetailRow,
  VendorInvoiceForRecompute,
  VendorListRow,
  VendorMatchInfo,
  VendorRepository,
  VendorsCursor,
} from "../application/ports";
import { splitPage } from "@/lib/pagination";

/**
 * Smaller than any real invoice date; substituting this for a NULL
 * lastInvoiceDate turns "NULLS LAST in a DESC sort" into a plain,
 * uniform-direction comparison. Postgres's row-value tuple comparison
 * (used for the cursor WHERE below) can't express mixed NULL
 * placement rules directly — substituting a sentinel sidesteps that
 * entirely rather than hand-rolling a 3-way OR-chain per NULL case.
 */
const NO_INVOICE_DATE_SENTINEL = "0001-01-01";
const DEFAULT_VENDORS_PAGE_SIZE = 200;

async function findPage(
  tx: Tx,
  args: {
    organizationId: string;
    permittedClientIds: string[] | null;
    cursor: VendorsCursor | null;
    pageSize?: number;
  },
): Promise<{ pageRows: VendorListRow[]; hasNext: boolean }> {
  const pageSize = args.pageSize ?? DEFAULT_VENDORS_PAGE_SIZE;

  const filters = [eq(vendors.organizationId, args.organizationId)];
  // PR6 — review #5: per-client read scope. `permitted === null` means
  // no restriction; `[]` means the caller has zero grants, so only
  // unaffiliated (org-wide) vendors are visible.
  const permitted = args.permittedClientIds;
  if (permitted !== null) {
    filters.push(
      permitted.length === 0
        ? isNull(vendors.clientId)
        : or(isNull(vendors.clientId), inArray(vendors.clientId, permitted))!,
    );
  }

  // Cursor pagination over a 3-key sort (invoiceCount DESC,
  // lastInvoiceDate DESC NULLS LAST, id DESC as stable tiebreaker).
  // Expressed as a raw row-value comparison against the same
  // sentinel-substituted expression the ORDER BY uses below, so both
  // sides agree on what "after the cursor" means with NULLs involved.
  if (args.cursor) {
    filters.push(
      sql`(
        ${vendors.invoiceCount},
        coalesce(${vendors.lastInvoiceDate}, ${NO_INVOICE_DATE_SENTINEL}),
        ${vendors.id}
      ) < (
        ${args.cursor.invoiceCount}::int,
        coalesce(${args.cursor.lastInvoiceDate}::date, ${NO_INVOICE_DATE_SENTINEL}),
        ${args.cursor.id}::uuid
      )`,
    );
  }

  // Note: the existing composite index idx_vendors_org_count_lastinv
  // (organizationId, invoiceCount DESC, lastInvoiceDate DESC) covers
  // the (organizationId, invoiceCount) prefix of this query but not
  // the coalesced expression or the id tiebreaker — Postgres will use
  // it for the org+count portion and sort the (typically small,
  // already org-scoped) remainder in memory. Not worth a new
  // functional index for this: vendors-per-org is a much smaller table
  // than invoices/audit events, and LIMIT bounds the sort.
  const fetched = await tx
    .select({
      id: vendors.id,
      name: vendors.name,
      aliases: vendors.aliases,
      invoiceCount: vendors.invoiceCount,
      lastInvoiceDate: vendors.lastInvoiceDate,
      spend30d: vendors.spend30d,
      spend90d: vendors.spend90d,
      avgInvoiceAmount: vendors.avgInvoiceAmount,
      termsDriftDetected: vendors.termsDriftDetected,
      duplicateSubmissionCount: vendors.duplicateSubmissionCount,
    })
    .from(vendors)
    .where(and(...filters))
    .orderBy(
      desc(vendors.invoiceCount),
      sql`coalesce(${vendors.lastInvoiceDate}, ${NO_INVOICE_DATE_SENTINEL}) desc`,
      desc(vendors.id),
    )
    .limit(pageSize + 1);

  return splitPage(fetched, pageSize);
}

async function findById(
  tx: Tx,
  organizationId: string,
  vendorId: string,
): Promise<VendorDetailRow | null> {
  const [vendor] = await tx
    .select({
      id: vendors.id,
      organizationId: vendors.organizationId,
      clientId: vendors.clientId,
      name: vendors.name,
      normalizedName: vendors.normalizedName,
      aliases: vendors.aliases,
      invoiceCount: vendors.invoiceCount,
      lastInvoiceDate: vendors.lastInvoiceDate,
      defaultPaymentTerms: vendors.defaultPaymentTerms,
      spend30d: vendors.spend30d,
      spend90d: vendors.spend90d,
      avgInvoiceAmount: vendors.avgInvoiceAmount,
      duplicateSubmissionCount: vendors.duplicateSubmissionCount,
      termsDriftDetected: vendors.termsDriftDetected,
      lastProfileUpdated: vendors.lastProfileUpdated,
    })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.organizationId, organizationId)))
    .limit(1);
  return vendor ?? null;
}

async function findRecentApprovedInvoicesForVendor(
  tx: Tx,
  organizationId: string,
  vendor: { id: string; normalizedName: string },
  limit: number,
): Promise<RecentApprovedInvoiceRow[]> {
  return tx
    .select({
      id: extractedInvoices.id,
      invoiceNumber: extractedInvoices.invoiceNumber,
      invoiceDate: extractedInvoices.invoiceDate,
      total: extractedInvoices.total,
      reviewStatus: extractedInvoices.reviewStatus,
      documentId: extractedInvoices.documentId,
    })
    .from(extractedInvoices)
    .innerJoin(documents, eq(documents.id, extractedInvoices.documentId))
    .where(
      and(
        eq(extractedInvoices.organizationId, organizationId),
        inArray(extractedInvoices.reviewStatus, ["approved", "exported"]),
        // PR20 — match via normalize_vendor_text so the functional
        // index idx_ei_org_norm_vendor_name (PR8) is used. Raw
        // eq(vendorName, vendor.name) would be case-sensitive AND
        // unindexed; both bugs.
        sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ${vendor.normalizedName}`,
      ),
    )
    .orderBy(desc(extractedInvoices.invoiceDate))
    .limit(limit);
}

async function findLatestMatch(
  tx: Tx,
  extractedInvoiceId: string,
): Promise<VendorMatchInfo | null> {
  const [latestMatch] = await tx
    .select({
      vendorId: vendorMatches.vendorId,
      matchMethod: vendorMatches.matchMethod,
    })
    .from(vendorMatches)
    .where(eq(vendorMatches.extractedInvoiceId, extractedInvoiceId))
    .orderBy(desc(vendorMatches.createdAt))
    .limit(1);
  return latestMatch ?? null;
}

async function findByNormalizedName(
  tx: Tx,
  organizationId: string,
  normalizedName: string,
): Promise<{ id: string } | null> {
  const [existing] = await tx
    .select({ id: vendors.id })
    .from(vendors)
    .where(
      and(
        eq(vendors.organizationId, organizationId),
        eq(vendors.normalizedName, normalizedName),
      ),
    )
    .limit(1);
  return existing ?? null;
}

async function createVendor(
  tx: Tx,
  input: NewVendorInput,
): Promise<{ id: string } | null> {
  // INSERT … ON CONFLICT DO NOTHING — same pattern PR3 used for
  // documents. Returns null when a concurrent approve won the race;
  // the caller (bootstrap-vendor use case) re-reads via
  // findByNormalizedName in that case.
  const [inserted] = await tx
    .insert(vendors)
    .values({
      organizationId: input.organizationId,
      clientId: input.clientId,
      name: input.name,
      normalizedName: input.normalizedName,
      defaultPaymentTerms: input.defaultPaymentTerms,
    })
    .onConflictDoNothing({
      target: [vendors.organizationId, vendors.normalizedName],
    })
    .returning({ id: vendors.id });
  return inserted ?? null;
}

async function appendAlias(
  tx: Tx,
  vendorId: string,
  alias: string,
  maxAliases: number,
): Promise<void> {
  // PR7 — review #2: dedup-and-trim runs in SQL so concurrent approves
  // can't race past the bound. FIFO eviction: appending past the cap
  // keeps the most-recently-promoted `maxAliases` entries.
  await tx
    .update(vendors)
    .set({
      aliases: sql`(
        select coalesce(array_agg(a order by mx desc), array[]::text[])
        from (
          select a, max(ord) as mx
          from unnest(array_append(${vendors.aliases}, ${alias}::text))
            with ordinality as t(a, ord)
          group by a
          order by max(ord) desc
          limit ${maxAliases}
        ) keep
      )`,
    })
    .where(eq(vendors.id, vendorId));
}

async function lockForRecompute(tx: Tx, vendorId: string): Promise<void> {
  // Per-vendor advisory lock prevents two concurrent recomputes from
  // racing on the same vendor.
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended('vendor-profile:' || ${vendorId}::text, 0)
    )
  `);
}

async function findForRecompute(
  tx: Tx,
  organizationId: string,
  vendorId: string,
): Promise<{ id: string; defaultPaymentTerms: string | null } | null> {
  const [vendor] = await tx
    .select({
      id: vendors.id,
      defaultPaymentTerms: vendors.defaultPaymentTerms,
    })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.organizationId, organizationId)))
    .limit(1);
  return vendor ?? null;
}

async function findVendorInvoicesForRecompute(
  tx: Tx,
  organizationId: string,
  vendorId: string,
  limit: number,
): Promise<VendorInvoiceForRecompute[]> {
  // PR13 — one query serves both the header-stats aggregation (after
  // the caller filters to approved/exported) and the duplicate-pattern
  // tally (which needs every status). Match path: invoice's vendor_name
  // normalized === vendor's normalized_name OR is in the vendor's
  // aliases (already stored pre-normalized by bootstrap). The
  // normalize_vendor_text() SQL function (sidecar 0011) is the single
  // source of truth for normalization shared with the JS side.
  return tx
    .select({
      id: extractedInvoices.id,
      total: extractedInvoices.total,
      invoiceDate: extractedInvoices.invoiceDate,
      paymentTerms: extractedInvoices.paymentTerms,
      reviewStatus: extractedInvoices.reviewStatus,
    })
    .from(extractedInvoices)
    .innerJoin(
      vendors,
      and(
        eq(vendors.id, vendorId),
        or(
          sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ${vendors.normalizedName}`,
          sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ANY(${vendors.aliases})`,
        ),
      ),
    )
    .where(eq(extractedInvoices.organizationId, organizationId))
    // NULLS LAST: a null invoiceDate never contributes to the date-
    // windowed spend/mode calculations (guarded by `if (r.invoiceDate)`
    // in profile-aggregation.ts), so it should never displace a real
    // dated row from the cap. Postgres's default DESC ordering puts
    // NULLs FIRST, which would do exactly that without this.
    .orderBy(sql`${extractedInvoices.invoiceDate} DESC NULLS LAST`)
    .limit(limit);
}

async function updateProfileStats(
  tx: Tx,
  vendorId: string,
  stats: ProfileStatsUpdate,
): Promise<void> {
  await tx
    .update(vendors)
    .set({
      invoiceCount: stats.invoiceCount,
      lastInvoiceDate: stats.lastInvoiceDate,
      spend30d: stats.spend30d.toFixed(2),
      spend90d: stats.spend90d.toFixed(2),
      avgInvoiceAmount: stats.avgInvoiceAmount.toFixed(2),
      duplicateSubmissionCount: stats.duplicateSubmissionCount,
      termsDriftDetected: stats.termsDriftDetected,
      ...(stats.defaultPaymentTerms !== undefined
        ? { defaultPaymentTerms: stats.defaultPaymentTerms }
        : {}),
      lastProfileUpdated: sql`now()`,
    })
    .where(eq(vendors.id, vendorId));
}

async function markProfileUpdatedOnly(tx: Tx, vendorId: string): Promise<void> {
  await tx
    .update(vendors)
    .set({ lastProfileUpdated: sql`now()` })
    .where(eq(vendors.id, vendorId));
}

async function countDuplicateSubmissions(
  tx: Tx,
  organizationId: string,
  candidateInvoiceIds: string[],
): Promise<number> {
  if (candidateInvoiceIds.length === 0) return 0;
  const [row] = await tx
    .select({
      count: sql<number>`count(distinct ${validationResults.entityId})::int`,
    })
    .from(validationResults)
    .where(
      and(
        eq(validationResults.organizationId, organizationId),
        eq(validationResults.entityType, "extracted_invoice"),
        inArray(validationResults.entityId, candidateInvoiceIds),
        sql`${validationResults.errorsJson} @> '[{"code":"duplicate_invoice"}]'::jsonb`,
      ),
    );
  return row.count;
}

export const drizzleVendorRepository: VendorRepository = {
  findPage,
  findById,
  findRecentApprovedInvoicesForVendor,
  findLatestMatch,
  findByNormalizedName,
  createVendor,
  appendAlias,
  lockForRecompute,
  findForRecompute,
  findVendorInvoicesForRecompute,
  updateProfileStats,
  markProfileUpdatedOnly,
  countDuplicateSubmissions,
};
