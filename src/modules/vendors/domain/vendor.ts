/**
 * Vendor domain — enterprise business rules (Phase 7 — D1 spec).
 *
 * "The vendor profile does not require manual setup. It is bootstrapped
 * automatically from the first invoice and becomes meaningful after
 * three or more invoices from the same vendor."
 *
 * This threshold previously lived as a duplicated magic number in both
 * vendors/page.tsx and vendors/[id]/page.tsx (display gating) and again
 * in the profile-recompute job (defaultPaymentTerms/termsDrift gating).
 * One rule, one place.
 */
export const VENDOR_PROFILE_READY_THRESHOLD = 3;

export function isVendorProfileReady(invoiceCount: number): boolean {
  return invoiceCount >= VENDOR_PROFILE_READY_THRESHOLD;
}

/**
 * PR7 — review #2: hard cap on vendors.aliases. Bounds row size, the
 * jaccard matcher's inner loop, and any future GIN index.
 */
export const MAX_VENDOR_ALIASES = 20;

/**
 * PR6 — recompute's per-(vendor, item_keyword) pricing sample cap, kept
 * bounded so the trend/stddev math and persisted row stay predictable
 * regardless of how much invoice history a vendor accumulates.
 */
export const PRICING_SAMPLE_CAP = 50;

/**
 * Safety bound on the vendor-invoice scan feeding profile recompute. See
 * src/modules/vendors/application/use-cases/recompute-vendor-profile.usecase.ts
 * for the full rationale (bounded worker memory vs. exact aggregation
 * for pathological outlier vendors).
 */
export const MAX_VENDOR_INVOICE_ROWS = 100_000;

/** Safety bound on the line-item scan feeding pricing history. */
export const MAX_PRICING_LINE_ROWS = 20_000;

export interface VendorRecord {
  id: string;
  organizationId: string;
  clientId: string | null;
  name: string;
  normalizedName: string;
  aliases: string[];
  invoiceCount: number;
  lastInvoiceDate: string | null;
  defaultPaymentTerms: string | null;
  spend30d: string;
  spend90d: string;
  avgInvoiceAmount: string;
  duplicateSubmissionCount: number;
  termsDriftDetected: boolean;
  lastProfileUpdated: Date | null;
}

/**
 * PR6 — review #5: per-client read scope. A vendor with no client
 * (org-wide) is visible to everyone in the org; a client-scoped vendor
 * is visible only to users with a grant for that client. `permitted ===
 * null` means "no per-client restriction" (reviewer/admin/owner, or
 * multi-client disabled).
 */
export function canViewVendor(
  vendor: Pick<VendorRecord, "clientId">,
  permittedClientIds: string[] | null,
): boolean {
  if (permittedClientIds === null) return true;
  if (vendor.clientId === null) return true;
  return permittedClientIds.includes(vendor.clientId);
}
