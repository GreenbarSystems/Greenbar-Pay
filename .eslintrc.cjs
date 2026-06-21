/**
 * Two import bans, both enforcing addendum invariants:
 *
 * - §1.4 — raw `drizzle-orm/node-postgres` clients must not be reached
 *   outside the `withOrg` helper.
 * - §2.3 — direct `@anthropic-ai/sdk` calls (or other LLM SDKs) must not
 *   be reached outside the gateway. Forces every call site through
 *   `buildExtractionPrompt` + `dispatchInvoiceExtraction`, which is
 *   how we keep cross-org data out of LLM payloads.
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
