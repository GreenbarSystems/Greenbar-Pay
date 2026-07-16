/**
 * GET /api/integrations/netsuite/callback
 *
 * NetSuite redirects here after the user authorizes. Exchanges the code for
 * tokens, calls the userinfo endpoint to discover the account ID (realm_id),
 * then upserts accounting_connections and redirects to the settings page.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import {
  exchangeNetsuiteCode,
  getNetsuiteCompanyName,
} from "@/lib/integrations/netsuite/client";
import { encryptToken, decryptOAuthState } from "@/lib/integrations/tokens";

interface OAuthCookiePayload {
  state: string;
  codeVerifier: string;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  const { organizationId } = session.user;

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/settings/integrations?error=${encodeURIComponent(error)}`, req.url),
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=missing_params", req.url),
    );
  }

  const cookieStore = await cookies();
  const rawCookie = cookieStore.get("netsuite_oauth_state")?.value;
  if (!rawCookie) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=state_expired", req.url),
    );
  }

  let payload: OAuthCookiePayload;
  try {
    payload = decryptOAuthState<OAuthCookiePayload>(rawCookie);
  } catch {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=state_invalid", req.url),
    );
  }

  if (payload.state !== state) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=state_mismatch", req.url),
    );
  }

  cookieStore.delete("netsuite_oauth_state");

  const redirectUri = `${process.env.AUTH_URL}/api/integrations/netsuite/callback`;

  let tokens: Awaited<ReturnType<typeof exchangeNetsuiteCode>>;
  try {
    tokens = await exchangeNetsuiteCode(code, redirectUri, payload.codeVerifier);
  } catch (err) {
    console.error("[netsuite/callback] token exchange failed:", err);
    return NextResponse.redirect(
      new URL("/settings/integrations?error=token_exchange_failed", req.url),
    );
  }

  let companyName = "NetSuite";
  try {
    companyName = await getNetsuiteCompanyName(tokens.accountId, tokens.accessToken);
  } catch {
    // Non-fatal — display name is cosmetic.
  }

  await withOrg(organizationId, async (tx) => {
    const existing = await tx
      .select({ id: accountingConnections.id })
      .from(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          eq(accountingConnections.provider, "netsuite"),
        ),
      )
      .limit(1);

    const values = {
      organizationId,
      provider: "netsuite" as const,
      realmId: tokens.accountId,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptToken(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
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

  return NextResponse.redirect(
    new URL("/settings/integrations?connected=netsuite", req.url),
  );
}
