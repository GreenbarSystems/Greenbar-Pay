/**
 * GET /api/integrations/xero/connect
 *
 * Initiates the Xero OAuth 2.0 + PKCE flow.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { XERO_AUTH_URL, XERO_SCOPES } from "@/lib/integrations/xero/client";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "@/lib/integrations/pkce";
import { encryptOAuthState } from "@/lib/integrations/tokens";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const redirectUri = `${process.env.AUTH_URL}/api/integrations/xero/callback`;
  const clientId = process.env.XERO_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "XERO_CLIENT_ID is not configured" }, { status: 500 });
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const cookieStore = await cookies();
  cookieStore.set("xero_oauth_state", encryptOAuthState({ state, codeVerifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: XERO_SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return NextResponse.redirect(`${XERO_AUTH_URL}?${params}`);
}
