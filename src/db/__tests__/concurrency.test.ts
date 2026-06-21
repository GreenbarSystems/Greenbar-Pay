/**
 * Addendum §4.7 — optimistic concurrency on PATCH /api/ap/review/:id.
 *
 * The UPDATE pattern:
 *   UPDATE extracted_invoices
 *      SET … , updated_at = now()
 *    WHERE id = $1 AND updated_at = $2
 *
 * If two reviewers PATCH at the same If-Match, only one row should
 * update. The loser sees 0 rows affected → app returns 409.
 *
 * This test exercises the DB-level guarantee directly so we know the
 * race is impossible at the storage layer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import { organizations, documents, extractedInvoices } from "@/db/schema";

const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let pool: Pool;
let db: ReturnType<typeof drizzle>;
let orgId: string;
let docId: string;
let invoiceId: string;
let ifMatch: Date;

beforeAll(async () => {
  if (!ADMIN_URL) throw new Error("DATABASE_URL_ADMIN must be set");
  pool = new Pool({ connectionString: ADMIN_URL });
  db = drizzle(pool);

  const [org] = await db
    .insert(organizations)
    .values({ name: "Concurrency Org", slug: `conc-${Date.now()}` })
    .returning({ id: organizations.id });
  orgId = org.id;

  const [doc] = await db
    .insert(documents)
    .values({
      organizationId: orgId,
      source: "upload",
      originalFilename: "conc.pdf",
      storageKey: `documents/${orgId}/conc.pdf`,
      contentHash: `hash-conc-${Date.now()}`,
    })
    .returning({ id: documents.id });
  docId = doc.id;

  const [inv] = await db
    .insert(extractedInvoices)
    .values({
      organizationId: orgId,
      documentId: docId,
      documentType: "invoice",
      vendorName: "ACME",
      invoiceNumber: "INV-1",
      total: "100.00",
      reviewStatus: "needs_review",
      // Issue #3 fix: pin updated_at to millisecond precision so the
      // value round-trips losslessly through JS Date. Postgres `now()`
      // produces microsecond precision; reading it back as a Date
      // truncates, and subsequent WHERE updated_at = $ifMatch never
      // matches because Postgres compares the stored microsecond
      // value against the truncated millisecond Date. The real PATCH
      // route handles this by selecting updated_at as a string; here
      // we pin to millisecond precision at insert time.
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .returning({ id: extractedInvoices.id, updatedAt: extractedInvoices.updatedAt });
  invoiceId = inv.id;
  ifMatch = inv.updatedAt;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pool.end();
});

describe("Reviewer concurrency (§4.7)", () => {
  it("two concurrent edits at same If-Match → exactly one succeeds", async () => {
    // Both updates fire concurrently with the same updated_at value.
    const update = (newVendor: string) =>
      db
        .update(extractedInvoices)
        .set({ vendorName: newVendor, updatedAt: sql`now()` })
        .where(
          and(
            eq(extractedInvoices.id, invoiceId),
            eq(extractedInvoices.updatedAt, ifMatch),
          ),
        )
        .returning({ id: extractedInvoices.id });

    const [a, b] = await Promise.all([update("Alice"), update("Bob")]);

    const winnersCount = (a.length > 0 ? 1 : 0) + (b.length > 0 ? 1 : 0);
    expect(winnersCount).toBe(1);
  });

  it("a stale If-Match never matches after the winning update", async () => {
    const res = await db
      .update(extractedInvoices)
      .set({ vendorName: "Carol", updatedAt: sql`now()` })
      .where(
        and(
          eq(extractedInvoices.id, invoiceId),
          eq(extractedInvoices.updatedAt, ifMatch),
        ),
      )
      .returning({ id: extractedInvoices.id });
    expect(res).toHaveLength(0);
  });
});
