import { describe, it, expect } from "vitest";
import { itemKeyword } from "@/jobs/recomputeVendorProfile";

describe("itemKeyword", () => {
  it("returns null on empty / nullish input", () => {
    expect(itemKeyword(null)).toBeNull();
    expect(itemKeyword("")).toBeNull();
    expect(itemKeyword("   ")).toBeNull();
  });

  it("lowercases, strips punctuation, drops stop words", () => {
    expect(itemKeyword("Monthly Service Fee for Hosting"))
      .toBe("hosting"); // 'monthly', 'service', 'fee', 'for' all stop words
  });

  it("takes up to three meaningful tokens", () => {
    expect(itemKeyword("Custom widget assembly with engraving plus shipping"))
      .toBe("custom widget assembly");
  });

  it("treats variants the same after normalization", () => {
    expect(itemKeyword("OFFICE-SUPPLIES")).toBe(itemKeyword("office supplies!"));
    expect(itemKeyword("office supplies!")).toBe("office supplies");
  });

  it("returns null when only stop words are present", () => {
    expect(itemKeyword("monthly service fee")).toBeNull();
  });
});
