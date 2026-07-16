/**
 * POST /api/integrations/intacct/connect
 *
 * Accepts Sage Intacct credentials (companyId, userId, userPassword), validates
 * them by obtaining a session token, then upserts accounting_connections.
 *
 * Unlike QBO/Xero (OAuth redirect), Intacct uses credential-based auth — the
 * connect UI at /settings/integrations/intacct POSTs here rather than
 * redirecting to a third-party auth page.
 *
 * Stored layout:
 *   realm_id      = companyId
 *   access_token  = encrypted session token (for immediate use; refreshed on expiry)
 *   refresh_token = encrypted JSON { companyId, userId, userPassword }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  getIntacctSession,
  getIntacctCompanyName,
  type IntacctCredentials,
} from "@/lib/integrations/intacct/client";
import { encryptToken } from "@/lib/integrations/tokens";

const BodySchema = z.object({
  companyId: z.string().min(1),
  userId: z.string().min(1),
  userPassword: z.string().min(1),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { organizationId } = session.user;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", issues: (err as z.ZodError).issues },
      { status: 400 },
    );
  }

  const creds: IntacctCredentials = {
    companyId: body.companyId,
    userId: body.userId,
    userPassword: body.userPassword,
  };

  let sessionResult: Awaited<ReturnType<typeof getIntacctSession>>;
  try {
    sessionResult = await getIntacctSession(creds);
  } catch (err) {
    return NextResponse.json(
      {
        error: "auth_failed",
        message: String(err).replace(/^Error:\s*/, "").slice(0, 200),
      },
      { status: 422 },
    );
  }

  let companyName = body.companyId;
  try {
    companyName = await getIntacctCompanyName(sessionResult.sessionId, body.companyId);
  } catch {
    // Non-fatal.
  }

  await withOrg(organizationId, async (tx) => {
    const existing = await tx
      .select({ id: accountingConnections.id })
      .from(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          eq(accountingConnections.provider, "intacct"),
        ),
      )
      .limit(1);

    const values = {
      organizationId,
      provider: "intacct" as const,
      realmId: body.companyId,
      accessToken: encryptToken(sessionResult.sessionId),
      refreshToken: encryptToken(JSON.stringify(creds)),
      tokenExpiresAt: sessionResult.expiresAt,
      settings: { companyName } as Record<string, unknown>,
      isActive: true,
      updatedAt: new Date(),
    };

    if (existing[0]) {
      await tx
        .update(accountingConnections)
        .set(values)
        .where(eq(accountingConnections.id, existing[0].id));
    } else {
      await tx.insert(accountingConnections).values(values);
    }
  });

  return NextResponse.json({ connected: true, companyName });
}
