/**
 * Applies generated Drizzle migrations, then the RLS sidecar.
 * Runs as `app_admin` (BYPASSRLS) — see addendum §1.3.
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const ADMIN_URL =
  process.env.DATABASE_URL_ADMIN ??
  "postgres://app_admin:app_admin_pw@localhost:5432/greenbar";

async function main() {
  const pool = new Pool({ connectionString: ADMIN_URL });
  const db = drizzle(pool);

  console.log("• applying Drizzle migrations…");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });

  const sidecarDir = path.resolve("./src/db/migrations/sidecar");
  const files = readdirSync(sidecarDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    console.log(`• applying sidecar ${f}`);
    const sql = readFileSync(path.join(sidecarDir, f), "utf8");
    await pool.query(sql);
  }

  await pool.end();
  console.log("✓ migrations complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
