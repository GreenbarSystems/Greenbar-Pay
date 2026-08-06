/**
 * Applies generated Drizzle migrations, then the RLS sidecar.
 * Runs as `app_admin` (BYPASSRLS) — see addendum §1.3.
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/**
 * Applies the full migration set (generated migrations, then every
 * sidecar SQL file in filename order) against the given pool.
 *
 * `stopBeforeSidecar`, if given, halts BEFORE applying the sidecar
 * file with that exact filename (it and everything after it in
 * filename order are skipped). Used by
 * scripts/verify-partition-backfill.ts to get a database to the
 * pre-0030 state, seed synthetic historical data, then apply 0030
 * itself as the thing under test — reusing the exact same
 * migration-application logic the real CLI uses (this function),
 * rather than a parallel reimplementation that could silently drift
 * out of sync with it.
 */
export async function applyMigrations(
  pool: Pool,
  opts: { stopBeforeSidecar?: string } = {},
): Promise<void> {
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
    if (opts.stopBeforeSidecar && f === opts.stopBeforeSidecar) {
      console.log(`• stopping before sidecar ${f} (stopBeforeSidecar requested)`);
      break;
    }
    console.log(`• applying sidecar ${f}`);
    const sql = readFileSync(path.join(sidecarDir, f), "utf8");
    await pool.query(sql);
  }
}

/**
 * Applies exactly one named sidecar file's SQL, reading it fresh from
 * disk. Used to run "the migration under test" in isolation after
 * applyMigrations({ stopBeforeSidecar }) has set up everything before
 * it, and after test-only seed data has been inserted.
 */
export async function applyOneSidecar(pool: Pool, filename: string): Promise<void> {
  const sidecarDir = path.resolve("./src/db/migrations/sidecar");
  const sql = readFileSync(path.join(sidecarDir, filename), "utf8");
  console.log(`• applying sidecar ${filename}`);
  await pool.query(sql);
}

async function main() {
  // Scoped to the CLI entrypoint, not module top-level — applyMigrations
  // and applyOneSidecar are imported by scripts (e.g.
  // verify-partition-backfill.ts) that connect via their own maintenance
  // URL, not DATABASE_URL_ADMIN, and shouldn't be forced to have it set
  // just because they import from this module.
  if (!process.env.DATABASE_URL_ADMIN) {
    throw new Error("DATABASE_URL_ADMIN is required (no default — this connects with BYPASSRLS).");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_ADMIN });
  await applyMigrations(pool);
  await pool.end();
  console.log("✓ migrations complete");
}

// Only run the CLI entrypoint when this file is executed directly
// (`tsx src/db/migrate.ts`), not when its exports are imported by
// scripts/verify-partition-backfill.ts. ESM equivalent of Node's
// CommonJS `require.main === module` check.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
