/**
 * GET /api/integrations/netsuite/connect
 *
 * Initiates the NetSuite OAuth 2.0 + PKCE flow. Identical pattern to QBO/Xero.
 * The account ID is not known upfront — it is discovered from the userinfo
 * endpoint in the callback and stored as realm_id.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { NETSUITE_AUTH_URL, NETSUITE_SCOPES } from "@/lib/integrations/netsuite/client";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "@/lib/integrations/pkce";
import { encryptOAuthState } from "@/lib/integrations/tokens";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const clientId = process.env.NETSUITE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "NETSUITE_CLIENT_ID is not configured" }, { status: 500 });
  }

  const redirectUri = `${process.env.AUTH_URL}/api/integrations/netsuite/callback`;

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const cookieStore = await cookies();
  cookieStore.set("netsuite_oauth_state", encryptOAuthState({ state, codeVerifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: NETSUITE_SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return NextResponse.redirect(`${NETSUITE_AUTH_URL}?${params}`);
}
