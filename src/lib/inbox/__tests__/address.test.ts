import { describe, it, expect } from "vitest";
import { parseInboxAddress, composeInboxAddress } from "@/lib/inbox/address";

describe("parseInboxAddress", () => {
  it("parses the canonical form", () => {
    const r = parseInboxAddress("ap+acme--bigco@in.invoice-ai.com");
    expect(r).toEqual({
      orgSlug: "acme",
      clientSlug: "bigco",
      domain: "in.invoice-ai.com",
      raw: "ap+acme--bigco@in.invoice-ai.com",
    });
  });

  it("lowercases input", () => {
    const r = parseInboxAddress("AP+Acme--BigCo@IN.Invoice-AI.com");
    expect(r?.orgSlug).toBe("acme");
    expect(r?.clientSlug).toBe("bigco");
  });

  it("handles client slugs that contain hyphens", () => {
    const r = parseInboxAddress("ap+acme--big-co-ltd@in.invoice-ai.com");
    expect(r?.clientSlug).toBe("big-co-ltd");
  });

  it("returns null when missing the ap+ prefix", () => {
    expect(parseInboxAddress("hello@in.invoice-ai.com")).toBeNull();
  });

  it("returns null when missing the -- separator", () => {
    expect(parseInboxAddress("ap+acme@in.invoice-ai.com")).toBeNull();
  });

  it("returns null when org slug starts or ends with a hyphen", () => {
    expect(parseInboxAddress("ap+-acme--bigco@in.invoice-ai.com")).toBeNull();
    expect(parseInboxAddress("ap+acme---bigco@in.invoice-ai.com")).toBeNull();
  });

  it("returns null when the address has no @", () => {
    expect(parseInboxAddress("ap+acme--bigco")).toBeNull();
  });
});

describe("composeInboxAddress", () => {
  it("round-trips with parseInboxAddress", () => {
    const composed = composeInboxAddress({
      orgSlug: "acme",
      clientSlug: "bigco",
      domain: "in.invoice-ai.com",
    });
    const parsed = parseInboxAddress(composed);
    expect(parsed?.orgSlug).toBe("acme");
    expect(parsed?.clientSlug).toBe("bigco");
  });
});
