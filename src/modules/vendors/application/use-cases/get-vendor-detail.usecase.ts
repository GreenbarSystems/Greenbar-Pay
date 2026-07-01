/**
 * Use case: full vendor profile detail view (Phase 7 — D1, contracts
 * added Phase 9.5 PR4). Moved out of
 * src/app/(app)/vendors/[id]/page.tsx — the page now only does
 * auth/param validation and rendering; every query and the per-client
 * visibility rule live here.
 */
import type { Tx } from "@/db/client";
import type { UserRole } from "@/lib/rbac";
import { loadPermittedClientIds } from "@/lib/rbac/client-scope";
import { canViewVendor } from "../../domain/vendor";
import type {
  PricingHistoryRow,
  RecentApprovedInvoiceRow,
  VendorAuditEventRow,
  VendorAuditRepository,
  VendorContractLineRow,
  VendorContractRow,
  VendorContractsRepository,
  VendorDetailRow,
  VendorPricingRepository,
  VendorRepository,
} from "../ports";

const PRICING_HISTORY_LIMIT = 20;
const RECENT_INVOICES_LIMIT = 10;
const PROFILE_EVENTS_LIMIT = 10;
const CONTRACTS_LIMIT = 20;

export interface GetVendorDetailInput {
  organizationId: string;
  userId: string;
  orgRole: UserRole;
  vendorId: string;
  /**
   * PR21 H1 — rate-card unit_price + notes are negotiated commercial
   * terms. The caller (page component) decides this via the existing
   * `can(role, "invoice.override")` RBAC gate — the use case just
   * respects the decision, it doesn't own permission policy.
   */
  canManageContracts: boolean;
}

export interface GetVendorDetailResult {
  vendor: VendorDetailRow;
  pricing: PricingHistoryRow[];
  recentApprovedInvoices: RecentApprovedInvoiceRow[];
  profileEvents: VendorAuditEventRow[];
  contracts: VendorContractRow[];
  activeContractLines: VendorContractLineRow[];
}

export interface GetVendorDetailDeps {
  vendorRepository: VendorRepository;
  pricingRepository: VendorPricingRepository;
  auditRepository: VendorAuditRepository;
  contractsRepository: VendorContractsRepository;
}

export async function getVendorDetail(
  tx: Tx,
  deps: GetVendorDetailDeps,
  input: GetVendorDetailInput,
): Promise<GetVendorDetailResult | null> {
  const vendor = await deps.vendorRepository.findById(
    tx,
    input.organizationId,
    input.vendorId,
  );
  if (!vendor) return null;

  // PR6 — review #5: per-client read scope. If the user can't see this
  // vendor's client, behave exactly as if it doesn't exist — 404 is
  // intentional, it leaks no signal about whether the vendor exists in
  // a client the user can't see.
  const permittedClientIds = await loadPermittedClientIds(tx, {
    userId: input.userId,
    orgRole: input.orgRole,
  });
  if (!canViewVendor(vendor, permittedClientIds)) return null;

  // PR8 — review perf #4: fan out the independent loads. Pricing,
  // recent invoices, profile events, and (Phase 9.5 PR4) contracts have
  // no dependency between them once vendor is resolved.
  const [pricing, recentApprovedInvoices, profileEvents, contracts] =
    await Promise.all([
      deps.pricingRepository.findActivePricingHistory(
        tx,
        vendor.id,
        PRICING_HISTORY_LIMIT,
      ),
      deps.vendorRepository.findRecentApprovedInvoicesForVendor(
        tx,
        input.organizationId,
        vendor,
        RECENT_INVOICES_LIMIT,
      ),
      deps.auditRepository.findRecentVendorEvents(
        tx,
        vendor.id,
        PROFILE_EVENTS_LIMIT,
      ),
      deps.contractsRepository.findContractsForVendor(
        tx,
        input.organizationId,
        vendor.id,
        CONTRACTS_LIMIT,
      ),
    ]);

  // Phase 9.5 PR4 — pull rate-card lines for the active contract only.
  // PR21 H1 — only fetch when the caller has invoice.override; the
  // prior shape rendered unit_price + notes in the RSC payload for
  // every viewer, bookkeeper, and reviewer that reached /vendors/[id].
  const activeContract = contracts.find((c) => c.status === "active");
  const activeContractLines =
    activeContract && input.canManageContracts
      ? await deps.contractsRepository.findActiveContractLines(
          tx,
          activeContract.id,
        )
      : [];

  return {
    vendor,
    pricing,
    recentApprovedInvoices,
    profileEvents,
    contracts,
    activeContractLines,
  };
}
