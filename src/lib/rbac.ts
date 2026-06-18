/**
 * RBAC permission matrix (addendum §1.5). Effective permission for an action
 * on a client = max(user.role, user_client_access.role for that client).
 */
export type UserRole = "owner" | "admin" | "reviewer" | "clerk" | "viewer";

export type Permission =
  | "billing.manage"
  | "users.manage"
  | "clients.manage"
  | "invoice.upload"
  | "invoice.edit"
  | "invoice.approve"
  | "invoice.reject"
  | "invoice.export"
  | "invoice.read";

const MATRIX: Record<UserRole, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    "billing.manage",
    "users.manage",
    "clients.manage",
    "invoice.upload",
    "invoice.edit",
    "invoice.approve",
    "invoice.reject",
    "invoice.export",
    "invoice.read",
  ]),
  admin: new Set<Permission>([
    "clients.manage",
    "invoice.upload",
    "invoice.edit",
    "invoice.approve",
    "invoice.reject",
    "invoice.export",
    "invoice.read",
  ]),
  reviewer: new Set<Permission>([
    "invoice.upload",
    "invoice.edit",
    "invoice.approve",
    "invoice.reject",
    "invoice.export",
    "invoice.read",
  ]),
  clerk: new Set<Permission>(["invoice.upload", "invoice.edit", "invoice.read"]),
  viewer: new Set<Permission>(["invoice.read"]),
};

const RANK: Record<UserRole, number> = {
  viewer: 0,
  clerk: 1,
  reviewer: 2,
  admin: 3,
  owner: 4,
};

/** Max of org-wide role and per-client role. */
export function effectiveRole(
  orgRole: UserRole,
  clientRole: UserRole | null | undefined,
): UserRole {
  if (!clientRole) return orgRole;
  return RANK[clientRole] > RANK[orgRole] ? clientRole : orgRole;
}

export function can(role: UserRole, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function requirePermission(role: UserRole, permission: Permission): void {
  if (!can(role, permission)) {
    const err = new Error(`forbidden: ${role} lacks ${permission}`);
    (err as { status?: number }).status = 403;
    throw err;
  }
}

/**
 * PR3 — review #16: load the per-client role for (userId, clientId)
 * from user_client_access and compose with the org-wide role.
 *
 * Prior to this, `effectiveRole` was defined but never called — every
 * endpoint checked the org role directly, silently ignoring per-client
 * grants. A viewer org-role user granted `reviewer` on one client
 * couldn't approve invoices for that client.
 *
 * Callers pass the active tx so the lookup is RLS-scoped to the user's
 * org. Returns the composed role; pass it to `requirePermission`.
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { userClientAccess } from "@/db/schema";

export async function loadEffectiveRole(
  tx: Tx,
  args: {
    userId: string;
    clientId: string | null;
    orgRole: UserRole;
  },
): Promise<UserRole> {
  if (!args.clientId) return args.orgRole;
  const [row] = await tx
    .select({ role: userClientAccess.role })
    .from(userClientAccess)
    .where(
      and(
        eq(userClientAccess.userId, args.userId),
        eq(userClientAccess.clientId, args.clientId),
      ),
    )
    .limit(1);
  return effectiveRole(args.orgRole, (row?.role ?? null) as UserRole | null);
}
