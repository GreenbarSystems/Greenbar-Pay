/**
 * DELETE /api/integrations/xero/disconnect
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId } = session.user;

  await withOrg(organizationId, async (tx) => {
    await tx
      .delete(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          eq(accountingConnections.provider, "xero"),
        ),
      );
  });

  return NextResponse.json({ disconnected: true });
}
