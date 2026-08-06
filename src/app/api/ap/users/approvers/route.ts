/**
 * GET /api/ap/users/approvers — Phase 11.2 F02 override modal helper.
 *
 * Returns the set of users in the caller's organisation who hold the
 * invoice.override permission, excluding the caller themselves. The
 * F02 override modal's "second approver (recommended)" picker uses
 * this list.
 *
 * Authoritative role resolution is server-side: a malicious client
 * cannot smuggle a non-eligible user id past the approve route
 * (the route re-validates secondApproverId against users in the org),
 * but pre-filtering on the picker is a UX nicety and a defence-in-
 * depth against the picker offering ineligible choices.
 *
 * Scope (MVP): org-role admin or owner. Per-client elevations on
 * user_client_access are not currently surfaced — pilot CPA firms
 * typically have a small set of "approve override" people granted at
 * the org level. If a client asks, the same join the approve route
 * already uses (loadEffectiveRole) can be folded in here.
 *
 * Gated on invoice.override (owner/admin only) — the same permission
 * that lets a caller land on the F02 override modal in the first place.
 * Defense in depth on top of the response already being minimized to
 * {id, name} (2026-07-13 audit F12): without this check, any
 * authenticated viewer/clerk/reviewer could still enumerate every
 * admin/owner's name in the org even though email/role aren't returned.
 */
import { NextResponse } from "next/server";
import { and, inArray, ne } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { users } from "@/db/schema";
import { requirePermission } from "@/lib/rbac";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId, role, id: userId } = session.user;

  try {
    requirePermission(role, "invoice.override");
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 403 });
  }

  const rows = await withOrg(organizationId, async (tx) => {
    return tx
      .select({
        id: users.id,
        name: users.name,
      })
      .from(users)
      .where(
        and(
          inArray(users.role, ["owner", "admin"]),
          ne(users.id, userId),
        ),
      )
      .orderBy(users.name);
  });

  return NextResponse.json({ approvers: rows });
}
