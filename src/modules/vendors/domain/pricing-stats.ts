/**
 * Phase 9 — D3 per-keyword pricing stats. Pure, framework-free — moved
 * verbatim out of src/jobs/recomputeVendorProfile.ts so the recompute
 * job's data-access/orchestration shell can depend on this as a domain
 * rule rather than embedding the math inline. Logic unchanged.
 */

export interface KeywordStatsInput {
  prices: number[];
  dates: Date[];
  latestPrice: number;
  /**
   * PR13 — opt-in skip for the trend block's internal re-sort. The
   * recompute hot-path calls `truncateToMostRecent` first, which
   * guarantees date-ascending order; passing `presorted: true` saves
   * a full O(n log n) sort and a transient `Array<{p,d}>` per
   * keyword. Tests and callers without the guarantee can omit it
   * (default false — preserves the prior re-sort behaviour).
   */
  presorted?: boolean;
}

export interface KeywordStats {
  sampleCount: number;
  avg: number;
  stddev: number | null;
  min: number;
  max: number;
  lastPrice: number;
  trend: "stable" | "rising" | "falling" | "insufficient_data";
}

const TREND_DELTA_THRESHOLD = 0.05;

/**
 * Trend is bucketed: split the chronologically-ordered price series in
 * thirds, compare the mean of the most-recent third to the mean of the
 * oldest third. > 5% up → rising; > 5% down → falling; else stable.
 * The split-thirds approach is robust to outliers without needing a
 * full regression. Under 6 samples returns `insufficient_data`.
 */
export function computeKeywordStats(input: KeywordStatsInput): KeywordStats {
  const n = input.prices.length;
  const avg = input.prices.reduce((a, p) => a + p, 0) / n;
  const min = Math.min(...input.prices);
  const max = Math.max(...input.prices);

  // Sample standard deviation (n − 1). NULL when n < 2 — the rate-drift
  // validator treats NULL stddev as "no signal" and skips the finding.
  let stddev: number | null = null;
  if (n >= 2) {
    const variance =
      input.prices.reduce((a, p) => a + (p - avg) ** 2, 0) / (n - 1);
    stddev = Math.sqrt(variance);
  }

  // PR10 M1 — n < 6 is insufficient_data. At n=3-5 the prior split-thirds
  // compared single prices end-to-end (third = max(1, floor(n/3)) = 1),
  // making the trend signal volatile to a single noisy sample. n=6 with
  // third=2 gives two prices per bucket — the minimum that yields a
  // statistically defensible direction.
  let trend: KeywordStats["trend"] = "insufficient_data";
  if (n >= 6) {
    // PR13 — when the caller already guarantees date-ascending prices
    // (recompute does via truncateToMostRecent), skip the resort and
    // work directly on input.prices. Eliminates the per-keyword
    // Array<{p,d}> allocation that dominated GC at scale.
    let sorted: number[];
    if (input.presorted) {
      sorted = input.prices;
    } else {
      const indexed = input.prices.map((p, i) => ({ p, d: input.dates[i] }));
      indexed.sort((a, b) => a.d.getTime() - b.d.getTime());
      sorted = indexed.map((x) => x.p);
    }
    const third = Math.max(2, Math.floor(n / 3));
    const oldMean = mean(sorted.slice(0, third));
    const newMean = mean(sorted.slice(-third));
    const delta = oldMean === 0 ? 0 : (newMean - oldMean) / oldMean;
    if (delta > TREND_DELTA_THRESHOLD) trend = "rising";
    else if (delta < -TREND_DELTA_THRESHOLD) trend = "falling";
    else trend = "stable";
  }

  return {
    sampleCount: n,
    avg,
    stddev,
    min,
    max,
    lastPrice: input.latestPrice,
    trend,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

/**
 * PR10 C3 — trim a keyword series in place to the N most-recent samples
 * by date. Idempotent when the series is already at or under the cap.
 *
 * PR13 — sort once descending, slice, then reverse in place to restore
 * date-asc order. The prior implementation sorted twice (desc to pick,
 * asc to restore), and the inner Array.prototype.reverse() is O(n) vs
 * the prior O(n log n) second sort. The indexed object array is still
 * unavoidable since we sort prices BY a parallel date array, but it
 * now lives for one pass instead of two. Returns the series in date-
 * ascending order so computeKeywordStats can skip its own re-sort.
 */
export function truncateToMostRecent(
  series: { prices: number[]; dates: Date[] },
  cap: number,
): void {
  if (series.prices.length <= cap) return;
  const indexed = series.prices.map((p, i) => ({ p, d: series.dates[i] }));
  indexed.sort((a, b) => b.d.getTime() - a.d.getTime());
  indexed.length = cap;
  indexed.reverse();
  series.prices = indexed.map((x) => x.p);
  series.dates = indexed.map((x) => x.d);
}
