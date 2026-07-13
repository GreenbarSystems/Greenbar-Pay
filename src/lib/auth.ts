/**
 * Auth.js v5. JWT session carries organizationId + role so middleware can
 * pin the GUC via `withOrg(session.organizationId, …)`.
 *
 * Providers:
 *   • Nodemailer (magic link)  — customer-facing sign-in. Sends a single-
 *     use link with a 15-minute expiry. Always registered.
 *   • Credentials (dev-only)   — direct-API login for local development
 *     and CI, so agents/tests don't need a live SMTP transport to sign
 *     in. SECURITY: this provider must NEVER be reachable in production.
 *     It is:
 *       1. Only constructed when NODE_ENV !== "production".
 *       2. Gated on a shared secret (`DEV_LOGIN_SECRET`) compared with a
 *          constant-time check — email alone is never sufficient.
 *       3. Backed by a boot-time assertion (`assertNoDevAuthInProduction`)
 *          that throws if this module is ever evaluated with
 *          NODE_ENV === "production" and the env var is set, so a
 *          misconfigured deploy fails loudly instead of silently
 *          exposing the bypass.
 *     Fixes the "F1 — password-less Credentials provider = full auth
 *     bypass" finding from the 2026-07-12 security audit: the prior
 *     version accepted only an email and returned a fully-hydrated
 *     session (any organizationId + role) with no proof of identity,
 *     and the provider was registered unconditionally.
 *
 * Both providers refuse to sign in users not pre-provisioned in the
 * `users` table — Pay's RBAC model assumes an admin adds the user with
 * a role + organizationId before they can authenticate.
 */
import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import { eq } from "drizzle-orm";
import { rawAdminDb } from "@/db/internal/rawClient";
import { users } from "@/db/schema";
import type { UserRole } from "@/lib/rbac";
import { drizzleAuthAdapter, sweepExpiredTokens } from "@/lib/auth-adapter";
import { deliverMagicLink } from "@/lib/auth-mailer";
import {
  assertNoDevAuthInProduction,
  isDevAuthEnabled as computeIsDevAuthEnabled,
  devLoginSecretIsValid,
} from "@/lib/auth-dev-login";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      role: UserRole;
    } & DefaultSession["user"];
  }
}

const MAGIC_LINK_TTL_MINUTES = 15;

// Defense in depth against F1: even if an env misconfiguration causes
// this module to be bundled/evaluated with NODE_ENV === "production",
// refuse to boot if the dev-login secret is present rather than silently
// registering (or silently no-op'ing) the provider. Fails loudly at
// startup instead of failing open at request time.
assertNoDevAuthInProduction(process.env);

const isDevAuthEnabled = computeIsDevAuthEnabled(process.env);

const providers: NextAuthConfig["providers"] = [
  Nodemailer({
    // The Email provider needs ANY truthy `server` (Auth.js validates
    // the field exists). We override sendVerificationRequest entirely
    // so this stub never connects anywhere.
    server: { host: "stub", port: 25 },
    from: process.env.AUTH_EMAIL_FROM ?? "noreply@greenbarpay.local",
    maxAge: MAGIC_LINK_TTL_MINUTES * 60,
    async sendVerificationRequest({ identifier, url }) {
      // Best-effort sweep on every send — keeps the table bounded
      // without scheduling a separate job. The await is non-blocking
      // semantically because we don't care about the count.
      await sweepExpiredTokens().catch(() => 0);
      await deliverMagicLink({
        to: identifier,
        url,
        expiresMinutes: MAGIC_LINK_TTL_MINUTES,
      });
    },
  }),
];

if (isDevAuthEnabled) {
  providers.push(
    Credentials({
      name: "Dev login (non-production only)",
      credentials: {
        email: { label: "Email", type: "email" },
        secret: { label: "Dev secret", type: "password" },
      },
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        const secret = String(creds?.secret ?? "");
        // Both checks required: a valid shared secret AND a provisioned
        // user. Secret check first and constant-time so a missing/wrong
        // secret can never be distinguished from a valid one by timing.
        if (!email || !devLoginSecretIsValid(secret, process.env)) return null;
        const row = await loadUserByEmail(email);
        return row
          ? {
              id: row.id,
              email: row.email,
              name: row.name ?? undefined,
              organizationId: row.organizationId,
              role: row.role as UserRole,
            }
          : null;
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: drizzleAuthAdapter,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/signin",
    verifyRequest: "/signin/check-email",
    error: "/signin",
  },
  providers,
  callbacks: {
    async signIn({ user, account }) {
      // Magic-link flow: Auth.js calls signIn AFTER the verification
      // token is consumed. We re-check the user exists (the adapter's
      // getUserByEmail returns null for unknown addresses, but Auth.js
      // still proceeds to signIn — the adapter contract treats unknown
      // emails as "create a new user," which we disallow). Returning
      // false here aborts before any session is minted.
      if (account?.provider === "nodemailer") {
        if (!user?.email) return false;
        const row = await loadUserByEmail(user.email);
        return row !== null;
      }
      // Credentials path: only reachable at all when isDevAuthEnabled
      // registered the provider above. authorize() already enforced the
      // shared secret + provisioned-user check, so nothing further to
      // gate here. If the provider isn't registered, Auth.js rejects
      // the callback route before signIn is ever invoked.
      return true;
    },
    async jwt({ token, user }) {
      // First sign-in: `user` is populated. For the credentials path
      // it already carries the org + role we read in authorize(); for
      // the nodemailer path it's the AdapterUser (id + email only), so
      // we hydrate from our users table.
      if (user) {
        const looksHydrated =
          (user as { organizationId?: string }).organizationId !== undefined;
        if (looksHydrated) {
          const u = user as {
            id: string;
            organizationId: string;
            role: UserRole;
          };
          token.userId = u.id;
          token.organizationId = u.organizationId;
          token.role = u.role;
        } else if (user.email) {
          const row = await loadUserByEmail(user.email);
          if (row) {
            token.userId = row.id;
            token.organizationId = row.organizationId;
            token.role = row.role as UserRole;
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId as string;
      session.user.organizationId = token.organizationId as string;
      session.user.role = token.role as UserRole;
      return session;
    },
  },
});

export async function loadUserByEmail(email: string) {
  const [row] = await rawAdminDb
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      organizationId: users.organizationId,
      role: users.role,
    })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row ?? null;
}
