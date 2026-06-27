import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

/**
 * Auth.js v5 Email provider — verification-token storage.
 *
 * Shape matches the Auth.js adapter contract:
 *   identifier = the email
 *   token      = the hash of the magic link's verifier
 *   expires    = absolute UTC expiry
 *
 * Primary key on (identifier, token) so a single email can have multiple
 * in-flight links (browser tab + retried submit). Old rows are removed by
 * `useVerificationToken` when the user clicks; expired rows linger but
 * are inert because the expiry check fires before use.
 *
 * Cross-tenant by nature — the email is the only identifier we have
 * before the user is signed in, so RLS doesn't apply to this table. The
 * BYPASSRLS admin pool is used (same pattern as users lookup at sign-in).
 */
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.token] }),
  }),
);
