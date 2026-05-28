/**
 * Addendum §1.6: CI gate. Two orgs, each inserts a row, then we switch
 * `app.current_org_id` and assert zero visibility from the other side.
 *
 * Runs against the local Postgres from docker-compose. Requires
 * DATABASE_URL (app_user, RLS-enforced) and DATABASE_URL_ADMIN
 * (app_admin, BYPASSRLS — for setup/teardown only).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq } from "drizzle-orm";
import { organizations, documents } from "@/db/schema";

const USER_URL = process.env.DATABASE_URL!;
const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let userPool: Pool;
let adminPool: Pool;
let userDb: ReturnType<typeof drizzle>;
let adminDb: ReturnType<typeof drizzle>;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  if (!USER_URL || !ADMIN_URL) {
    throw new Error("DATABASE_URL and DATABASE_URL_ADMIN must be set");
  }
  userPool = new Pool({ connectionString: USER_URL });
  adminPool = new Pool({ connectionString: ADMIN_URL });
  userDb = drizzle(userPool);
  adminDb = drizzle(adminPool);

  // Admin (BYPASSRLS) seeds two orgs with one doc each.
  const [a] = await adminDb
    .insert(organizations)
    .values({ name: "Org A", slug: `rls-test-a-${Date.now()}` })
    .returning({ id: organizations.id });
  const [b] = await adminDb
    .insert(organizations)
    .values({ name: "Org B", slug: `rls-test-b-${Date.now()}` })
    .returning({ id: organizations.id });
  orgA = a.id;
  orgB = b.id;

  await adminDb.insert(documents).values([
    {
      organizationId: orgA,
      source: "upload",
      originalFilename: "a.pdf",
      storageKey: `documents/${orgA}/test-a.pdf`,
      contentHash: "hash-a",
    },
    {
      organizationId: orgB,
      source: "upload",
      originalFilename: "b.pdf",
      storageKey: `documents/${orgB}/test-b.pdf`,
      contentHash: "hash-b",
    },
  ]);
});

afterAll(async () => {
  // Admin cleanup; cascades through documents.
  await adminDb.delete(organizations).where(eq(organizations.id, orgA));
  await adminDb.delete(organizations).where(eq(organizations.id, orgB));
  await userPool.end();
  await adminPool.end();
});

describe("RLS tenant isolation", () => {
  it("org A only sees org A documents", async () => {
    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgA}, true)`);
      const rows = await tx.select().from(documents);
      expect(rows.every((r) => r.organizationId === orgA)).toBe(true);
      expect(rows.find((r) => r.originalFilename === "b.pdf")).toBeUndefined();
    });
  });

  it("org B only sees org B documents", async () => {
    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgB}, true)`);
      const rows = await tx.select().from(documents);
      expect(rows.every((r) => r.organizationId === orgB)).toBe(true);
      expect(rows.find((r) => r.originalFilename === "a.pdf")).toBeUndefined();
    });
  });

  it("unset GUC → no rows visible (safe default)", async () => {
    await userDb.transaction(async (tx) => {
      const rows = await tx.select().from(documents);
      expect(rows).toHaveLength(0);
    });
  });

  it("WITH CHECK blocks cross-tenant INSERT", async () => {
    await expect(
      userDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.current_org_id', ${orgA}, true)`);
        // Trying to insert a row for org B while pinned to org A — RLS must reject.
        await tx.insert(documents).values({
          organizationId: orgB,
          source: "upload",
          originalFilename: "smuggled.pdf",
          storageKey: "documents/smuggled/key",
          contentHash: "hash-smuggle",
        });
      }),
    ).rejects.toThrow();
  });
});
