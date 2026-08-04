/**
 * GET /api/integrations/qbo/connect
 *
 * Initiates the QBO OAuth 2.0 + PKCE flow. Redirects the user to the
 * Intuit authorization page. Stores state + code_verifier in an
 * encrypted, short-lived (5 min) cookie so the callback can verify them.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { QBO_AUTH_URL, QBO_SCOPES } from "@/lib/integrations/qbo/client";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "@/lib/integrations/pkce";
import { encryptOAuthState } from "@/lib/integrations/tokens";
import { requireOrgAdmin } from "@/lib/api/route-guards";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const gate = requireOrgAdmin(session.user.role);
  if (gate) return gate;

  const redirectUri = `${process.env.AUTH_URL}/api/integrations/qbo/callback`;
  const clientId = process.env.QBO_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "QBO_CLIENT_ID is not configured" }, { status: 500 });
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Encrypt state + verifier into a short-lived cookie.
  const cookieStore = await cookies();
  cookieStore.set("qbo_oauth_state", encryptOAuthState({ state, codeVerifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 300, // 5 minutes
    path: "/",
  });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: QBO_SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return NextResponse.redirect(`${QBO_AUTH_URL}?${params}`);
}
