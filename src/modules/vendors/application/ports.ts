/**
 * Dependency-inversion boundary for the vendors module. The domain and
 * application layers depend on these interfaces, never on Drizzle or
 * `@/db/schema` directly — src/modules/vendors/infrastructure/*
 * implements them. Every method still takes the existing `Tx` from
 * `@/db/client`'s `withOrg`/`withOrgAsWorker` — this refactor layers
 * boundaries on top of the tenant-isolation transaction boundary, it
 * does not replace it (see CLAUDE.md "No direct ORM access outside
 * withOrg").
 */
import type { Tx } from "@/db/client";
import type { KeywordStats } from "../domain/pricing-stats";

export interface VendorsCursor {
  invoiceCount: number;
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

export interface VendorDetailRow {
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

export interface RecentApprovedInvoiceRow {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  total: string | null;
  reviewStatus: string;
  documentId: string;
}

export interface VendorInvoiceForRecompute {
  id: string;
  total: string | null;
  invoiceDate: string | null;
  paymentTerms: string | null;
  reviewStatus: string;
}

export interface ProfileStatsUpdate {
  invoiceCount: number;
  lastInvoiceDate: string | null;
  spend30d: number;
  spend90d: number;
  avgInvoiceAmount: number;
  duplicateSubmissionCount: number;
  termsDriftDetected: boolean;
  /** Only set when the caller decides the mode-terms gate is met. */
  defaultPaymentTerms?: string;
}

export interface NewVendorInput {
  organizationId: string;
  clientId: string | null;
  name: string;
  normalizedName: string;
  defaultPaymentTerms: string | null;
}

export interface VendorMatchInfo {
  vendorId: string | null;
  matchMethod: string | null;
}

export interface VendorRepository {
  /**
   * PR6 — review #5: per-client read scope. `permittedClientIds ===
   * null` means no restriction (reviewer/admin/owner, or multi-client
   * disabled); `[]` means the caller has no client grants at all, so
   * only unaffiliated (org-wide) vendors are visible. The repository
   * owns translating this into the `clientId IS NULL OR clientId IN
   * (...)` SQL — callers never build Drizzle filters themselves.
   */
  findPage(
    tx: Tx,
    args: {
      organizationId: string;
      permittedClientIds: string[] | null;
      cursor: VendorsCursor | null;
      pageSize?: number;
    },
  ): Promise<{ pageRows: VendorListRow[]; hasNext: boolean }>;

  findById(
    tx: Tx,
    organizationId: string,
    vendorId: string,
  ): Promise<VendorDetailRow | null>;

  findRecentApprovedInvoicesForVendor(
    tx: Tx,
    organizationId: string,
    vendor: { id: string; normalizedName: string },
    limit: number,
  ): Promise<RecentApprovedInvoiceRow[]>;

  findLatestMatch(
    tx: Tx,
    extractedInvoiceId: string,
  ): Promise<VendorMatchInfo | null>;

  findByNormalizedName(
    tx: Tx,
    organizationId: string,
    normalizedName: string,
  ): Promise<{ id: string } | null>;

  createVendor(tx: Tx, input: NewVendorInput): Promise<{ id: string } | null>;

  appendAlias(
    tx: Tx,
    vendorId: string,
    alias: string,
    maxAliases: number,
  ): Promise<void>;

  lockForRecompute(tx: Tx, vendorId: string): Promise<void>;

  findForRecompute(
    tx: Tx,
    organizationId: string,
    vendorId: string,
  ): Promise<{ id: string; defaultPaymentTerms: string | null } | null>;

  findVendorInvoicesForRecompute(
    tx: Tx,
    organizationId: string,
    vendorId: string,
    limit: number,
  ): Promise<VendorInvoiceForRecompute[]>;

  updateProfileStats(
    tx: Tx,
    vendorId: string,
    stats: ProfileStatsUpdate,
  ): Promise<void>;

  markProfileUpdatedOnly(tx: Tx, vendorId: string): Promise<void>;

  /**
   * PR5 — review C4: count DISTINCT invoices from this vendor (any
   * review_status, including rejected and superseded) that EVER
   * carried a duplicate_invoice validation finding — "duplicate
   * pattern: count of prior duplicate SUBMISSION attempts," not just
   * ones that got approved anyway.
   */
  countDuplicateSubmissions(
    tx: Tx,
    organizationId: string,
    candidateInvoiceIds: string[],
  ): Promise<number>;
}

export interface PricingHistoryRow {
  id: string;
  itemKeyword: string;
  avgUnitPrice: string;
  samples: number;
  lastSeenAt: Date;
}

export interface InvoiceLineForPricing {
  description: string | null;
  unitPrice: string | null;
  invoiceDate: string | null;
}

export interface VendorPricingRepository {
  findActivePricingHistory(
    tx: Tx,
    vendorId: string,
    limit: number,
  ): Promise<PricingHistoryRow[]>;

  findApprovedInvoiceLines(
    tx: Tx,
    organizationId: string,
    invoiceIds: string[],
    limit: number,
  ): Promise<InvoiceLineForPricing[]>;

  supersedeAndInsert(
    tx: Tx,
    organizationId: string,
    vendorId: string,
    keyword: string,
    lastSeenAt: Date,
    stats: KeywordStats,
  ): Promise<void>;
}

export interface VendorAuditEventRow {
  id: string;
  action: string;
  createdAt: Date;
  metadataJson: unknown;
}

export interface VendorAuditRepository {
  recordVendorCreated(
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
  ): Promise<void>;

  recordVendorAliased(
    tx: Tx,
    args: {
      organizationId: string;
      actorUserId: string;
      vendorId: string;
      extractedInvoiceId: string;
      promotedAlias: string;
    },
  ): Promise<void>;

  recordProfileRecomputed(
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
  ): Promise<void>;

  findRecentVendorEvents(
    tx: Tx,
    vendorId: string,
    limit: number,
  ): Promise<VendorAuditEventRow[]>;
}

export interface VendorContractRow {
  id: string;
  status: string;
  contractNumber: string | null;
  effectiveDate: string | null;
  expiryDate: string | null;
  paymentTerms: string | null;
  currency: string | null;
  confidence: string | null;
  earlyPaymentDiscountPct: string | null;
  earlyPaymentDiscountDays: number | null;
  documentId: string;
  createdAt: Date;
  supersededAt: Date | null;
}

export interface VendorContractLineRow {
  id: string;
  description: string;
  itemKeyword: string | null;
  unitPrice: string | null;
  currency: string | null;
  priceBasis: string | null;
  minQuantity: string | null;
  maxQuantity: string | null;
  notes: string | null;
}

export interface VendorContractsRepository {
  findContractsForVendor(
    tx: Tx,
    organizationId: string,
    vendorId: string,
    limit: number,
  ): Promise<VendorContractRow[]>;

  findActiveContractLines(
    tx: Tx,
    contractId: string,
  ): Promise<VendorContractLineRow[]>;
}
