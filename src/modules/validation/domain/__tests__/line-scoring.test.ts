/**
 * Phase 9 — F06 line-item confidence scorer + D3 rate-drift gate.
 */
import { describe, it, expect } from "vitest";
import {
  scoreLine,
  isRateDrift,
  RATE_DRIFT_MIN_SAMPLES,
  RATE_DRIFT_THRESHOLD,
} from "@/modules/validation/domain/line-scoring";

describe("scoreLine", () => {
  it("returns null when the line has no unit price", () => {
    expect(scoreLine({ unitPrice: null }, null)).toBeNull();
  });

  it("emits 'new' when no stats row exists for this keyword", () => {
    const r = scoreLine({ unitPrice: 50 }, null);
    expect(r?.score).toBe("new");
    expect(r?.stddevDistance).toBeNull();
  });

  it("emits 'new' when stats exist but sample_count is zero", () => {
    const r = scoreLine(
      { unitPrice: 50 },
      { sampleCount: 0, avgUnitPrice: 0, stddevUnitPrice: null },
    );
    expect(r?.score).toBe("new");
  });

  it("with 1 sample and no stddev → low confidence", () => {
    const r = scoreLine(
      { unitPrice: 50 },
      { sampleCount: 1, avgUnitPrice: 50, stddevUnitPrice: null },
    );
    expect(r?.score).toBe("low");
    expect(r?.reason).toContain("Seen 1");
  });

  it("with 3 samples but zero stddev → medium (uniform history)", () => {
    const r = scoreLine(
      { unitPrice: 50 },
      { sampleCount: 3, avgUnitPrice: 50, stddevUnitPrice: 0 },
    );
    expect(r?.score).toBe("medium");
  });

  it("≥5 samples within 1σ → high", () => {
    const r = scoreLine(
      { unitPrice: 102 },
      { sampleCount: 8, avgUnitPrice: 100, stddevUnitPrice: 5 },
    );
    expect(r?.score).toBe("high");
    expect(r?.stddevDistance).toBe(0.4);
  });

  it("3–4 samples (not yet 5) → medium even when within 1σ", () => {
    const r = scoreLine(
      { unitPrice: 102 },
      { sampleCount: 4, avgUnitPrice: 100, stddevUnitPrice: 5 },
    );
    expect(r?.score).toBe("medium");
  });

  it("between 1σ and 2σ → medium", () => {
    const r = scoreLine(
      { unitPrice: 108 },
      { sampleCount: 8, avgUnitPrice: 100, stddevUnitPrice: 5 },
    );
    expect(r?.score).toBe("medium");
    expect(r?.stddevDistance).toBe(1.6);
  });

  it("beyond 2σ with enough samples → low", () => {
    const r = scoreLine(
      { unitPrice: 130 },
      { sampleCount: 8, avgUnitPrice: 100, stddevUnitPrice: 5 },
    );
    expect(r?.score).toBe("low");
    expect(r?.stddevDistance).toBe(6);
  });
});

describe("isRateDrift", () => {
  it("does not fire below RATE_DRIFT_MIN_SAMPLES", () => {
    expect(
      isRateDrift(130, {
        sampleCount: RATE_DRIFT_MIN_SAMPLES - 1,
        avgUnitPrice: 100,
        stddevUnitPrice: 5,
      }),
    ).toBe(false);
  });

  it("does not fire when stddev is null", () => {
    expect(
      isRateDrift(130, {
        sampleCount: 5,
        avgUnitPrice: 100,
        stddevUnitPrice: null,
      }),
    ).toBe(false);
  });

  // PR10 C2 — divide-by-zero guard.
  it("does not fire when avgUnitPrice is zero", () => {
    expect(
      isRateDrift(100, { sampleCount: 5, avgUnitPrice: 0, stddevUnitPrice: 5 }),
    ).toBe(false);
  });

  it("does not fire when avgUnitPrice is negative (defensive)", () => {
    expect(
      isRateDrift(100, { sampleCount: 5, avgUnitPrice: -10, stddevUnitPrice: 5 }),
    ).toBe(false);
  });

  // PR10 C1 — the rule must actually fire at the documented minimum
  // sample count, not the silently-higher one the scorer was forcing.
  it("FIRES at exactly RATE_DRIFT_MIN_SAMPLES = 3 when σ-distance is material", () => {
    expect(
      isRateDrift(150, {
        sampleCount: RATE_DRIFT_MIN_SAMPLES,
        avgUnitPrice: 100,
        stddevUnitPrice: 5,
      }),
    ).toBe(true);
  });

  it("does not fire on small-σ-distance drift even past the % threshold", () => {
    // 20% drift but σ-distance only 1.0 — within normal variance range.
    expect(
      isRateDrift(120, {
        sampleCount: 5,
        avgUnitPrice: 100,
        stddevUnitPrice: 20,
      }),
    ).toBe(false);
  });

  it("fires above the variance threshold AND σ-distance > 1.5", () => {
    expect(
      isRateDrift(100 * (1 + RATE_DRIFT_THRESHOLD + 0.05), {
        sampleCount: 5,
        avgUnitPrice: 100,
        stddevUnitPrice: 5,
      }),
    ).toBe(true);
  });

  it("does not fire at exactly the variance threshold (strict >)", () => {
    expect(
      isRateDrift(100 * (1 + RATE_DRIFT_THRESHOLD), {
        sampleCount: 5,
        avgUnitPrice: 100,
        stddevUnitPrice: 5,
      }),
    ).toBe(false);
  });
});
