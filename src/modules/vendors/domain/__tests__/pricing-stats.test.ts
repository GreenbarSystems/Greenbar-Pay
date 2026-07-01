/**
 * Phase 9 — per-keyword stats compute used by recompute-vendor-profile.
 */
import { describe, it, expect } from "vitest";
import { computeKeywordStats } from "@/modules/vendors/domain/pricing-stats";

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

describe("computeKeywordStats", () => {
  it("single sample — stddev null, trend insufficient_data", () => {
    const r = computeKeywordStats({
      prices: [100],
      dates: [d("2026-01-01")],
      latestPrice: 100,
    });
    expect(r.sampleCount).toBe(1);
    expect(r.avg).toBe(100);
    expect(r.stddev).toBeNull();
    expect(r.trend).toBe("insufficient_data");
    expect(r.lastPrice).toBe(100);
  });

  it("two samples — stddev computed, trend still insufficient", () => {
    const r = computeKeywordStats({
      prices: [100, 110],
      dates: [d("2026-01-01"), d("2026-02-01")],
      latestPrice: 110,
    });
    expect(r.sampleCount).toBe(2);
    expect(r.avg).toBe(105);
    expect(r.stddev).toBeCloseTo(Math.sqrt(50), 4);
    expect(r.trend).toBe("insufficient_data");
  });

  it("stable trend when first and last thirds are within 5%", () => {
    const r = computeKeywordStats({
      prices: [100, 102, 99, 101, 100, 103],
      dates: [
        d("2026-01-01"),
        d("2026-02-01"),
        d("2026-03-01"),
        d("2026-04-01"),
        d("2026-05-01"),
        d("2026-06-01"),
      ],
      latestPrice: 103,
    });
    expect(r.trend).toBe("stable");
  });

  it("rising trend when last third meaningfully exceeds first", () => {
    const r = computeKeywordStats({
      prices: [100, 100, 100, 120, 120, 120],
      dates: [
        d("2026-01-01"),
        d("2026-02-01"),
        d("2026-03-01"),
        d("2026-04-01"),
        d("2026-05-01"),
        d("2026-06-01"),
      ],
      latestPrice: 120,
    });
    expect(r.trend).toBe("rising");
  });

  it("falling trend when last third drops below first", () => {
    const r = computeKeywordStats({
      prices: [120, 120, 120, 100, 100, 100],
      dates: [
        d("2026-01-01"),
        d("2026-02-01"),
        d("2026-03-01"),
        d("2026-04-01"),
        d("2026-05-01"),
        d("2026-06-01"),
      ],
      latestPrice: 100,
    });
    expect(r.trend).toBe("falling");
  });

  it("trend uses date order even when prices are passed unsorted", () => {
    const r = computeKeywordStats({
      // Newer dates first, older later — the compute should sort them.
      prices: [120, 120, 120, 100, 100, 100],
      dates: [
        d("2026-06-01"),
        d("2026-05-01"),
        d("2026-04-01"),
        d("2026-03-01"),
        d("2026-02-01"),
        d("2026-01-01"),
      ],
      latestPrice: 120,
    });
    // Sorted ascending: [100,100,100,120,120,120] → rising.
    expect(r.trend).toBe("rising");
  });

  it("min/max/last preserved across the series", () => {
    const r = computeKeywordStats({
      prices: [50, 200, 100],
      dates: [d("2026-01-01"), d("2026-02-01"), d("2026-03-01")],
      latestPrice: 100,
    });
    expect(r.min).toBe(50);
    expect(r.max).toBe(200);
    expect(r.lastPrice).toBe(100);
  });

  // PR10 M1 — trend signal needs ≥ 6 samples (two prices per third) to
  // be meaningful. Below 6, return insufficient_data even though we have
  // enough samples for stddev.
  it.each([3, 4, 5])(
    "trend = insufficient_data at n=%i (was fragile single-point compare)",
    (n) => {
      const prices = Array.from({ length: n }, (_, i) =>
        i < n / 2 ? 100 : 200,
      );
      const dates = Array.from({ length: n }, (_, i) =>
        d(`2026-0${i + 1}-01`),
      );
      const r = computeKeywordStats({
        prices,
        dates,
        latestPrice: prices[prices.length - 1],
      });
      expect(r.trend).toBe("insufficient_data");
      expect(r.stddev).not.toBeNull();
    },
  );

  it("trend reads from ≥ 6 samples with two-price buckets", () => {
    const r = computeKeywordStats({
      prices: [100, 100, 100, 120, 120, 120],
      dates: [
        d("2026-01-01"),
        d("2026-02-01"),
        d("2026-03-01"),
        d("2026-04-01"),
        d("2026-05-01"),
        d("2026-06-01"),
      ],
      latestPrice: 120,
    });
    expect(r.trend).toBe("rising");
  });
});
