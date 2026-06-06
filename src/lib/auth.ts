/**
 * Auth.js v5. JWT session carries organizationId + role so middleware can
 * pin the GUC via `withOrg(session.organizationId, …)`.
 *
 * Phase 1 ships a credentials provider for dev. Real email/OAuth lands with
 * the magic-link flow later.
 */
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import { rawAdminDb } from "@/db/internal/rawClient";
import { users } from "@/db/schema";
import type { UserRole } from "@/lib/rbac";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      role: UserRole;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId: string;
    organizationId: string;
    role: UserRole;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      name: "Dev login",
      credentials: { email: { label: "Email", type: "email" } },
      // Phase 1: any known user email signs in. Real password / magic-link
      // verification lands with the email provider in a follow-up.
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        if (!email) return null;

        // Sign-in is inherently cross-tenant — we don't know the org until
        // we've found the user. Use the BYPASSRLS admin pool. Same blessed
        // escape hatch documented in db/internal/rawClient.ts; this is the
        // sole non-inbox caller and any new caller requires review.
        const row = await rawAdminDb
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            organizationId: users.organizationId,
            role: users.role,
          })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        const u = row[0];
        if (!u) return null;
        return {
          id: u.id,
          email: u.email,
          name: u.name ?? undefined,
          organizationId: u.organizationId,
          role: u.role as UserRole,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as {
          id: string;
          organizationId: string;
          role: UserRole;
        };
        token.userId = u.id;
        token.organizationId = u.organizationId;
        token.role = u.role;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId;
      session.user.organizationId = token.organizationId;
      session.user.role = token.role;
      return session;
    },
  },
});
