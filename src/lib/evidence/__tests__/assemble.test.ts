/**
 * Phase 11 — evidence assembler.
 *
 * The full assembler reads from a tx; the integration test that
 * exercises the DB is out of scope here. What we can test pure-style
 * is the canonical hash function: deterministic across key order, key
 * to the auditor's verification claim.
 */
import { describe, it, expect } from "vitest";
import { canonicalSha256 } from "@/lib/evidence/assemble";

describe("canonicalSha256", () => {
  it("produces the same hash for objects with permuted keys", () => {
    const a = { c: 1, a: 2, b: 3 };
    const b = { a: 2, b: 3, c: 1 };
    expect(canonicalSha256(a)).toBe(canonicalSha256(b));
  });

  it("recurses into nested objects", () => {
    const a = { outer: { z: 1, a: 2 }, list: [1, 2, 3] };
    const b = { list: [1, 2, 3], outer: { a: 2, z: 1 } };
    expect(canonicalSha256(a)).toBe(canonicalSha256(b));
  });

  it("respects array order (arrays are inherently ordered)", () => {
    const a = { x: [1, 2, 3] };
    const b = { x: [3, 2, 1] };
    expect(canonicalSha256(a)).not.toBe(canonicalSha256(b));
  });

  it("differs when a value changes", () => {
    const a = { x: 1 };
    const b = { x: 2 };
    expect(canonicalSha256(a)).not.toBe(canonicalSha256(b));
  });

  it("is a 64-char hex string (SHA-256)", () => {
    const h = canonicalSha256({ any: "value" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across runs for a non-trivial nested manifest", () => {
    const manifest = {
      schemaVersion: "evidence.v1",
      extractedInvoice: {
        invoiceNumber: "INV-1",
        total: "1234.56",
        warnings: [{ code: "x" }],
      },
      validation: { findings: [{ code: "math_mismatch" }] },
      briefingCard: { riskScore: 42 },
      override: null,
    };
    const h1 = canonicalSha256(manifest);
    const h2 = canonicalSha256(manifest);
    expect(h1).toBe(h2);
  });
});
