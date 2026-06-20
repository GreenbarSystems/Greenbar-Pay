import { describe, it, expect } from "vitest";
import {
  computeRiskScore,
  riskBand,
  RISK_SCORE_VERSION,
} from "@/lib/briefing/risk-score";

const baseInput = {
  blockingFindingCount: 0,
  warningFindingCount: 0,
  vendorTermsDrift: false,
  vendorDuplicateCount: 0,
  textQualityLow: false,
  vendorWarmingUp: false,
  rateDriftCount: 0,
  hasNewLineItem: false,
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
      rateDriftCount: 0,
      hasNewLineItem: false,
    });
    // 30 + 12 + 12 + 10 + 8 + 6 = 78
    expect(r.score).toBe(78);
    expect(r.factors).toHaveLength(6);
  });

  // Phase 9 — D3 / F06 cases.
  it("one rate-drift line adds 8", () => {
    const r = computeRiskScore({ ...baseInput, rateDriftCount: 1 });
    expect(r.score).toBe(8);
    expect(r.factors[0].code).toBe("rate_drift");
  });

  it("rate-drift count caps at 3 lines (24 max)", () => {
    const r = computeRiskScore({ ...baseInput, rateDriftCount: 10 });
    expect(r.score).toBe(24);
    expect(r.factors[0].note).toContain("10 line items");
  });

  it("new line item adds 5 once", () => {
    const r = computeRiskScore({ ...baseInput, hasNewLineItem: true });
    expect(r.score).toBe(5);
    expect(r.factors[0].code).toBe("new_line_item");
  });

  it("rate drift + new line item compose with other factors", () => {
    const r = computeRiskScore({
      ...baseInput,
      warningFindingCount: 1, // 6
      rateDriftCount: 2, // 16
      hasNewLineItem: true, // 5
    });
    expect(r.score).toBe(27);
    expect(r.factors.map((f) => f.code)).toEqual([
      "rate_drift",
      "warning_findings",
      "new_line_item",
    ]);
  });
});

// PR12 M6 — snapshot pinning the version constant to the score for a
// canonical input. Any WEIGHTS or formula change without bumping
// RISK_SCORE_VERSION fails CI here, forcing the bump policy documented
// in risk-score.ts to be enforced rather than honoured by convention.
//
// To intentionally bump: update RISK_SCORE_VERSION, then update the
// EXPECTED_* constants below to the new scores in the same commit.
describe("RISK_SCORE_VERSION snapshot", () => {
  const EXPECTED_VERSION = "1.1.0";

  // Same input fixtures, scores hand-computed against the WEIGHTS table.
  const EXPECTED_SCORES: Array<{
    label: string;
    input: typeof baseInput;
    score: number;
  }> = [
    { label: "clean invoice", input: { ...baseInput }, score: 0 },
    {
      label: "one blocking finding",
      input: { ...baseInput, blockingFindingCount: 1 },
      score: 30,
    },
    {
      label: "warming-up vendor only",
      input: { ...baseInput, vendorWarmingUp: true },
      score: 6,
    },
    {
      label: "two warning findings + terms drift + duplicate + low text",
      input: {
        ...baseInput,
        warningFindingCount: 2,
        vendorTermsDrift: true,
        vendorDuplicateCount: 1,
        textQualityLow: true,
      },
      score: 12 + 12 + 10 + 8, // 42
    },
    {
      label: "two rate-drift lines + new line item",
      input: { ...baseInput, rateDriftCount: 2, hasNewLineItem: true },
      score: 8 * 2 + 5, // 21
    },
    {
      label: "rate drift caps at 3 lines",
      input: { ...baseInput, rateDriftCount: 10 },
      score: 8 * 3, // 24
    },
  ];

  it("RISK_SCORE_VERSION constant matches the locked snapshot", () => {
    expect(RISK_SCORE_VERSION).toBe(EXPECTED_VERSION);
  });

  it.each(EXPECTED_SCORES)(
    "fixture '$label' scores $score at v$EXPECTED_VERSION",
    ({ input, score }) => {
      const r = computeRiskScore(input);
      expect(r.score).toBe(score);
    },
  );
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
