/**
 * Use case: paginated vendor list for the /vendors index page.
 * Orchestration only — RBAC scoping via loadPermittedClientIds, then a
 * single repository call. Moved out of
 * src/app/(app)/vendors/page.tsx so the page component is just auth +
 * render.
 */
import type { Tx } from "@/db/client";
import { loadPermittedClientIds } from "@/lib/rbac/client-scope";
import type { UserRole } from "@/lib/rbac";
import type { VendorListRow, VendorRepository, VendorsCursor } from "../ports";

export interface GetVendorListInput {
  organizationId: string;
  userId: string;
  orgRole: UserRole;
  cursor: VendorsCursor | null;
}

export interface GetVendorListDeps {
  vendorRepository: VendorRepository;
}

export async function getVendorList(
  tx: Tx,
  deps: GetVendorListDeps,
  input: GetVendorListInput,
): Promise<{ pageRows: VendorListRow[]; hasNext: boolean }> {
  const permittedClientIds = await loadPermittedClientIds(tx, {
    userId: input.userId,
    orgRole: input.orgRole,
  });

  return deps.vendorRepository.findPage(tx, {
    organizationId: input.organizationId,
    permittedClientIds,
    cursor: input.cursor,
  });
}
