-- Auth.js v5 Email provider — verification-token storage for the
-- magic-link sign-in flow. Closes the "no auth proof" finding from the
-- product test session.
--
-- Cross-tenant table by nature: at the time a sign-in link is requested,
-- we don't know the user's organization yet. RLS is NOT enabled — same
-- as users + organizations, which the credentials-path sign-in already
-- reads via the BYPASSRLS admin pool.
--
-- The drizzle codegen for this table is in
-- src/db/schema/verificationTokens.ts.

CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier text NOT NULL,
  token      text NOT NULL,
  expires    timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- Sweep for expired tokens periodically; the application also enforces
-- expiry at use-time, but a cleanup index keeps the table bounded.
CREATE INDEX IF NOT EXISTS idx_verification_tokens_expires
  ON verification_tokens (expires);
