import { describe, it, expect } from "vitest";
import { evaluateSenderAuthentication } from "../authentication";

describe("evaluateSenderAuthentication", () => {
  it("fails open when no verdict data is available (local dev / CLI ingestion)", () => {
    const r = evaluateSenderAuthentication(undefined);
    expect(r.accepted).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("accepts when SPF and DKIM both pass", () => {
    const r = evaluateSenderAuthentication({ spfVerdict: "PASS", dkimVerdict: "PASS" });
    expect(r.accepted).toBe(true);
  });

  it("accepts when only SPF passes (DKIM missing) — common for forwarded mail", () => {
    const r = evaluateSenderAuthentication({ spfVerdict: "PASS" });
    expect(r.accepted).toBe(true);
  });

  it("accepts when only DKIM passes (SPF fails) — common for forwarded mail", () => {
    const r = evaluateSenderAuthentication({ spfVerdict: "FAIL", dkimVerdict: "PASS" });
    expect(r.accepted).toBe(true);
  });

  it("rejects when both SPF and DKIM explicitly fail", () => {
    const r = evaluateSenderAuthentication({ spfVerdict: "FAIL", dkimVerdict: "FAIL" });
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("SPF and DKIM both failed");
  });

  it("does not reject on GRAY or PROCESSING_FAILED alone — inconclusive, not evidence of spoofing", () => {
    expect(
      evaluateSenderAuthentication({ spfVerdict: "GRAY", dkimVerdict: "GRAY" }).accepted,
    ).toBe(true);
    expect(
      evaluateSenderAuthentication({
        spfVerdict: "PROCESSING_FAILED",
        dkimVerdict: "PROCESSING_FAILED",
      }).accepted,
    ).toBe(true);
  });

  it("honors an enforcing DMARC policy on DMARC failure even if SPF or DKIM individually passed", () => {
    const r = evaluateSenderAuthentication({
      spfVerdict: "PASS",
      dkimVerdict: "PASS",
      dmarcVerdict: "FAIL",
      dmarcPolicy: "reject",
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("DMARC failed with an enforcing policy (reject)");
  });

  it("honors dmarcPolicy=quarantine the same as reject", () => {
    const r = evaluateSenderAuthentication({
      dmarcVerdict: "FAIL",
      dmarcPolicy: "quarantine",
    });
    expect(r.accepted).toBe(false);
  });

  it("does not reject on DMARC failure when the domain's policy is 'none' (monitor-only)", () => {
    const r = evaluateSenderAuthentication({
      spfVerdict: "PASS",
      dkimVerdict: "PASS",
      dmarcVerdict: "FAIL",
      dmarcPolicy: "none",
    });
    expect(r.accepted).toBe(true);
  });

  it("does not reject on DMARC failure when no policy is present", () => {
    const r = evaluateSenderAuthentication({
      spfVerdict: "PASS",
      dkimVerdict: "PASS",
      dmarcVerdict: "FAIL",
    });
    expect(r.accepted).toBe(true);
  });
});
