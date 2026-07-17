import { describe, it, expect } from "vitest";
import { toCsv, toJson, type ExportRow } from "@/lib/export/format";

const baseRow: ExportRow = {
  invoice_id: "inv-1",
  document_id: "doc-1",
  vendor_name: "ABC Supplies LLC",
  vendor_address: null,
  invoice_number: "INV-10492",
  invoice_date: "2026-05-12",
  due_date: "2026-06-11",
  purchase_order_number: null,
  payment_terms: null,
  currency: "USD",
  subtotal: "1250.00",
  tax: "103.13",
  shipping: "0.00",
  discount: "0.00",
  total: "1353.13",
  document_type: "invoice",
  confidence: "high",
  approved_at: "2026-06-05T12:00:00Z",
  po_match_status: null,
  po_variance_pct: null,
  line_items: [],
};

describe("toCsv", () => {
  it("emits a header + data row with CRLF line endings", () => {
    const csv = toCsv([baseRow]);
    const [header, data] = csv.split("\r\n");
    expect(header).toContain("invoice_id");
    expect(header).toContain("total");
    expect(data).toContain('"ABC Supplies LLC"');
    expect(data).toContain("1353.13");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("leaves numeric strings unquoted", () => {
    const csv = toCsv([baseRow]);
    // Excel-friendly: numbers should round-trip as numbers.
    expect(csv).toMatch(/,1353\.13(,|\r)/);
    expect(csv).not.toMatch(/"1353\.13"/);
  });

  it("doubles embedded quotes per RFC 4180", () => {
    const csv = toCsv([
      { ...baseRow, vendor_name: 'Bob "The Builder" LLC' },
    ]);
    expect(csv).toContain('"Bob ""The Builder"" LLC"');
  });

  it("handles embedded commas and newlines without corruption", () => {
    const csv = toCsv([
      {
        ...baseRow,
        vendor_address: "123 Main St,\nSuite 200",
      },
    ]);
    // The whole cell stays inside the quoted region.
    expect(csv).toContain('"123 Main St,\nSuite 200"');
    // The header row has one line; the data row has one logical line
    // even though it contains a literal newline inside the quoted cell.
    const headerEnd = csv.indexOf("\r\n");
    expect(headerEnd).toBeGreaterThan(0);
  });

  it("emits null as an empty cell", () => {
    const csv = toCsv([{ ...baseRow, payment_terms: null }]);
    // payment_terms is column index … find it by name to avoid hardcoding.
    const headerCols = csv.split("\r\n")[0].split(",");
    const idx = headerCols.indexOf("payment_terms");
    const dataCols = csv.split("\r\n")[1].split(",");
    expect(dataCols[idx]).toBe("");
  });
});

describe("toJson", () => {
  it("wraps rows in an { invoices: [...] } envelope", () => {
    const j = JSON.parse(toJson([baseRow]));
    expect(j.invoices).toHaveLength(1);
    expect(j.invoices[0].invoice_id).toBe("inv-1");
  });
});
