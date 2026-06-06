import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL_ADMIN ?? "postgres://app_admin:app_admin_pw@localhost:5432/greenbar",
  },
} satisfies Config;
