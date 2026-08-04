/**
 * DELETE /api/integrations/qbo/disconnect
 *
 * Removes the QBO connection for the calling org. Does not call the
 * Intuit revoke endpoint (tokens expire naturally; revocation is a
 * best-effort optional call). Redirects to the integrations settings page.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { requireOrgAdmin } from "@/lib/api/route-guards";

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId, role } = session.user;

  const gate = requireOrgAdmin(role);
  if (gate) return gate;

  await withOrg(organizationId, async (tx) => {
    await tx
      .delete(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          eq(accountingConnections.provider, "qbo"),
        ),
      );
  });

  return NextResponse.json({ disconnected: true });
}
