/**
 * Public surface of the vendors module. Presentation code (src/app/**),
 * jobs (src/jobs/**), and other modules should import use cases and
 * types from here — never reach into
 * src/modules/vendors/{domain,infrastructure}/* directly. That keeps
 * the dependency direction one-way: outer layers depend on this
 * barrel, this barrel depends on domain/application, and only
 * infrastructure depends on Drizzle.
 */
export { isVendorProfileReady, VENDOR_PROFILE_READY_THRESHOLD } from "./domain/vendor";
export type { VendorRecord } from "./domain/vendor";

export { getVendorList } from "./application/use-cases/get-vendor-list.usecase";
export type { GetVendorListInput } from "./application/use-cases/get-vendor-list.usecase";

export { getVendorDetail } from "./application/use-cases/get-vendor-detail.usecase";
export type {
  GetVendorDetailInput,
  GetVendorDetailResult,
} from "./application/use-cases/get-vendor-detail.usecase";

export { recomputeVendorProfile } from "./application/use-cases/recompute-vendor-profile.usecase";
export type {
  RecomputeVendorProfileDeps,
  RecomputeVendorProfileInput,
} from "./application/use-cases/recompute-vendor-profile.usecase";

export { bootstrapVendorOnApprove } from "./application/use-cases/bootstrap-vendor.usecase";
export type {
  BootstrapVendorInput,
  BootstrapVendorResult,
} from "./application/use-cases/bootstrap-vendor.usecase";

export type {
  VendorListRow,
  VendorsCursor,
} from "./application/ports";

import { drizzleVendorRepository } from "./infrastructure/drizzle-vendor.repository";
import { drizzlePricingRepository } from "./infrastructure/drizzle-pricing.repository";
import { drizzleVendorAuditRepository } from "./infrastructure/drizzle-vendor-audit.repository";
import { drizzleVendorContractsRepository } from "./infrastructure/drizzle-vendor-contracts.repository";

/**
 * Default, Drizzle-backed dependency bundle. Callers (pages, routes,
 * jobs) pass this to a use case; tests substitute in-memory fakes that
 * implement the same ports instead — see
 * src/modules/vendors/application/use-cases/__tests__/ for examples.
 */
export const vendorsModule = {
  vendorRepository: drizzleVendorRepository,
  pricingRepository: drizzlePricingRepository,
  auditRepository: drizzleVendorAuditRepository,
  contractsRepository: drizzleVendorContractsRepository,
};
