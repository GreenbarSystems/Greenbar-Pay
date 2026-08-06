import type { Config } from "drizzle-kit";

if (!process.env.DATABASE_URL_ADMIN) {
  throw new Error("DATABASE_URL_ADMIN is required (no default — this connects with BYPASSRLS).");
}

export default {
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL_ADMIN,
  },
} satisfies Config;
