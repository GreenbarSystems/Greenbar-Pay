/**
 * Addendum §1.4: raw `drizzle-orm/node-postgres` clients must not be reached
 * outside the `withOrg` helper. The helper itself imports the underlying
 * driver via `@/db/internal/__rawClient` (an alias the rule allows).
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
        ],
      },
    ],
  },
  overrides: [
    {
      files: ["src/db/internal/**", "src/db/migrate.ts", "src/db/__tests__/**"],
      rules: { "no-restricted-imports": "off" },
    },
  ],
};
