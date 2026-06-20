import { describe, it, expect } from "vitest";
import { BriefingCardSchema } from "@/lib/llm/briefing-card-schema";

// PR12 H4 — anomaly flags now require an evidenceChain of 2–6 labelled
// steps. The model produces this output via tool-use; the schema rejects
// any flag without a chain so a degraded response can't silently strip
// the reasoning trail.
const chain = [
  { label: "Evidence", detail: "Last 8 prior samples averaged near mean." },
  { label: "This invoice", detail: "Line 1 is materially above range." },
  { label: "Recommendation", detail: "Request rate justification." },
];
const validFlag = {
  code: "rate_variance",
  severity: "warning",
  message: "Unit price 5% above prior.",
  evidenceChain: chain,
};
const valid = {
  glCode: "6200",
  glRationale: "Office supplies coded to 6200 based on vendor's prior approvals.",
  anomalyFlags: [validFlag],
  deltaSummary: "Total up from last invoice.",
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
      anomalyFlags: [{ ...validFlag, severity: "extreme" }],
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
      anomalyFlags: [{ ...validFlag, message: "x".repeat(281) }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts an empty anomaly flags array", () => {
    const r = BriefingCardSchema.safeParse({ ...valid, anomalyFlags: [] });
    expect(r.success).toBe(true);
  });

  // PR12 H4 — evidenceChain is now structurally required.
  it("rejects an anomaly flag with no evidence chain", () => {
    const { evidenceChain: _, ...flagNoChain } = validFlag;
    const r = BriefingCardSchema.safeParse({
      ...valid,
      anomalyFlags: [flagNoChain],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an evidence chain with fewer than 2 steps", () => {
    const r = BriefingCardSchema.safeParse({
      ...valid,
      anomalyFlags: [{ ...validFlag, evidenceChain: chain.slice(0, 1) }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an evidence chain with more than 6 steps", () => {
    const r = BriefingCardSchema.safeParse({
      ...valid,
      anomalyFlags: [
        {
          ...validFlag,
          evidenceChain: Array.from({ length: 7 }, () => ({
            label: "Step",
            detail: "x",
          })),
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});
