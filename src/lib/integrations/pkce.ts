/**
 * PKCE (Proof Key for Code Exchange) helpers for OAuth 2.0 flows.
 * Used by both QBO and Xero connect routes.
 */
import { createHash, randomBytes } from "crypto";

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  return randomBytes(16).toString("hex");
}
