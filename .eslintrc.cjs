/**
 * Import bans enforcing addendum invariants:
 *
 * - §1.4 — raw drizzle clients must not be reached outside the `withOrg`
 *   helper. Banned: `drizzle-orm/node-postgres` (exact) + every alternative
 *   postgres adapter (patterns) so switching drivers doesn't silently bypass
 *   the rule. `drizzle-orm/pg-core` (column types) is NOT banned.
 * - §2.3 — direct `@anthropic-ai/sdk` calls (or other LLM SDKs) must not
 *   be reached outside the gateway. Forces every call site through
 *   `buildExtractionPrompt` + `dispatchInvoiceExtraction`, which is
 *   how we keep cross-org data out of LLM payloads. Subpath exports
 *   (e.g. `@anthropic-ai/sdk/resources`) are also banned via patterns.
 *
 * 2026-07-13 audit N1: the original rule used `paths` only (exact-string
 * matches). Added `patterns` so alternative drivers / SDK subpaths that
 * aren't literally in the paths list can't silently bypass the bans.
 */
module.exports = {
  extends: ["next/core-web-vitals"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "drizzle-orm/node-postgres",
            message:
              "Use `withOrg` from @/db/client. Direct drizzle access bypasses tenant RLS scoping (addendum §1.4).",
          },
          {
            name: "@anthropic-ai/sdk",
            message:
              "Use `dispatchInvoiceExtraction` from @/lib/llm. Direct SDK calls bypass the compliance registry, prompt builder, and scrubber (addendum §2.2–2.4).",
          },
        ],
        patterns: [
          // Ban subpath exports of the Anthropic SDK so
          // `@anthropic-ai/sdk/resources`, `@anthropic-ai/sdk/core`, etc.
          // are caught as well as the bare package name above.
          {
            group: ["@anthropic-ai/sdk/*"],
            message:
              "Use `dispatchInvoiceExtraction` from @/lib/llm. Direct SDK calls bypass the compliance registry, prompt builder, and scrubber (addendum §2.2–2.4).",
          },
          // Ban alternative postgres drizzle adapters. Only
          // `drizzle-orm/node-postgres` is in the paths list; equivalent
          // adapters would escape undetected without these pattern entries.
          // `drizzle-orm/pg-core` (schema column types) is intentionally
          // NOT listed here — it is safe and used throughout src/db/schema/.
          {
            group: [
              "drizzle-orm/node-postgres/*",
              "drizzle-orm/pg-proxy",
              "drizzle-orm/pg-proxy/*",
              "drizzle-orm/postgres-js",
              "drizzle-orm/postgres-js/*",
              "drizzle-orm/neon-serverless",
              "drizzle-orm/neon-serverless/*",
              "drizzle-orm/neon-http",
              "drizzle-orm/neon-http/*",
              "drizzle-orm/vercel-postgres",
              "drizzle-orm/vercel-postgres/*",
            ],
            message:
              "Use `withOrg` from @/db/client. Direct drizzle access bypasses tenant RLS scoping (addendum §1.4).",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // Integration tests legitimately need raw drizzle access for
      // their own setup/teardown (creating orgs, seeding fixtures,
      // asserting rows by direct SELECT). The RLS invariant the rule
      // protects is unit-of-work — `withOrg` — so test harnesses
      // outside the request path are an authorised escape hatch.
      // Broader pattern (src/**/__tests__/**) catches future test
      // dirs added under lib/, jobs/, etc.
      files: [
        "src/**/__tests__/**",
        "src/db/internal/**",
        "src/db/migrate.ts",
      ],
      rules: { "no-restricted-imports": "off" },
    },
    {
      // Only this directory may import the Anthropic SDK directly.
      files: ["src/lib/llm/internal/**"],
      rules: { "no-restricted-imports": "off" },
    },
  ],
};
