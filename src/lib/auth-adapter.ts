/**
 * Minimal Auth.js adapter for the Email (magic-link) provider + JWT
 * session strategy.
 *
 * Auth.js v5 with JWT sessions only calls a small slice of the Adapter
 * surface during the Email-provider flow:
 *
 *   1. POST /api/auth/signin/nodemailer
 *      → getUserByEmail(email)   — checks whether the email maps to a
 *                                   real user. If null, the signIn
 *                                   callback in auth.ts decides what to
 *                                   do (we reject unknown emails to
 *                                   preserve the admin-provisioned model).
 *      → createVerificationToken(token)
 *      → sendVerificationRequest(...)  (the Email provider hook)
 *
 *   2. GET /api/auth/callback/nodemailer?token=…&email=…
 *      → useVerificationToken({identifier, token})
 *                                — atomically reads + deletes; null
 *                                   means the token was missing, used,
 *                                   or expired.
 *      → getUserByEmail(email)   — again, to compose the JWT payload.
 *
 * Nothing else is touched because JWT sessions don't persist session
 * rows, and we reject auto-provisioning so createUser / updateUser /
 * linkAccount never fire. Stubbing those methods is therefore safe —
 * the runtime never reaches them.
 *
 * Cross-tenant by nature: at sign-in time we don't know the user's org
 * yet, so this uses the BYPASSRLS admin pool. Same pattern the
 * Credentials authorize() in auth.ts already uses.
 */
import type { Adapter, AdapterUser } from "next-auth/adapters";
import { and, eq, lt } from "drizzle-orm";
import { rawAdminDb } from "@/db/internal/rawClient";
import { users, verificationTokens } from "@/db/schema";

function toAdapterUser(row: {
  id: string;
  email: string;
  name: string | null;
}): AdapterUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    // We don't track verification state on the users table — provisioning
    // by an admin is itself the verification. Returning a fixed Date
    // keeps Auth.js happy without claiming a stale moment in time.
    emailVerified: new Date(0),
  };
}

export const drizzleAuthAdapter: Adapter = {
  async getUserByEmail(email) {
    const normalised = email.trim().toLowerCase();
    const [row] = await rawAdminDb
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.email, normalised))
      .limit(1);
    return row ? toAdapterUser(row) : null;
  },

  async createVerificationToken(token) {
    await rawAdminDb.insert(verificationTokens).values({
      identifier: token.identifier,
      token: token.token,
      expires: token.expires,
    });
    return token;
  },

  async useVerificationToken({ identifier, token }) {
    // Atomic: DELETE … RETURNING fails the row-existence check inline
    // so a second click on the same link returns null (consumed).
    const deleted = await rawAdminDb
      .delete(verificationTokens)
      .where(
        and(
          eq(verificationTokens.identifier, identifier),
          eq(verificationTokens.token, token),
        ),
      )
      .returning({
        identifier: verificationTokens.identifier,
        token: verificationTokens.token,
        expires: verificationTokens.expires,
      });
    const row = deleted[0];
    if (!row) return null;
    // Expiry is enforced application-side (Auth.js doesn't trust the
    // adapter on this one) — return whatever was stored and let the
    // caller compare.
    return row;
  },

  // No-op stubs for methods Auth.js may probe but won't reach in our
  // Email + JWT path. Throwing here would mask a misconfig; returning
  // a benign value lets us notice in the unlikely event the flow
  // changes upstream.
  async createUser() {
    throw new Error(
      "auth-adapter: createUser is disabled. Users must be provisioned by an admin before sign-in.",
    );
  },
  async getUser() {
    return null;
  },
  async updateUser(user) {
    return user as AdapterUser;
  },
};

/**
 * Best-effort cleanup of expired verification tokens. Called from the
 * Email provider's send hook so the table stays bounded without a
 * scheduled job. Cheap: single DELETE bounded by the partial index on
 * `expires` from the sidecar migration.
 */
export async function sweepExpiredTokens(): Promise<number> {
  const removed = await rawAdminDb
    .delete(verificationTokens)
    .where(lt(verificationTokens.expires, new Date()))
    .returning({ token: verificationTokens.token });
  return removed.length;
}
