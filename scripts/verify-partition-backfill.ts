/**
 * verify-partition-backfill — regression test for the audit_events
 * RANGE-partition migration (0030) against a database that actually
 * HAS pre-existing historical data spanning multiple months.
 *
 * Why this exists: an earlier version of 0030 assumed Postgres
 * auto-migrates rows out of a DEFAULT partition when a new explicit
 * partition is created that overlaps them. That's false — Postgres
 * scans DEFAULT and ERRORS on conflict instead of moving anything.
 * The bug was invisible to CI because CI's Postgres is always freshly
 * empty when migrations run, so there was never any historical data
 * to conflict with — CI validated a path that has nothing to do with
 * how the migration behaves against real data.
 *
 * This script closes that gap by deliberately seeding synthetic
 * audit_events rows spanning several months — including the CURRENT
 * month, the exact case that broke the original migration — BEFORE
 * running 0030, then asserting the migration succeeds and every row
 * landed in its correct monthly partition with none left in DEFAULT.
 *
 * Pattern (matches scripts/migrate-check.ts):
 *   1. CREATE a throwaway database.
 *   2. Apply every migration up to (not including) 0030, via the same
 *      applyMigrations() function src/db/migrate.ts's CLI uses — not
 *      a reimplementation that could drift out of sync with it.
 *   3. Seed an organization + synthetic audit_events rows spanning
 *      4 months, including "this month".
 *   4. Apply 0030 itself — the actual file on disk, unmodified.
 *   5. Assert: no error; every row still present (no data loss); each
 *      explicit monthly partition holds exactly the rows seeded for
 *      that month; audit_events_default is empty; the renamed-away
 *      backup table still has the original row count; RLS is
 *      enabled+forced on the new table and on every partition.
 *   6. DROP the throwaway database regardless of outcome.
 *
 * Run: npm run db:verify-partition-backfill (needs a reachable
 * Postgres with CREATE/DROP DATABASE privileges — same
 * DATABASE_URL_ADMIN convention as db:migrate:check).
 */
import "dotenv/config";
import { Pool } from "pg";
import { applyMigrations, applyOneSidecar } from "../src/db/migrate";

const ADMIN_URL =
  process.env.DATABASE_URL_ADMIN ??
  "postgres://app_admin:app_admin_pw@localhost:5432/greenbar";

const CHECK_DB = "greenbar_partition_backfill_check";
const SIDECAR_UNDER_TEST = "0030_partition_audit_events.sql";

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
    // FORCE terminates any leftover connections from a prior failed
    // run so the DROP succeeds even if a connection is dangling.
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

/**
 * Seeded month offsets relative to "now", in whole calendar months.
 * 0 is THIS month — the exact case that broke the original migration
 * (historical rows land in DEFAULT, then the current-month partition
 * creation scans DEFAULT and conflicts with them).
 */
const SEED_MONTH_OFFSETS = [-3, -2, -1, 0];
const ROWS_PER_MONTH = 5;

interface SeedResult {
  orgId: string;
  totalRows: number;
  /** partition table name -> expected row count */
  rowsByPartition: Map<string, number>;
}

function partitionName(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `audit_events_y${y}m${m}`;
}

async function seedHistoricalData(pool: Pool): Promise<SeedResult> {
  const {
    rows: [{ id: orgId }],
  } = await pool.query(
    `INSERT INTO organizations (name, slug) VALUES ('Backfill Test Org', 'backfill-test-org') RETURNING id`,
  );

  const rowsByPartition = new Map<string, number>();
  let totalRows = 0;
  const now = new Date();

  for (const offset of SEED_MONTH_OFFSETS) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const key = partitionName(monthStart);
    for (let i = 0; i < ROWS_PER_MONTH; i++) {
      // Spread across the month (day 1, 8, 15, ...) rather than
      // clustering everything at midnight on the 1st — exercises the
      // partition range boundaries more realistically.
      const createdAt = new Date(monthStart);
      createdAt.setUTCDate(1 + i * 6);
      await pool.query(
        `INSERT INTO audit_events
           (organization_id, actor_type, action, entity_type, entity_id, metadata_json, created_at)
         VALUES ($1, 'system', 'test.seed', 'document', gen_random_uuid(), '{}'::jsonb, $2)`,
        [orgId, createdAt.toISOString()],
      );
      totalRows++;
    }
    rowsByPartition.set(key, ROWS_PER_MONTH);
  }

  return { orgId, totalRows, rowsByPartition };
}

async function assertBackfillCorrect(pool: Pool, seed: SeedResult): Promise<void> {
  const failures: string[] = [];

  const {
    rows: [{ n: totalAfter }],
  } = await pool.query(`SELECT count(*)::int AS n FROM audit_events`);
  if (totalAfter !== seed.totalRows) {
    failures.push(
      `expected ${seed.totalRows} total rows in audit_events, found ${totalAfter} — DATA LOSS`,
    );
  }

  for (const [partition, expectedCount] of seed.rowsByPartition) {
    const exists = await pool.query(`SELECT 1 FROM pg_class WHERE relname = $1`, [partition]);
    if (exists.rowCount === 0) {
      failures.push(`expected partition ${partition} to exist, but it was never created`);
      continue;
    }
    const {
      rows: [{ n: actualCount }],
    } = await pool.query(`SELECT count(*)::int AS n FROM ${partition}`);
    if (actualCount !== expectedCount) {
      failures.push(
        `partition ${partition}: expected ${expectedCount} rows, found ${actualCount}`,
      );
    }
  }

  const {
    rows: [{ n: defaultCount }],
  } = await pool.query(`SELECT count(*)::int AS n FROM audit_events_default`);
  if (defaultCount !== 0) {
    failures.push(
      `expected audit_events_default to be EMPTY after backfill, found ${defaultCount} row(s) — ` +
        `this is exactly the regression this test exists to catch`,
    );
  }

  const {
    rows: [{ n: backupCount }],
  } = await pool.query(`SELECT count(*)::int AS n FROM audit_events_pre_partition_backup`);
  if (backupCount !== seed.totalRows) {
    failures.push(
      `expected the renamed-away backup table to retain all ${seed.totalRows} original rows, found ${backupCount}`,
    );
  }

  const tablesToCheckRls = ["audit_events", ...seed.rowsByPartition.keys()];
  for (const table of tablesToCheckRls) {
    const {
      rows: [rlsRow],
    } = await pool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    if (!rlsRow?.relrowsecurity || !rlsRow?.relforcerowsecurity) {
      failures.push(
        `expected RLS enabled+forced on ${table}, found ` +
          `relrowsecurity=${rlsRow?.relrowsecurity} relforcerowsecurity=${rlsRow?.relforcerowsecurity}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `verify-partition-backfill: ${failures.length} assertion(s) failed:\n` +
        failures.map((f) => `  - ${f}`).join("\n"),
    );
  }
}

async function main(): Promise<void> {
  console.log(
    `• verifying ${SIDECAR_UNDER_TEST} backfill against throwaway DB '${CHECK_DB}' seeded with historical data`,
  );

  await dropIfExists();
  await createCheckDb();

  const pool = new Pool({ connectionString: CHECK_URL });
  try {
    console.log(`• applying migrations up to (not including) ${SIDECAR_UNDER_TEST}…`);
    await applyMigrations(pool, { stopBeforeSidecar: SIDECAR_UNDER_TEST });

    console.log(
      `• seeding synthetic audit_events rows across ${SEED_MONTH_OFFSETS.length} months (including the current month)…`,
    );
    const seed = await seedHistoricalData(pool);
    console.log(`  seeded ${seed.totalRows} rows for org ${seed.orgId}`);

    console.log(`• applying ${SIDECAR_UNDER_TEST} (the migration under test)…`);
    await applyOneSidecar(pool, SIDECAR_UNDER_TEST);

    console.log("• asserting partition placement…");
    await assertBackfillCorrect(pool, seed);

    console.log(
      "✓ 0030 correctly backfills pre-existing historical data with no rows left in DEFAULT",
    );
  } finally {
    await pool.end();
    try {
      await dropIfExists();
    } catch (e) {
      console.warn(`• warning: cleanup of ${CHECK_DB} failed:`, (e as Error).message);
    }
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
