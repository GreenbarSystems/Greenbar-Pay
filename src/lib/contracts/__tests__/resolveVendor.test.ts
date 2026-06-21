/**
 * Phase 9.5 PR2 — resolveContractVendor integration test.
 *
 * Seeds two vendors via the admin pool (BYPASSRLS) then exercises
 * the resolver:
 *   · exact normalized match
 *   · alias match
 *   · no match (returns null)
 *   · null name (returns null without querying)
 *   · cross-client isolation (per-client scope)
 *
 * Uses the same drizzle/Pool harness as concurrency.test.ts and
 * rls.test.ts — depends on the CI Postgres + the sidecar's
 * normalize_vendor_text() helper.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { organizations, clients, vendors } from "@/db/schema";
import { resolveContractVendor } from "@/lib/contracts/resolveVendor";

const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let orgId: string;
let clientAId: string;
let clientBId: string;

beforeAll(async () => {
  if (!ADMIN_URL) throw new Error("DATABASE_URL_ADMIN must be set");
  pool = new Pool({ connectionString: ADMIN_URL });
  // Pass `schema` so the resulting tx satisfies the schema-aware
  // Tx type that resolveContractVendor expects.
  db = drizzle(pool, { schema });

  const [org] = await db
    .insert(organizations)
    .values({ name: "Resolver Org", slug: `resolve-${Date.now()}` })
    .returning({ id: organizations.id });
  orgId = org.id;

  const [a] = await db
    .insert(clients)
    .values({ organizationId: orgId, name: "Client A", slug: `ca-${Date.now()}` })
    .returning({ id: clients.id });
  clientAId = a.id;
  const [b] = await db
    .insert(clients)
    .values({ organizationId: orgId, name: "Client B", slug: `cb-${Date.now()}` })
    .returning({ id: clients.id });
  clientBId = b.id;

  // Vendor A: canonical normalized 'acme supplies' (no aliases).
  await db.insert(vendors).values({
    organizationId: orgId,
    clientId: clientAId,
    name: "ACME Supplies LLC",
    normalizedName: sql`normalize_vendor_text('ACME Supplies LLC')`,
    aliases: [],
  });
  // Vendor B: canonical 'globex inc' but with an alias for 'globex
  // corporation' (intentionally different normalized form).
  await db.insert(vendors).values({
    organizationId: orgId,
    clientId: clientAId,
    name: "Globex Inc.",
    normalizedName: sql`normalize_vendor_text('Globex Inc.')`,
    aliases: [
      // Pre-normalized alias — the column stores the normalized form.
      "globex corporation",
    ],
  });
  // Vendor C: different client — should not match when clientId is scoped.
  await db.insert(vendors).values({
    organizationId: orgId,
    clientId: clientBId,
    name: "ACME Supplies LLC",
    normalizedName: sql`normalize_vendor_text('ACME Supplies LLC')`,
    aliases: [],
  });
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pool.end();
});

describe("resolveContractVendor", () => {
  it("returns null for a null extracted name", async () => {
    const r = await db.transaction((tx) =>
      resolveContractVendor(tx, {
        organizationId: orgId,
        extractedVendorName: null,
        clientId: null,
      }),
    );
    expect(r).toBeNull();
  });

  it("matches on exact canonical name (case + punctuation insensitive)", async () => {
    const r = await db.transaction((tx) =>
      resolveContractVendor(tx, {
        organizationId: orgId,
        extractedVendorName: "acme supplies, llc.",
        clientId: clientAId,
      }),
    );
    expect(r).not.toBeNull();
    expect(r?.method).toBe("normalized");
  });

  it("matches on a stored alias", async () => {
    const r = await db.transaction((tx) =>
      resolveContractVendor(tx, {
        organizationId: orgId,
        extractedVendorName: "Globex Corporation",
        clientId: clientAId,
      }),
    );
    expect(r).not.toBeNull();
    expect(r?.method).toBe("alias");
  });

  it("returns null when no match exists", async () => {
    const r = await db.transaction((tx) =>
      resolveContractVendor(tx, {
        organizationId: orgId,
        extractedVendorName: "Nonexistent Vendor LLC",
        clientId: clientAId,
      }),
    );
    expect(r).toBeNull();
  });

  it("respects per-client scope (does not match the other client's vendor)", async () => {
    // Client A has ACME, Client B also has ACME. Asking under Client B
    // for ACME must return Client B's vendor row, not Client A's.
    const aResult = await db.transaction((tx) =>
      resolveContractVendor(tx, {
        organizationId: orgId,
        extractedVendorName: "ACME Supplies LLC",
        clientId: clientAId,
      }),
    );
    const bResult = await db.transaction((tx) =>
      resolveContractVendor(tx, {
        organizationId: orgId,
        extractedVendorName: "ACME Supplies LLC",
        clientId: clientBId,
      }),
    );
    expect(aResult).not.toBeNull();
    expect(bResult).not.toBeNull();
    expect(aResult?.vendorId).not.toBe(bResult?.vendorId);
  });
});
