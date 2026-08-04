/**
 * Shared 403 gate for org-settings API routes (workflow, PO, accounting
 * integrations). Previously each route copy-pasted its own inline
 * `requireAdmin(role)` closure — that duplication is exactly how the
 * integrations connect/disconnect routes ended up with NO permission
 * check at all (they were never given a copy to begin with). Centralizing
 * here means a new settings route imports the check instead of having a
 * chance to forget it.
 *
 * App-route-only (imports NextResponse) — do not import this from
 * src/lib/rbac.ts or anywhere reachable from worker code; keep
 * next/server out of the worker-safe module graph.
 */
import { NextResponse } from "next/server";
import { can, type UserRole } from "@/lib/rbac";

/** Owner + admin only, same gate as workflow and PO settings. */
export function requireOrgAdmin(role: UserRole): NextResponse | null {
  if (!can(role, "users.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}
