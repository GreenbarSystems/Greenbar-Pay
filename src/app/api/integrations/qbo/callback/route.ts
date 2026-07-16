/**
 * GET /api/integrations/qbo/callback
 *
 * Intuit redirects here after the user authorizes. Exchanges the code
 * for tokens, stores them (encrypted) in accounting_connections, then
 * redirects back to the integrations settings page.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import {
  exchangeQboCode,
  getQboCompanyName,
} from "@/lib/integrations/qbo/client";
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
  const realmId = searchParams.get("realmId");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/settings/integrations?error=${encodeURIComponent(error)}`, req.url),
    );
  }

  if (!code || !state || !realmId) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=missing_params", req.url),
    );
  }

  // Verify state + retrieve PKCE verifier from cookie.
  const cookieStore = await cookies();
  const rawCookie = cookieStore.get("qbo_oauth_state")?.value;
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

  cookieStore.delete("qbo_oauth_state");

  const redirectUri = `${process.env.AUTH_URL}/api/integrations/qbo/callback`;

  let tokens: Awaited<ReturnType<typeof exchangeQboCode>>;
  try {
    tokens = await exchangeQboCode(code, redirectUri, payload.codeVerifier);
  } catch (err) {
    console.error("[qbo/callback] token exchange failed:", err);
    return NextResponse.redirect(
      new URL("/settings/integrations?error=token_exchange_failed", req.url),
    );
  }

  // Fetch company name for display in settings.
  let companyName = "QuickBooks Company";
  try {
    companyName = await getQboCompanyName(realmId, tokens.accessToken);
  } catch {
    // Non-fatal — display name is cosmetic.
  }

  // Upsert the connection (UNIQUE on org + provider).
  await withOrg(organizationId, async (tx) => {
    const existing = await tx
      .select({ id: accountingConnections.id })
      .from(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          eq(accountingConnections.provider, "qbo"),
        ),
      )
      .limit(1);

    const values = {
      organizationId,
      provider: "qbo" as const,
      realmId,
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
    new URL("/settings/integrations?connected=qbo", req.url),
  );
}
