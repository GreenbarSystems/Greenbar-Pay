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

  // 2026-08 hardening — previously these fell through to fail-open
  // ("not evidence of spoofing"), which meant a domain with zero SPF/
  // DKIM configured (GRAY on both, since there's nothing to evaluate)
  // was strictly easier for an attacker to exploit than a domain that
  // actively fails an explicit check. Neither PASSing is now rejected
  // regardless of which non-PASS value each mechanism landed on.
  it("rejects when both SPF and DKIM are GRAY (no record configured — the easy spoofing path)", () => {
    const r = evaluateSenderAuthentication({ spfVerdict: "GRAY", dkimVerdict: "GRAY" });
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("no SPF or DKIM authentication passed");
    expect(r.reason).toContain("spf=GRAY");
    expect(r.reason).toContain("dkim=GRAY");
  });

  it("rejects when both SPF and DKIM are PROCESSING_FAILED", () => {
    const r = evaluateSenderAuthentication({
      spfVerdict: "PROCESSING_FAILED",
      dkimVerdict: "PROCESSING_FAILED",
    });
    expect(r.accepted).toBe(false);
  });

  it("rejects a mix of GRAY/FAIL/missing with no explicit PASS on either mechanism", () => {
    expect(evaluateSenderAuthentication({ spfVerdict: "GRAY" }).accepted).toBe(false);
    expect(evaluateSenderAuthentication({ dkimVerdict: "FAIL" }).accepted).toBe(false);
    expect(evaluateSenderAuthentication({}).accepted).toBe(false);
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
