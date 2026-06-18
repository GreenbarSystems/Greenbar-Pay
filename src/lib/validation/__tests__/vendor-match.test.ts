import { describe, it, expect } from "vitest";
import { matchVendor } from "@/lib/validation/vendor-match";

const v = (
  id: string,
  name: string,
  normalizedName: string,
  aliases: string[] = [],
) => ({ id, name, normalizedName, aliases });

describe("matchVendor (Phase 7 aliases)", () => {
  it("exact match on canonical normalized name", () => {
    const r = matchVendor("ABC Supplies LLC", [
      v("v1", "ABC Supplies LLC", "abc supplies llc"),
    ]);
    expect(r.method).toBe("exact_normalized");
    expect(r.confidence).toBe("high");
    expect(r.vendorId).toBe("v1");
  });

  it("exact match on a registered alias", () => {
    const r = matchVendor("A.B.C. Supplies", [
      v("v1", "ABC Supplies LLC", "abc supplies llc", ["a b c supplies"]),
    ]);
    expect(r.method).toBe("exact_alias");
    expect(r.confidence).toBe("high");
    expect(r.vendorId).toBe("v1");
  });

  it("falls through to jaccard when neither canonical nor alias hits", () => {
    const r = matchVendor("ABC Office Products", [
      v("v1", "ABC Supplies LLC", "abc supplies llc", ["abc supplies"]),
    ]);
    expect(r.method).toBe("jaccard");
  });

  it("returns method='none' when there are no candidates", () => {
    const r = matchVendor("ACME", []);
    expect(r.method).toBe("none");
    expect(r.vendorId).toBeNull();
  });

  it("alias hit beats Jaccard against unrelated candidates", () => {
    const r = matchVendor("A.B.C. Supplies", [
      v("v1", "ABC Supplies LLC", "abc supplies llc", ["a b c supplies"]),
      v("v2", "Acme Office", "acme office"),
      v("v3", "ABC Office Products", "abc office products"),
    ]);
    expect(r.method).toBe("exact_alias");
    expect(r.vendorId).toBe("v1");
  });
});
