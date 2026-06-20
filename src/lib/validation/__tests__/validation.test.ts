import { describe, it, expect } from "vitest";
import {
  validateInvoice,
  blockingPresent,
  duplicateKey,
  normalizeVendor,
  MATH_TOLERANCE,
} from "@/lib/validation";

const goodInvoice = {
  documentType: "invoice",
  vendorName: "ABC Supplies LLC",
  invoiceNumber: "INV-10492",
  invoiceDate: "2026-05-12",
  dueDate: "2026-06-11",
  currency: "USD",
  subtotal: 1250.0,
  tax: 103.13,
  shipping: 0.0,
  discount: 0.0,
  total: 1353.13,
  lineItems: [{}],
};

const inputs = (overrides: Partial<typeof goodInvoice> = {}) => ({
  invoice: { ...goodInvoice, ...overrides },
  priorApprovedKeys: new Set<string>(),
  vendorMatch: null,
  textLength: 500,
});

describe("validateInvoice", () => {
  it("passes a clean invoice", () => {
    const f = validateInvoice(inputs());
    expect(blockingPresent(f)).toBe(false);
  });

  it("blocks on missing invoice number", () => {
    const f = validateInvoice(inputs({ invoiceNumber: null }));
    expect(f.find((x) => x.code === "missing_invoice_number")?.severity).toBe("blocking");
  });

  it("blocks on missing vendor name", () => {
    const f = validateInvoice(inputs({ vendorName: null }));
    expect(f.find((x) => x.code === "missing_vendor_name")?.severity).toBe("blocking");
  });

  it("blocks on invalid invoice date", () => {
    const f = validateInvoice(inputs({ invoiceDate: "13/45/2026" }));
    expect(f.find((x) => x.code === "invalid_invoice_date")?.severity).toBe("blocking");
  });

  it("blocks when documentType is not invoice/credit_memo", () => {
    const f = validateInvoice(inputs({ documentType: "statement" }));
    expect(f.find((x) => x.code === "not_an_invoice")?.severity).toBe("blocking");
  });

  it("blocks on duplicate vendor+invoice_number against priors", () => {
    const key = duplicateKey("ABC Supplies LLC", "INV-10492");
    const f = validateInvoice({
      ...inputs(),
      priorApprovedKeys: new Set([key]),
    });
    expect(f.find((x) => x.code === "duplicate_invoice")?.severity).toBe("blocking");
  });

  // PR11 M8 — finding message reaches Anthropic via the briefing prompt.
  // Vendor name + invoice number must NOT appear there.
  it("duplicate_invoice message does not echo vendor name or invoice number", () => {
    const key = duplicateKey("ABC Supplies LLC", "INV-10492");
    const f = validateInvoice({
      ...inputs(),
      priorApprovedKeys: new Set([key]),
    });
    const dup = f.find((x) => x.code === "duplicate_invoice")!;
    expect(dup.message).not.toContain("ABC Supplies LLC");
    expect(dup.message).not.toContain("INV-10492");
    // Structured context still carries the key for the sanctioned audit row.
    expect(dup.context).toHaveProperty("duplicateKey", key);
  });

  // PR11 C6 — drift message must not carry exact dollar amounts.
  it("unit_price_drift message does not carry exact dollar figures", () => {
    const f = validateInvoice({
      ...inputs(),
      lineScores: [
        {
          lineNumber: 1,
          keyword: "consulting",
          score: "low",
          rateDrift: true,
          unitPrice: 312.4,
          historyAvg: 245.0,
          stddevDistance: 3.2,
        },
      ],
    });
    const drift = f.find((x) => x.code === "unit_price_drift")!;
    expect(drift.message).not.toMatch(/\$\d/);
    expect(drift.message).not.toMatch(/%/);
    expect(drift.context).toMatchObject({
      lineNumber: 1,
      historyAvg: 245.0,
      unitPrice: 312.4,
    });
  });

  it("warns when due date is before invoice date", () => {
    const f = validateInvoice(inputs({ dueDate: "2026-04-01" }));
    expect(f.find((x) => x.code === "due_date_before_invoice_date")?.severity).toBe("warning");
  });

  it("warns on math mismatch beyond tolerance", () => {
    const f = validateInvoice(inputs({ total: 1500 }));
    expect(f.find((x) => x.code === "math_mismatch")?.severity).toBe("warning");
  });

  it("accepts math within tolerance", () => {
    const f = validateInvoice(inputs({ total: 1353.14 })); // off by 0.01
    expect(f.find((x) => x.code === "math_mismatch")).toBeUndefined();
    expect(MATH_TOLERANCE).toBe(0.02);
  });

  it("warns on low vendor match", () => {
    const f = validateInvoice({
      ...inputs(),
      vendorMatch: { confidence: "low", score: 0.2 },
    });
    expect(f.find((x) => x.code === "low_vendor_match")?.severity).toBe("warning");
  });

  it("warns on low text length", () => {
    const f = validateInvoice({ ...inputs(), textLength: 42 });
    expect(f.find((x) => x.code === "low_text_quality")?.severity).toBe("warning");
  });
});

describe("normalizeVendor", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeVendor("ABC Supplies, LLC.")).toBe("abc supplies llc");
    expect(normalizeVendor("  ACME   Inc.  ")).toBe("acme inc");
  });
});
