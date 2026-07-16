/**
 * GET /api/integrations/xero/callback
 *
 * Xero redirects here after authorization. Exchanges the code for tokens,
 * fetches the tenant ID, stores everything, then redirects to settings.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  exchangeXeroCode,
  getXeroTenantId,
} from "@/lib/integrations/xero/client";
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
  const rawCookie = cookieStore.get("xero_oauth_state")?.value;
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

  cookieStore.delete("xero_oauth_state");

  const redirectUri = `${process.env.AUTH_URL}/api/integrations/xero/callback`;

  let tokens: Awaited<ReturnType<typeof exchangeXeroCode>>;
  try {
    tokens = await exchangeXeroCode(code, redirectUri, payload.codeVerifier);
  } catch (err) {
    console.error("[xero/callback] token exchange failed:", err);
    return NextResponse.redirect(
      new URL("/settings/integrations?error=token_exchange_failed", req.url),
    );
  }

  // Xero requires a second call to get the tenant ID.
  let tenantId: string;
  let tenantName = "Xero Organisation";
  try {
    const tenant = await getXeroTenantId(tokens.accessToken);
    tenantId = tenant.tenantId;
    tenantName = tenant.tenantName;
  } catch (err) {
    console.error("[xero/callback] tenant lookup failed:", err);
    return NextResponse.redirect(
      new URL("/settings/integrations?error=tenant_lookup_failed", req.url),
    );
  }

  await withOrg(organizationId, async (tx) => {
    const existing = await tx
      .select({ id: accountingConnections.id })
      .from(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          eq(accountingConnections.provider, "xero"),
        ),
      )
      .limit(1);

    const values = {
      organizationId,
      provider: "xero" as const,
      realmId: tenantId,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptToken(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
      settings: { tenantName } as Record<string, unknown>,
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
    new URL("/settings/integrations?connected=xero", req.url),
  );
}
