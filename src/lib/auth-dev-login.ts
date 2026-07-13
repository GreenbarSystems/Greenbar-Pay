/**
 * Pure, dependency-free guards for the dev-only Credentials provider in
 * src/lib/auth.ts. Split out so these security-critical checks can be
 * unit-tested without pulling in Drizzle/DB clients (auth.ts imports
 * rawAdminDb at module scope, which needs a live connection string).
 *
 * Fixes "F1 — password-less Credentials provider = full auth bypass"
 * from the 2026-07-12 security audit. See src/lib/auth.ts header comment
 * for the full threat model.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Throws if the dev-login secret is set while NODE_ENV is "production".
 * Call at module load time so a misconfigured deploy fails at boot
 * rather than silently exposing (or silently disabling) the bypass.
 */
export function assertNoDevAuthInProduction(env: {
  NODE_ENV?: string;
  DEV_LOGIN_SECRET?: string;
}): void {
  if (env.NODE_ENV === "production" && env.DEV_LOGIN_SECRET) {
    throw new Error(
      "DEV_LOGIN_SECRET must not be set in production — the Credentials " +
        "dev-login provider is a local/CI-only auth bypass and must never " +
        "be enabled outside development. Unset DEV_LOGIN_SECRET.",
    );
  }
}

/** True only outside production AND when a dev secret is configured. */
export function isDevAuthEnabled(env: {
  NODE_ENV?: string;
  DEV_LOGIN_SECRET?: string;
}): boolean {
  return env.NODE_ENV !== "production" && Boolean(env.DEV_LOGIN_SECRET);
}

/**
 * Constant-time string compare — avoids a timing oracle on the secret.
 * Returns false (never throws) for any empty/undefined input.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  const maxLen = Math.max(bufA.length, bufB.length, 1);
  const paddedA = Buffer.concat([bufA, Buffer.alloc(maxLen - bufA.length)]);
  const paddedB = Buffer.concat([bufB, Buffer.alloc(maxLen - bufB.length)]);
  return bufA.length === bufB.length && timingSafeEqual(paddedA, paddedB);
}

/**
 * Full authorize() decision for the dev-login provider, isolated from
 * Auth.js/DB wiring so it's directly unit-testable. Returns true only
 * when dev auth is enabled, a secret was configured, and the supplied
 * secret matches it in constant time. Does NOT check the user exists —
 * callers (auth.ts) still must look the user up separately.
 */
export function devLoginSecretIsValid(
  suppliedSecret: string | undefined,
  env: { NODE_ENV?: string; DEV_LOGIN_SECRET?: string },
): boolean {
  if (!isDevAuthEnabled(env)) return false;
  const expected = env.DEV_LOGIN_SECRET ?? "";
  return constantTimeEquals(suppliedSecret ?? "", expected);
}
