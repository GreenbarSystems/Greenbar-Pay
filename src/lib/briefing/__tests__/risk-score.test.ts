import { describe, it, expect } from "vitest";
import { computeRiskScore, riskBand } from "@/lib/briefing/risk-score";

const baseInput = {
  blockingFindingCount: 0,
  warningFindingCount: 0,
  vendorTermsDrift: false,
  vendorDuplicateCount: 0,
  textQualityLow: false,
  vendorWarmingUp: false,
};

describe("computeRiskScore", () => {
  it("clean invoice → score 0", () => {
    const r = computeRiskScore(baseInput);
    expect(r.score).toBe(0);
    expect(r.factors).toEqual([]);
  });

  it("blocking finding contributes 30", () => {
    const r = computeRiskScore({ ...baseInput, blockingFindingCount: 1 });
    expect(r.score).toBe(30);
    expect(r.factors[0].code).toBe("blocking_findings");
  });

  it("multiple blockings stack but clamp at 100", () => {
    const r = computeRiskScore({ ...baseInput, blockingFindingCount: 5 });
    expect(r.score).toBe(100); // 5 * 30 = 150, clamped
  });

  it("factors sorted by weight desc — strongest first", () => {
    const r = computeRiskScore({
      ...baseInput,
      warningFindingCount: 1, // 6
      vendorTermsDrift: true, // 12
      blockingFindingCount: 1, // 30
    });
    expect(r.factors[0].code).toBe("blocking_findings");
    expect(r.factors[1].code).toBe("vendor_terms_drift");
    expect(r.factors[2].code).toBe("warning_findings");
  });

  it("warming-up vendor adds modest risk", () => {
    const r = computeRiskScore({ ...baseInput, vendorWarmingUp: true });
    expect(r.score).toBe(6);
    expect(r.factors[0].code).toBe("vendor_warming_up");
  });

  it("combines all factors", () => {
    const r = computeRiskScore({
      blockingFindingCount: 1,
      warningFindingCount: 2,
      vendorTermsDrift: true,
      vendorDuplicateCount: 1,
      textQualityLow: true,
      vendorWarmingUp: true,
    });
    // 30 + 12 + 12 + 10 + 8 + 6 = 78
    expect(r.score).toBe(78);
    expect(r.factors).toHaveLength(6);
  });
});

describe("riskBand", () => {
  it("matches spec §7.1 bands", () => {
    expect(riskBand(0)).toBe("green");
    expect(riskBand(30)).toBe("green");
    expect(riskBand(31)).toBe("amber");
    expect(riskBand(60)).toBe("amber");
    expect(riskBand(61)).toBe("red");
    expect(riskBand(100)).toBe("red");
  });
});
