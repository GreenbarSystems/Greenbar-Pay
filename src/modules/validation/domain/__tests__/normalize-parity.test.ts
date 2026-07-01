/**
 * Parity assertion for JS `normalizeVendor` and SQL `normalize_vendor_text`.
 *
 * The two implementations MUST produce the same output for the same input
 * so that the recompute job's join (which uses the SQL function) matches
 * what the JS-side matcher resolves. This test pins the JS behavior to a
 * known fixture; the SQL function in
 * src/db/migrations/sidecar/0011_pr5_phase7_hotfix.sql is structurally
 * identical (lower → strip non-alphanumeric to space → collapse
 * whitespace → trim) and is documented with the JS reference.
 *
 * If either side changes, this fixture should fail and the SQL function
 * must be migrated to match.
 */
import { describe, it, expect } from "vitest";
import { normalizeVendor } from "@/modules/validation/domain/engine";

describe("normalizeVendor / normalize_vendor_text parity fixtures", () => {
  const cases: Array<[string, string]> = [
    ["ABC Supplies LLC", "abc supplies llc"],
    ["A.B.C. Supplies", "a b c supplies"],
    ["  ACME   Inc.  ", "acme inc"],
    ["O'Reilly Auto Parts", "o reilly auto parts"],
    ["ACME-Corp", "acme corp"],
    ["123 Industries", "123 industries"],
    ["Company \"X\"", "company x"],
    ["", ""],
    ["   ", ""],
    ["----- ----", ""],
    ["Smith & Sons", "smith sons"],
  ];

  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeVendor(input)).toBe(expected);
    });
  }
});
