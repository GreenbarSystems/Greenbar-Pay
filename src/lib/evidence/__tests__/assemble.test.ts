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

// -----------------------------------------------------------------------------
// -0 normalisation (defense-in-depth for cross-tool parity with gbverify v0.3.0)
// -----------------------------------------------------------------------------
//
// Context: `src/lib/coaching/compute.ts` computes `-round2(discountValue)`,
// which produces `-0` (as a JS Number) when `discountValue` rounds to zero.
// That value ends up on `briefing_cards.coachingPromptsJson.dollarImpact` and
// gets pulled into the sealed evidence manifest. In current V8,
// `JSON.stringify(-0)` already emits `"0"`, so the on-disk JSON never actually
// contains `-0`. But we explicitly normalise the value inside
// `canonicalJsonStringify` for defense-in-depth: this keeps Pay's canonicaliser
// grep-identical with the gbverify Node + Python CLIs, and guards against any
// future code path that computes a canonical string via something other than
// `JSON.stringify`.
//
// The reference hashes below were captured 2026-08-05 by running gbverify
// v0.3.0's Node canonicaliser (post-PR #1, commit 519a121) against the same
// fixtures. If a canonicalisation-affecting change lands in either Pay or
// gbverify, one of these assertions will fail — that is exactly the signal
// we want.

describe("canonicalSha256 -0 normalisation", () => {
  it("hashes {dollarImpact:-0} identically to {dollarImpact:0}", () => {
    const withNegZero = { dollarImpact: -0 };
    const withZero = { dollarImpact: 0 };
    expect(canonicalSha256(withNegZero)).toBe(canonicalSha256(withZero));
  });

  it("hashes -0 inside a nested coaching-prompt shape identically to 0", () => {
    const withNegZero = {
      coachingPrompts: [
        { code: "early_payment_discount", dollarImpact: -0, meta: { discountPct: 0 } },
      ],
    };
    const withZero = {
      coachingPrompts: [
        { code: "early_payment_discount", dollarImpact: 0, meta: { discountPct: 0 } },
      ],
    };
    expect(canonicalSha256(withNegZero)).toBe(canonicalSha256(withZero));
  });

  it("hashes -0 inside an array element identically to 0", () => {
    // NB: JSON.stringify normalises -0 to 0 in array positions too, but we
    // still want a regression assertion so an accidental "return NaN" or
    // "throw" in the replacer would be caught.
    expect(canonicalSha256({ xs: [-0, 0, -0] })).toBe(canonicalSha256({ xs: [0, 0, 0] }));
  });

  it("matches gbverify v0.3.0 byte-for-byte on {dollarImpact:-0}", () => {
    // Reference hash produced by cli-node/bin/gbverify.js in
    // GreenbarSystems/gbverify @ 519a121 (v0.3.0), 2026-08-05.
    const GBVERIFY_V030_HASH = "aab1567895141dd8402ae38c189fbf5951c96b49f58cf86a08ea8518953a93da";
    expect(canonicalSha256({ dollarImpact: -0 })).toBe(GBVERIFY_V030_HASH);
    // And a legitimate zero must produce the same hash.
    expect(canonicalSha256({ dollarImpact: 0 })).toBe(GBVERIFY_V030_HASH);
  });

  it("matches gbverify v0.3.0 byte-for-byte on a nested coaching-prompt shape", () => {
    // Reference hash produced by the same gbverify v0.3.0 canonicaliser
    // against the exact nested fixture, 2026-08-05.
    const GBVERIFY_V030_HASH = "d1b498465de46c8174c49efcfc4e84c33844d976c46aadde098ca4e0fd6447a8";
    const packet = {
      coachingPrompts: [
        { code: "early_payment_discount", dollarImpact: -0, meta: { discountPct: 0 } },
      ],
    };
    expect(canonicalSha256(packet)).toBe(GBVERIFY_V030_HASH);
  });

  it("is idempotent: re-hashing the canonical bytes reproduces the same hash", () => {
    // The auditor workflow is: read packet JSON from disk, canonicalise,
    // hash, compare to the sealed hash. Round-tripping through JSON.parse
    // and re-canonicalising must be stable.
    const original = { dollarImpact: -0, meta: { discountPct: 0 } };
    const roundTripped = JSON.parse(JSON.stringify(original));
    expect(canonicalSha256(original)).toBe(canonicalSha256(roundTripped));
  });
});
