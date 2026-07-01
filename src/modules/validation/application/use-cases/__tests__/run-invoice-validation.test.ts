/**
 * Integration test for runInvoiceValidation — the riskiest logic moved
 * in this module's extraction (advisory lock, vendor matching, batched
 * CASE update for line confidence, soft-supersede + insert on
 * validation_results). src/lib/validation/run.ts had ZERO direct test
 * coverage before this refactor (only reachable via the job or PATCH
 * route, both needing a live Postgres) — this closes that gap for the
 * two most load-bearing paths: a clean invoice and a blocking one.
 *
 * Modeled on src/db/__tests__/rls.test.ts and
 * src/modules/vendors/infrastructure/__tests__/drizzle-vendor.repository.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  documents,
  extractedInvoiceLines,
  extractedInvoices,
  organizations,
  validationResults,
  vendorMatches,
  vendors,
} from "@/db/schema";
import { runInvoiceValidation } from "../run-invoice-validation.usecase";
import { drizzleInvoiceRepository } from "../../../infrastructure/drizzle-invoice.repository";
import { drizzleVendorCandidateRepository } from "../../../infrastructure/drizzle-vendor-candidate.repository";
import { drizzleVendorContractRepository } from "../../../infrastructure/drizzle-vendor-contract.repository";
import { drizzleDocumentRepository } from "../../../infrastructure/drizzle-document.repository";
import { drizzleValidationResultsRepository } from "../../../infrastructure/drizzle-validation-results.repository";
import { drizzleVendorMatchWriteRepository } from "../../../infrastructure/drizzle-vendor-match-write.repository";
import { drizzleValidationAuditRepository } from "../../../infrastructure/drizzle-validation-audit.repository";

const USER_URL = process.env.DATABASE_URL!;
const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

const deps = {
  invoiceRepository: drizzleInvoiceRepository,
  vendorCandidateRepository: drizzleVendorCandidateRepository,
  vendorContractRepository: drizzleVendorContractRepository,
  documentRepository: drizzleDocumentRepository,
  validationResultsRepository: drizzleValidationResultsRepository,
  vendorMatchWriteRepository: drizzleVendorMatchWriteRepository,
  auditRepository: drizzleValidationAuditRepository,
};

let userPool: Pool;
let adminPool: Pool;
let userDb: ReturnType<typeof drizzle<typeof schema>>;
let adminDb: ReturnType<typeof drizzle<typeof schema>>;
let orgId: string;
let vendorId: string;
let documentId: string;

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
    .values({ name: "Validation Test Org", slug: `validation-test-${Date.now()}` })
    .returning({ id: organizations.id });
  orgId = org.id;

  const [vendor] = await adminDb
    .insert(vendors)
    .values({
      organizationId: orgId,
      name: "Acme Supplies LLC",
      normalizedName: "acme supplies llc",
    })
    .returning({ id: vendors.id });
  vendorId = vendor.id;

  const [doc] = await adminDb
    .insert(documents)
    .values({
      organizationId: orgId,
      source: "upload",
      originalFilename: "invoice.pdf",
      storageKey: `documents/${orgId}/invoice.pdf`,
      contentHash: `hash-${Date.now()}`,
    })
    .returning({ id: documents.id });
  documentId = doc.id;
});

afterAll(async () => {
  await adminDb.delete(organizations).where(eq(organizations.id, orgId));
  await userPool.end();
  await adminPool.end();
});

async function seedInvoice(overrides: Partial<typeof extractedInvoices.$inferInsert>) {
  const [invoice] = await adminDb
    .insert(extractedInvoices)
    .values({
      organizationId: orgId,
      documentId,
      documentType: "invoice",
      vendorName: "Acme Supplies LLC",
      invoiceNumber: `INV-${Date.now()}`,
      invoiceDate: "2026-06-01",
      dueDate: "2026-07-01",
      currency: "USD",
      subtotal: "100.00",
      tax: "0.00",
      shipping: "0.00",
      discount: "0.00",
      total: "100.00",
      ...overrides,
    })
    .returning();
  return invoice;
}

describe("runInvoiceValidation", () => {
  it("clean invoice: no blocking findings, exact vendor match, validation_results + vendor_matches rows inserted", async () => {
    const invoice = await seedInvoice({});

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);

      const result = await runInvoiceValidation(tx, deps, {
        organizationId: orgId,
        extractedInvoiceId: invoice.id,
        documentId,
      });

      expect(result.newReviewStatus).toBe("pending");
      expect(result.vendorMatch?.vendorId).toBe(vendorId);
      expect(result.vendorMatch?.confidence).toBe("high");
      expect(result.findings.some((f) => f.severity === "blocking")).toBe(false);
    });

    const [vr] = await adminDb
      .select()
      .from(validationResults)
      .where(eq(validationResults.entityId, invoice.id));
    expect(vr).toBeDefined();
    expect(vr.passed).toBe(true);
    expect(vr.supersededAt).toBeNull();

    const [vm] = await adminDb
      .select()
      .from(vendorMatches)
      .where(eq(vendorMatches.extractedInvoiceId, invoice.id));
    expect(vm).toBeDefined();
    expect(vm.vendorId).toBe(vendorId);
    expect(vm.matchMethod).toBe("exact_normalized");
  });

  it("missing invoice number: blocking finding, newReviewStatus is needs_review", async () => {
    const invoice = await seedInvoice({ invoiceNumber: null });

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);

      const result = await runInvoiceValidation(tx, deps, {
        organizationId: orgId,
        extractedInvoiceId: invoice.id,
        documentId,
      });

      expect(result.newReviewStatus).toBe("needs_review");
      expect(
        result.findings.find((f) => f.code === "missing_invoice_number")?.severity,
      ).toBe("blocking");
    });

    const [vr] = await adminDb
      .select()
      .from(validationResults)
      .where(eq(validationResults.entityId, invoice.id));
    expect(vr.passed).toBe(false);
    expect(vr.severity).toBe("blocking");
  });

  it("re-running validation soft-supersedes the prior active row instead of leaving two active rows", async () => {
    const invoice = await seedInvoice({});

    for (let i = 0; i < 2; i++) {
      await userDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
        await runInvoiceValidation(tx, deps, {
          organizationId: orgId,
          extractedInvoiceId: invoice.id,
          documentId,
        });
      });
    }

    const rows = await adminDb
      .select()
      .from(validationResults)
      .where(eq(validationResults.entityId, invoice.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.supersededAt === null)).toHaveLength(1);
  });

  it("persists per-line confidence when the invoice has priced lines", async () => {
    const invoice = await seedInvoice({});
    await adminDb.insert(extractedInvoiceLines).values({
      organizationId: orgId,
      extractedInvoiceId: invoice.id,
      lineNumber: 1,
      description: "Widget assembly service",
      unitPrice: "42.00",
      amount: "42.00",
    });

    await userDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
      await runInvoiceValidation(tx, deps, {
        organizationId: orgId,
        extractedInvoiceId: invoice.id,
        documentId,
      });
    });

    const [line] = await adminDb
      .select()
      .from(extractedInvoiceLines)
      .where(eq(extractedInvoiceLines.extractedInvoiceId, invoice.id));
    // First time this keyword has been seen from this vendor → "new".
    expect(line.confidenceScore).toBe("new");
    expect(line.updatedAt).not.toBeNull();
  });
});
