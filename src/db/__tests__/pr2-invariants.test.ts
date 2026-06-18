/**
 * PR2 invariants — append-only validation_results + per-org idempotency PK.
 *
 * Requires the local Postgres stack (`docker compose up -d`) and the new
 * sidecar migration applied (`npm run db:migrate`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  organizations,
  validationResults,
  apiIdempotencyKeys,
} from "@/db/schema";

const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let pool: Pool;
let db: ReturnType<typeof drizzle>;
let orgAId: string;
let orgBId: string;

beforeAll(async () => {
  if (!ADMIN_URL) throw new Error("DATABASE_URL_ADMIN must be set");
  pool = new Pool({ connectionString: ADMIN_URL });
  db = drizzle(pool);

  const [a] = await db
    .insert(organizations)
    .values({ name: "PR2 A", slug: `pr2-a-${Date.now()}` })
    .returning({ id: organizations.id });
  const [b] = await db
    .insert(organizations)
    .values({ name: "PR2 B", slug: `pr2-b-${Date.now()}` })
    .returning({ id: organizations.id });
  orgAId = a.id;
  orgBId = b.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgAId));
  await db.delete(organizations).where(eq(organizations.id, orgBId));
  await pool.end();
});

describe("validation_results append-only (review #4)", () => {
  it("supersede preserves prior row, only one active at a time", async () => {
    const entityId = crypto.randomUUID();

    // Initial blocking finding.
    await db.insert(validationResults).values({
      organizationId: orgAId,
      entityType: "extracted_invoice",
      entityId,
      passed: false,
      severity: "blocking",
      errorsJson: [{ code: "missing_invoice_number", severity: "blocking" }],
    });

    // Re-run validation: supersede the prior + insert fresh.
    await db
      .update(validationResults)
      .set({ supersededAt: sql`now()` })
      .where(
        and(
          eq(validationResults.entityType, "extracted_invoice"),
          eq(validationResults.entityId, entityId),
          isNull(validationResults.supersededAt),
        ),
      );
    await db.insert(validationResults).values({
      organizationId: orgAId,
      entityType: "extracted_invoice",
      entityId,
      passed: true,
      severity: "warning",
      errorsJson: [],
    });

    const all = await db
      .select({ id: validationResults.id, supersededAt: validationResults.supersededAt })
      .from(validationResults)
      .where(eq(validationResults.entityId, entityId));
    expect(all).toHaveLength(2); // Both rows preserved.

    const active = all.filter((r) => r.supersededAt === null);
    expect(active).toHaveLength(1); // Exactly one active.
  });
});

describe("api_idempotency_keys per-org PK (review #5)", () => {
  it("same key in two orgs does not collide", async () => {
    const key = `replay-test-${Date.now()}`;

    await db.insert(apiIdempotencyKeys).values({
      organizationId: orgAId,
      key,
      requestHash: "hash-a",
      responseStatus: 200,
      responseBody: { ok: "a" },
    });

    // Same `key` value, different org — must succeed.
    await db.insert(apiIdempotencyKeys).values({
      organizationId: orgBId,
      key,
      requestHash: "hash-b",
      responseStatus: 200,
      responseBody: { ok: "b" },
    });

    // Org A's row still distinct.
    const aRows = await db
      .select()
      .from(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.organizationId, orgAId),
          eq(apiIdempotencyKeys.key, key),
        ),
      );
    expect(aRows).toHaveLength(1);
    expect((aRows[0].responseBody as { ok: string }).ok).toBe("a");

    // Org B's row distinct.
    const bRows = await db
      .select()
      .from(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.organizationId, orgBId),
          eq(apiIdempotencyKeys.key, key),
        ),
      );
    expect(bRows).toHaveLength(1);
    expect((bRows[0].responseBody as { ok: string }).ok).toBe("b");
  });

  it("same (org, key) twice rejects", async () => {
    const key = `dup-test-${Date.now()}`;
    await db.insert(apiIdempotencyKeys).values({
      organizationId: orgAId,
      key,
      requestHash: "h1",
      responseStatus: 200,
      responseBody: {},
    });
    await expect(
      db.insert(apiIdempotencyKeys).values({
        organizationId: orgAId,
        key,
        requestHash: "h2",
        responseStatus: 200,
        responseBody: {},
      }),
    ).rejects.toThrow();
  });
});
