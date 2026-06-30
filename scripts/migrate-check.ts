/**
 * db:migrate:check — applies the full migration suite to a throwaway
 * database. Catches SQL-apply-time bugs (IMMUTABLE predicate violations,
 * missing extensions, role/grant ordering, syntax errors) that
 * `tsc --noEmit` and `next lint` will never see.
 *
 * Pattern:
 *   1. Connect to the maintenance DB (`postgres`) on the same Postgres
 *      instance the local docker-compose stack provides.
 *   2. DROP DATABASE IF EXISTS greenbar_migrate_check WITH (FORCE).
 *   3. CREATE DATABASE greenbar_migrate_check.
 *   4. Re-invoke src/db/migrate.ts with DATABASE_URL_ADMIN swapped to
 *      point at the temp DB.
 *   5. DROP the temp DB regardless of success / failure so local state
 *      stays clean.
 *
 * Prereq: a Postgres reachable via DATABASE_URL_ADMIN (or the default
 * docker-compose values) with permission to CREATE/DROP DATABASE. The
 * docker-compose stack's `app_admin` role satisfies this.
 *
 * Wired in via .githooks/pre-commit: if a commit touches anything
 * under src/db/migrations/, this script runs before the commit lands.
 */
import "dotenv/config";
import { Pool } from "pg";
import { spawnSync } from "node:child_process";

const ADMIN_URL =
  process.env.DATABASE_URL_ADMIN ??
  "postgres://app_admin:app_admin_pw@localhost:5432/greenbar";

const CHECK_DB = "greenbar_migrate_check";

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = "/" + dbName;
  return u.toString();
}

// CREATE/DROP DATABASE must connect to a different DB than the target.
const MAINTENANCE_URL = withDatabase(ADMIN_URL, "postgres");
const CHECK_URL = withDatabase(ADMIN_URL, CHECK_DB);

async function dropIfExists(): Promise<void> {
  const pool = new Pool({ connectionString: MAINTENANCE_URL });
  try {
    // FORCE terminates any leftover connections to the DB from a prior
    // failed run, so the DROP succeeds even if a worker is dangling.
    await pool.query(`DROP DATABASE IF EXISTS ${CHECK_DB} WITH (FORCE)`);
  } finally {
    await pool.end();
  }
}

async function createCheckDb(): Promise<void> {
  const pool = new Pool({ connectionString: MAINTENANCE_URL });
  try {
    await pool.query(`CREATE DATABASE ${CHECK_DB}`);
  } finally {
    await pool.end();
  }
}

function runMigrations(): number {
  // Re-shell to npx tsx so the migrate.ts script runs in its own process
  // with the swapped env. We can't import migrate.ts directly because
  // it reads ADMIN_URL once at module-eval time.
  const result = spawnSync(
    "npx",
    ["tsx", "src/db/migrate.ts"],
    {
      env: { ...process.env, DATABASE_URL_ADMIN: CHECK_URL },
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  return result.status ?? 1;
}

async function main(): Promise<void> {
  console.log(`• checking migrations against throwaway DB '${CHECK_DB}'`);

  await dropIfExists();
  await createCheckDb();

  const status = runMigrations();

  // Best-effort cleanup. Don't mask the original failure if drop also
  // fails — log and continue.
  try {
    await dropIfExists();
  } catch (e) {
    console.warn(`• warning: cleanup of ${CHECK_DB} failed:`, (e as Error).message);
  }

  if (status !== 0) {
    console.error(`✗ migrations failed against fresh DB (exit ${status})`);
    process.exit(status);
  }
  console.log("✓ migrations apply cleanly to a fresh database");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
