/**
 * Vendors list query — extracted from src/app/(app)/vendors/page.tsx
 * so the cursor-pagination logic (a raw row-value SQL comparison with
 * explicit casts and NULL handling) has a real integration test
 * exercising it against Postgres, not just a page render that this
 * repo currently has no way to test without a browser + auth session.
 * See src/lib/vendors/__tests__/list-query.test.ts.
 */
import type { SQL } from "drizzle-orm";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { vendors } from "@/db/schema";
import { splitPage } from "@/lib/pagination";

export const VENDORS_PAGE_SIZE = 200;

/**
 * Smaller than any real invoice date; substituting this for a NULL
 * lastInvoiceDate turns "NULLS LAST in a DESC sort" into a plain,
 * uniform-direction comparison. Postgres's row-value tuple comparison
 * (used for the cursor WHERE below) can't express mixed NULL
 * placement rules directly — substituting a sentinel sidesteps that
 * entirely rather than hand-rolling a 3-way OR-chain per NULL case.
 */
export const NO_INVOICE_DATE_SENTINEL = "0001-01-01";

export interface VendorsCursor {
  invoiceCount: number;
  /** ISO date (YYYY-MM-DD), or null — see NO_INVOICE_DATE_SENTINEL. */
  lastInvoiceDate: string | null;
  id: string;
}

export interface VendorListRow {
  id: string;
  name: string;
  aliases: string[];
  invoiceCount: number;
  lastInvoiceDate: string | null;
  spend30d: string;
  spend90d: string;
  avgInvoiceAmount: string;
  termsDriftDetected: boolean;
  duplicateSubmissionCount: number;
}

export async function fetchVendorsPage(
  tx: Tx,
  args: {
    organizationId: string;
    /** Per-client RBAC scope filter from loadPermittedClientIds, if any. */
    clientFilter?: SQL | undefined;
    cursor: VendorsCursor | null;
    pageSize?: number;
  },
): Promise<{ pageRows: VendorListRow[]; hasNext: boolean }> {
  const pageSize = args.pageSize ?? VENDORS_PAGE_SIZE;

  const filters = [eq(vendors.organizationId, args.organizationId)];
  if (args.clientFilter) filters.push(args.clientFilter);

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
