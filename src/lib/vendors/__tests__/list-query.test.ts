/**
 * Integration test for fetchVendorsPage's cursor pagination — the
 * riskiest logic in the pagination pass (raw row-value SQL comparison,
 * explicit casts, NULL handling on lastInvoiceDate). TypeScript's
 * checker can't catch a wrong NULL-ordering or a missed cast; this
 * exercises the real query against Postgres.
 *
 * Modeled on src/db/__tests__/rls.test.ts (admin pool seeds/tears down,
 * user pool + set_config runs the RLS-scoped query under test).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { organizations, vendors } from "@/db/schema";
import { fetchVendorsPage, type VendorsCursor } from "@/lib/vendors/list-query";

const USER_URL = process.env.DATABASE_URL!;
const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let userPool: Pool;
let adminPool: Pool;
let userDb: ReturnType<typeof drizzle<typeof schema>>;
let adminDb: ReturnType<typeof drizzle<typeof schema>>;
let orgId: string;

// Ties at invoiceCount=5: one NULL lastInvoiceDate, one real date, to
// exercise the NULLS-LAST-DESC sentinel substitution. Named vendors so
// assertions read clearly instead of by index.
const SEED = [
  { name: "Zenith Supplies", invoiceCount: 10, lastInvoiceDate: "2026-06-01" },
  { name: "Acme Corp", invoiceCount: 5, lastInvoiceDate: "2026-05-01" },
  { name: "Beta LLC", invoiceCount: 5, lastInvoiceDate: null },
  { name: "Gamma Inc", invoiceCount: 5, lastInvoiceDate: "2026-05-01" },
  { name: "Delta Co", invoiceCount: 1, lastInvoiceDate: null },
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

describe("fetchVendorsPage cursor pagination", () => {
  it("orders by invoiceCount DESC, lastInvoiceDate DESC NULLS LAST, id DESC tiebreaker", async () => {
    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      const { pageRows, hasNext } = await fetchVendorsPage(tx, {
        organizationId: orgId,
        cursor: null,
        pageSize: 200,
      });

      expect(hasNext).toBe(false);
      expect(pageRows.map((r) => r.name)).toEqual([
        "Zenith Supplies",
        "Acme Corp",
        "Gamma Inc",
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
        const page = await fetchVendorsPage(tx, {
          organizationId: orgId,
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
        "Acme Corp",
        "Gamma Inc",
        "Beta LLC",
        "Delta Co",
      ]);
      expect(new Set(seen).size).toBe(SEED.length);
    });
  });

  it("respects clientFilter alongside the cursor", async () => {
    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      const { pageRows } = await fetchVendorsPage(tx, {
        organizationId: orgId,
        cursor: null,
        pageSize: 200,
        clientFilter: eq(vendors.name, "Acme Corp"),
      });
      expect(pageRows.map((r) => r.name)).toEqual(["Acme Corp"]);
    });
  });
});
