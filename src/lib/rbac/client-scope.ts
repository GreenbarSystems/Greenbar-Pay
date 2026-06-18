/**
 * Per-client read scope (PR6 — review #5).
 *
 * The Phase 7 vendor list / detail pages filtered only on
 * `organization_id`. A user with per-client RBAC could browse every
 * client's vendor profile in their org — violating the boundary the
 * approve/reject/PATCH handlers enforce via `loadEffectiveRole`.
 *
 * This helper returns the set of clients the user can READ:
 *
 *   - If the user's org-wide role grants `invoice.read`, return null
 *     (= "all clients" — represented as no filter at the SQL layer).
 *   - Otherwise, return the explicit list of clientIds from
 *     `user_client_access`. Org-wide rows that have `clientId IS NULL`
 *     are unaffiliated and visible to everyone in the org.
 *
 * Callers should compose the result into their WHERE clause:
 *
 *   const permitted = await loadPermittedClientIds(tx, { userId, orgRole });
 *   const where = permitted === null
 *     ? eq(vendors.organizationId, orgId)
 *     : and(
 *         eq(vendors.organizationId, orgId),
 *         or(
 *           isNull(vendors.clientId),
 *           inArray(vendors.clientId, permitted),
 *         ),
 *       );
 */
import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { userClientAccess } from "@/db/schema";
import type { UserRole } from "@/lib/rbac";

/**
 * Org-wide-read roles. These users can READ across all clients in the
 * org. clerk and viewer must have explicit per-client grants — they
 * see only the clients in their user_client_access rows.
 *
 * This is more restrictive than the org-wide `invoice.read` permission
 * in the RBAC matrix (which every role holds): `invoice.read` permits
 * the action; client scoping limits the surface. For viewing the
 * vendor master directly (financial data per client), we apply the
 * stricter scoping.
 */
const ORG_WIDE_READ_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  "owner",
  "admin",
  "reviewer",
]);

export async function loadPermittedClientIds(
  tx: Tx,
  args: { userId: string; orgRole: UserRole },
): Promise<string[] | null> {
  // Fast path: org role permits org-wide read; no filter needed.
  if (ORG_WIDE_READ_ROLES.has(args.orgRole)) return null;

  const rows = await tx
    .select({ clientId: userClientAccess.clientId })
    .from(userClientAccess)
    .where(eq(userClientAccess.userId, args.userId));

  return rows.map((r) => r.clientId);
}
