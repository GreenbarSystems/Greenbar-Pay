import { describe, it, expect } from "vitest";
import { BriefingCardSchema } from "@/lib/llm/briefing-card-schema";

const valid = {
  glCode: "6200",
  glRationale: "Office supplies coded to 6200 based on vendor's prior approvals.",
  anomalyFlags: [
    { code: "rate_variance", severity: "warning", message: "Unit price 5% above prior." },
  ],
  deltaSummary: "Total up $50 from last invoice.",
  riskJustification: "Two warning findings; vendor terms drift detected.",
};

describe("BriefingCardSchema", () => {
  it("accepts a clean briefing card", () => {
    const r = BriefingCardSchema.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it("allows null glCode", () => {
    const r = BriefingCardSchema.safeParse({ ...valid, glCode: null });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown severity", () => {
    const r = BriefingCardSchema.safeParse({
      ...valid,
      anomalyFlags: [
        { code: "x", severity: "extreme", message: "y" },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty riskJustification", () => {
    const r = BriefingCardSchema.safeParse({ ...valid, riskJustification: "" });
    expect(r.success).toBe(false);
  });

  it("rejects an over-long anomaly message", () => {
    const r = BriefingCardSchema.safeParse({
      ...valid,
      anomalyFlags: [
        { code: "x", severity: "info", message: "x".repeat(281) },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("accepts an empty anomaly flags array", () => {
    const r = BriefingCardSchema.safeParse({ ...valid, anomalyFlags: [] });
    expect(r.success).toBe(true);
  });
});
