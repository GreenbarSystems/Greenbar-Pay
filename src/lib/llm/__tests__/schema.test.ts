/**
 * Sanity test on the invoice extraction schema — the example payload from
 * the PRD must parse, and obvious malformations must fail.
 */
import { describe, it, expect } from "vitest";
import { InvoiceExtractionSchema } from "@/lib/llm/schema";

const PRD_EXAMPLE = {
  documentType: "invoice",
  vendorName: "ABC Supplies LLC",
  vendorAddress: null,
  remitToName: null,
  remitToAddress: null,
  invoiceNumber: "INV-10492",
  invoiceDate: "2026-05-12",
  dueDate: "2026-06-11",
  paymentTerms: null,
  purchaseOrderNumber: null,
  currency: "USD",
  subtotal: 1250.0,
  tax: 103.13,
  shipping: 0.0,
  discount: 0.0,
  total: 1353.13,
  lineItems: [
    {
      description: "Office supplies",
      quantity: 10,
      unitPrice: 125.0,
      amount: 1250.0,
    },
  ],
  warnings: [],
  confidence: "high",
};

describe("InvoiceExtractionSchema", () => {
  it("accepts the PRD example payload", () => {
    const r = InvoiceExtractionSchema.safeParse(PRD_EXAMPLE);
    expect(r.success).toBe(true);
  });

  it("rejects non-ISO dates", () => {
    const r = InvoiceExtractionSchema.safeParse({
      ...PRD_EXAMPLE,
      invoiceDate: "05/12/2026",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown confidence label", () => {
    const r = InvoiceExtractionSchema.safeParse({
      ...PRD_EXAMPLE,
      confidence: "very-high",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a stringified total", () => {
    const r = InvoiceExtractionSchema.safeParse({
      ...PRD_EXAMPLE,
      total: "1353.13",
    });
    expect(r.success).toBe(false);
  });
});
