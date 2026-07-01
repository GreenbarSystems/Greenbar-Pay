/**
 * Integration test for drizzleVendorRepository.findPage's cursor
 * pagination — the riskiest logic in the vendors module (raw row-value
 * SQL comparison, explicit casts, NULL handling on lastInvoiceDate,
 * plus the per-client visibility OR/isNull composition). TypeScript's
 * checker can't catch a wrong NULL-ordering, a missed cast, or an
 * inverted visibility rule; this exercises the real query against
 * Postgres.
 *
 * Moved from src/lib/vendors/__tests__/list-query.test.ts as part of
 * the vendors-module extraction — same seed data and assertions, now
 * calling the repository instead of a standalone page-query function,
 * plus a new case covering per-client visibility (findPage previously
 * had no test exercising the isNull/inArray OR composition at all).
 *
 * Modeled on src/db/__tests__/rls.test.ts (admin pool seeds/tears down,
 * user pool + set_config runs the RLS-scoped query under test).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { clients, organizations, vendors } from "@/db/schema";
import { drizzleVendorRepository } from "@/modules/vendors/infrastructure/drizzle-vendor.repository";
import type { VendorsCursor } from "@/modules/vendors/application/ports";

const USER_URL = process.env.DATABASE_URL!;
const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let userPool: Pool;
let adminPool: Pool;
let userDb: ReturnType<typeof drizzle<typeof schema>>;
let adminDb: ReturnType<typeof drizzle<typeof schema>>;
let orgId: string;

// Ties at invoiceCount=5: Acme/Gamma share both sort keys (invoiceCount,
// lastInvoiceDate), so their relative order depends entirely on the id
// DESC tiebreaker — explicit ids make that deterministic instead of
// depending on defaultRandom() UUID generation order. Beta's NULL
// lastInvoiceDate exercises the NULLS-LAST-DESC sentinel substitution.
const SEED = [
  {
    id: "00000000-0000-0000-0000-000000000005",
    name: "Zenith Supplies",
    invoiceCount: 10,
    lastInvoiceDate: "2026-06-01",
  },
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Acme Corp",
    invoiceCount: 5,
    lastInvoiceDate: "2026-05-01",
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Beta LLC",
    invoiceCount: 5,
    lastInvoiceDate: null,
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Gamma Inc",
    invoiceCount: 5,
    lastInvoiceDate: "2026-05-01",
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    name: "Delta Co",
    invoiceCount: 1,
    lastInvoiceDate: null,
  },
] as const;

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
    .values({ name: "Vendors Pagination Test Org", slug: `vendors-pg-test-${Date.now()}` })
    .returning({ id: organizations.id });
  orgId = org.id;

  await adminDb.insert(vendors).values(
    SEED.map((v) => ({
      id: v.id,
      organizationId: orgId,
      name: v.name,
      normalizedName: v.name.toLowerCase(),
      invoiceCount: v.invoiceCount,
      lastInvoiceDate: v.lastInvoiceDate,
    })),
  );
});

afterAll(async () => {
  await adminDb.delete(organizations).where(eq(organizations.id, orgId));
  await userPool.end();
  await adminPool.end();
});

describe("drizzleVendorRepository.findPage cursor pagination", () => {
  it("orders by invoiceCount DESC, lastInvoiceDate DESC NULLS LAST, id DESC tiebreaker", async () => {
    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      const { pageRows, hasNext } = await drizzleVendorRepository.findPage(tx, {
        organizationId: orgId,
        permittedClientIds: [],
        cursor: null,
        pageSize: 200,
      });

      expect(hasNext).toBe(false);
      expect(pageRows.map((r) => r.name)).toEqual([
        "Zenith Supplies",
        "Gamma Inc",
        "Acme Corp",
        "Beta LLC",
        "Delta Co",
      ]);
    });
  });

  it("traverses all rows across small pages with no gaps or duplicates", async () => {
    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);

      const seen: string[] = [];
      let cursor: VendorsCursor | null = null;
      let hasNext = true;
      let iterations = 0;

      while (hasNext) {
        iterations++;
        if (iterations > SEED.length + 1) {
          throw new Error("pagination did not terminate — possible infinite loop");
        }
        const page = await drizzleVendorRepository.findPage(tx, {
          organizationId: orgId,
          permittedClientIds: [],
          cursor,
          pageSize: 2,
        });
        seen.push(...page.pageRows.map((r) => r.name));
        hasNext = page.hasNext;
        if (hasNext) {
          const last = page.pageRows[page.pageRows.length - 1];
          cursor = {
            invoiceCount: last.invoiceCount,
            lastInvoiceDate: last.lastInvoiceDate,
            id: last.id,
          };
        }
      }

      expect(seen).toEqual([
        "Zenith Supplies",
        "Gamma Inc",
        "Acme Corp",
        "Beta LLC",
        "Delta Co",
      ]);
      expect(new Set(seen).size).toBe(SEED.length);
    });
  });

  it("permittedClientIds scopes visibility: null = no restriction, [] = unaffiliated only, [id] = unaffiliated + that client", async () => {
    const [client] = await adminDb
      .insert(clients)
      .values({ organizationId: orgId, name: "Scoped Client", slug: `scoped-client-${Date.now()}` })
      .returning({ id: clients.id });

    await adminDb.insert(vendors).values({
      organizationId: orgId,
      clientId: client.id,
      name: "Scoped Vendor",
      normalizedName: "scoped vendor",
      invoiceCount: 7,
    });

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);

      const restricted = await drizzleVendorRepository.findPage(tx, {
        organizationId: orgId,
        permittedClientIds: [],
        cursor: null,
        pageSize: 200,
      });
      expect(restricted.pageRows.some((r) => r.name === "Scoped Vendor")).toBe(false);
      expect(restricted.pageRows).toHaveLength(SEED.length);

      const grantedForClient = await drizzleVendorRepository.findPage(tx, {
        organizationId: orgId,
        permittedClientIds: [client.id],
        cursor: null,
        pageSize: 200,
      });
      expect(grantedForClient.pageRows.some((r) => r.name === "Scoped Vendor")).toBe(true);
      expect(grantedForClient.pageRows).toHaveLength(SEED.length + 1);

      const unrestricted = await drizzleVendorRepository.findPage(tx, {
        organizationId: orgId,
        permittedClientIds: null,
        cursor: null,
        pageSize: 200,
      });
      expect(unrestricted.pageRows.some((r) => r.name === "Scoped Vendor")).toBe(true);
      expect(unrestricted.pageRows).toHaveLength(SEED.length + 1);
    });
  });
});
