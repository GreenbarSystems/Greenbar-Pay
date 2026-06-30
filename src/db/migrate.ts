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

  // Bootstrap extensions BEFORE Drizzle migrations. The init.sql
  // Drizzle migration creates `extraction_corrections.embedding` as
  // `vector(1024)` (see src/db/schema/extractionCorrections.ts) —
  // that DDL fails with "type vector does not exist" unless the
  // extension is already enabled. The sidecar 0025 also runs
  // `CREATE EXTENSION IF NOT EXISTS vector` but executes AFTER the
  // Drizzle phase, which is too late for the first run on a fresh DB.
  // CI uses the `pgvector/pgvector:pg16` image so the binary is
  // present; this just activates it for our database.
  console.log("• bootstrapping required extensions…");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

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
