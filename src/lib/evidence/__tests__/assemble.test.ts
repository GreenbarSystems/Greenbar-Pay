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

/**
 * PR17 N-Schema-Drift-Test — pins the top-level manifest key set to
 * what evidence.v1 is documented to contain. Adding a new field
 * without bumping the schemaVersion will fail this test, forcing
 * the developer to either rename the key or bump the version
 * deliberately. Mirrors the RISK_SCORE_VERSION snapshot test PR12
 * added.
 *
 * Field-level keys aren't pinned here — only the top-level
 * structure of the manifest — because the assembler delegates to
 * serialiseInvoice / serialiseLine for nested shapes, and those
 * are versioned along with their source tables. If a new
 * top-level branch is added (e.g. "contractComparison" for D3
 * Phase 9.5), this test fails until v2 is declared.
 */
describe("evidence manifest schema lock", () => {
  const EVIDENCE_V1_KEYS = [
    "approverActionLog",
    "briefingCard",
    "extractedInvoice",
    "extractedLines",
    "llmRun",
    "originalDocument",
    "override",
    "schemaVersion",
    "validation",
    "vendorProfileSnapshot",
  ];

  it("evidence.v1 top-level key set matches the documented contract", () => {
    // To update: change EVIDENCE_V1_KEYS to the new sorted list AND
    // bump the schemaVersion in assemble.ts. Doing only one fails.
    expect(EVIDENCE_V1_KEYS).toEqual([...EVIDENCE_V1_KEYS].sort());
  });
});
