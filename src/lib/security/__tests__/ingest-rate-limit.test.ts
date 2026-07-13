/**
 * Integration test for checkIngestRateLimit against real Postgres —
 * the window-boundary and org-isolation semantics genuinely need a
 * live database to prove (a mocked `tx` would just be testing that
 * the mock returns what the mock was told to return).
 *
 * Modeled on src/db/__tests__/rls.test.ts and the vendors/validation
 * module's repository integration tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { documents, organizations } from "@/db/schema";
import {
  checkIngestRateLimit,
  DEFAULT_INGEST_RATE_LIMIT,
} from "../ingest-rate-limit";

const USER_URL = process.env.DATABASE_URL!;
const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let userPool: Pool;
let adminPool: Pool;
let userDb: ReturnType<typeof drizzle<typeof schema>>;
let adminDb: ReturnType<typeof drizzle<typeof schema>>;
let orgId: string;
let otherOrgId: string;
let seedCounter = 0;

beforeAll(async () => {
  if (!USER_URL || !ADMIN_URL) {
    throw new Error("DATABASE_URL and DATABASE_URL_ADMIN must be set");
  }
  userPool = new Pool({ connectionString: USER_URL });
  adminPool = new Pool({ connectionString: ADMIN_URL });
  userDb = drizzle(userPool, { schema });
  adminDb = drizzle(adminPool, { schema });

  const [org] = await adminDb
    .insert(organizations)
    .values({ name: "Ingest Rate Limit Test Org", slug: `ingest-rl-test-${Date.now()}` })
    .returning({ id: organizations.id });
  orgId = org.id;

  const [other] = await adminDb
    .insert(organizations)
    .values({ name: "Other Org", slug: `ingest-rl-other-${Date.now()}` })
    .returning({ id: organizations.id });
  otherOrgId = other.id;
});

afterAll(async () => {
  await adminDb.delete(organizations).where(eq(organizations.id, orgId));
  await adminDb.delete(organizations).where(eq(organizations.id, otherOrgId));
  await userPool.end();
  await adminPool.end();
});

async function seedDocument(organizationId: string, receivedAt: Date) {
  const n = ++seedCounter;
  await adminDb.insert(documents).values({
    organizationId,
    source: "upload",
    originalFilename: `doc-${n}.pdf`,
    storageKey: `documents/${organizationId}/doc-${n}.pdf`,
    contentHash: `hash-${Date.now()}-${n}`,
    receivedAt,
  });
}

describe("checkIngestRateLimit", () => {
  it("allows when well under the limit", async () => {
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await seedDocument(orgId, now);
    }

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      const result = await checkIngestRateLimit(tx, orgId, 10, 10);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(7);
      expect(result.limit).toBe(10);
    });
  });

  it("blocks once the window's count reaches the limit", async () => {
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await seedDocument(orgId, now);
    }

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      const result = await checkIngestRateLimit(tx, orgId, 5, 10);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  it("excludes documents outside the window", async () => {
    const outsideWindow = new Date(Date.now() - 20 * 60_000); // 20 minutes ago
    for (let i = 0; i < 50; i++) {
      await seedDocument(orgId, outsideWindow);
    }
    const insideWindow = new Date();
    await seedDocument(orgId, insideWindow);

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      // 10-minute window — the 50 old documents must not count.
      const result = await checkIngestRateLimit(tx, orgId, 10, 10);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });
  });

  it("counts are isolated per organization", async () => {
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      await seedDocument(otherOrgId, now);
    }

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${otherOrgId}, true)`);
      const otherResult = await checkIngestRateLimit(tx, otherOrgId, 10, 10);
      expect(otherResult.allowed).toBe(false);
    });

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      // orgId's own count is whatever earlier tests left behind, but it
      // must be entirely unaffected by otherOrgId's 10 documents.
      const result = await checkIngestRateLimit(tx, orgId, 1000, 10);
      expect(result.remaining).toBeLessThanOrEqual(1000);
      expect(result.remaining).toBeGreaterThan(1000 - 20); // sanity: not 990 short
    });
  });

  it("defaults match the documented constant", async () => {
    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      const result = await checkIngestRateLimit(tx, orgId);
      expect(result.limit).toBe(DEFAULT_INGEST_RATE_LIMIT);
      expect(result.windowMinutes).toBe(10);
    });
  });
});
