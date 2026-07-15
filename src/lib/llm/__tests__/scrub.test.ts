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

  // 2026-07-13 audit F9 — these were missing from SENSITIVE_KEYS:
  //   remitToName (added in F7), email-pipeline PII (fromEmail / fromName /
  //   bodyText), and the generic email field.
  it("strips remitToName / remit_to_name (F7 gap)", () => {
    const cleaned = scrub({
      remitToName: "Acme Supplies LLC",
      remit_to_name: "Acme Supplies LLC",
      remitToAddress: "100 Main St",
      remit_to_address: "100 Main St",
    }) as Record<string, string>;
    expect(cleaned.remitToName).toBe("[REDACTED]");
    expect(cleaned.remit_to_name).toBe("[REDACTED]");
    expect(cleaned.remitToAddress).toBe("[REDACTED]");
    expect(cleaned.remit_to_address).toBe("[REDACTED]");
  });

  it("strips email-pipeline PII: fromEmail, fromName, bodyText, email (F9)", () => {
    const cleaned = scrub({
      fromEmail: "vendor@acme.com",
      from_email: "vendor@acme.com",
      fromName: "Jane Vendor",
      from_name: "Jane Vendor",
      bodyText: "Please pay invoice INV-1 to the account below.",
      body_text: "Same.",
      email: "user@example.com",
      organizationId: "org-uuid",
    }) as Record<string, string>;
    for (const k of [
      "fromEmail",
      "from_email",
      "fromName",
      "from_name",
      "bodyText",
      "body_text",
      "email",
    ]) {
      expect(cleaned[k]).toBe("[REDACTED]");
    }
    // Non-PII fields pass through.
    expect(cleaned.organizationId).toBe("org-uuid");
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

  // 2026-07-13 audit F9 — verify that Postgres error messages echoing
  // email-pipeline PII (fromEmail, bodyText) and remitToName are scrubbed
  // before reaching stdout.
  it('redacts F9 fields in "key":"value" error messages', () => {
    const err = new Error(
      'insert error: {"fromEmail":"vendor@acme.com","remitToName":"Acme LLC","bodyText":"Pay us"}',
    );
    const cleaned = scrubError(err);
    expect(cleaned.message).toContain('"fromEmail":"[REDACTED]"');
    expect(cleaned.message).toContain('"remitToName":"[REDACTED]"');
    expect(cleaned.message).toContain('"bodyText":"[REDACTED]"');
  });

  it("redacts F9 fields in key=value error messages", () => {
    const err = new Error("from_email=vendor@acme.com body_text=sensitive");
    const cleaned = scrubError(err);
    expect(cleaned.message).toContain("from_email=[REDACTED]");
    expect(cleaned.message).toContain("body_text=[REDACTED]");
  });
});
