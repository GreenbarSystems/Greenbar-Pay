/**
 * Addendum §2.4 — the scrubber must strip sensitive keys from anything
 * we log. App logs (stdout / APM) get IDs only.
 */
import { describe, it, expect } from "vitest";
import { scrub, scrubError } from "@/lib/llm/scrub";

describe("scrub()", () => {
  it("strips top-level vendor/invoice/account fields", () => {
    const cleaned = scrub({
      vendor_name: "ACME",
      vendorName: "ACME",
      invoice_number: "INV-1",
      invoiceNumber: "INV-1",
      account_number: "1234567",
      routing: "021000021",
      ein: "12-3456789",
      ssn: "111-22-3333",
      tax_id: "tx-1",
      documentId: "doc-uuid",
    }) as Record<string, string>;

    for (const k of [
      "vendor_name",
      "vendorName",
      "invoice_number",
      "invoiceNumber",
      "account_number",
      "routing",
      "ein",
      "ssn",
      "tax_id",
    ]) {
      expect(cleaned[k]).toBe("[REDACTED]");
    }
    // IDs are fine to log.
    expect(cleaned.documentId).toBe("doc-uuid");
  });

  it("strips inside nested objects and arrays", () => {
    const cleaned = scrub({
      runs: [{ output_json: { total: 100 } }, { vendor_name: "X" }],
    }) as { runs: Array<Record<string, unknown>> };
    expect(cleaned.runs[0].output_json).toBe("[REDACTED]");
    expect(cleaned.runs[1].vendor_name).toBe("[REDACTED]");
  });

  it("preserves unknown fields and primitives", () => {
    const cleaned = scrub({ count: 5, ok: true, name: "Alice" });
    expect(cleaned).toEqual({ count: 5, ok: true, name: "Alice" });
  });
});

describe("scrubError()", () => {
  it('redacts "key":"value" patterns in the error message', () => {
    const err = new Error(
      'request rejected: {"vendor_name":"ACME","total":100}',
    );
    const cleaned = scrubError(err);
    expect(cleaned.message).toContain('"vendor_name":"[REDACTED]"');
    expect(cleaned.message).toContain('"total":100');
  });

  it("redacts key=value patterns in the message", () => {
    const err = new Error("validation failed account_number=1234567 total=100");
    const cleaned = scrubError(err);
    expect(cleaned.message).toContain("account_number=[REDACTED]");
    expect(cleaned.message).toContain("total=100");
  });

  it("preserves stack and scrubs structured body", () => {
    const err = new Error("boom") as Error & { body?: unknown };
    err.body = { vendor_name: "ACME", documentId: "doc-1" };
    const cleaned = scrubError(err) as Error & { body?: Record<string, unknown> };
    expect(cleaned.stack).toBe(err.stack);
    expect(cleaned.body?.vendor_name).toBe("[REDACTED]");
    expect(cleaned.body?.documentId).toBe("doc-1");
  });
});
