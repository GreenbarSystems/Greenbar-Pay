/**
 * Phase 9 — F06: line-item confidence scoring.
 *
 * Per the cross-industry feature brief (Logistics / Freight Audit AI):
 * each line item is scored against the vendor's accumulated pricing
 * stats for the same item keyword. The output drives both the review
 * UI ("which lines should I look at?") and the rate-drift validator
 * ("is this drift confident enough to flag?").
 *
 * The scorer is pure. The validator passes in the vendor's active
 * vendor_pricing_history row for the matching keyword, or null when no
 * row exists for that keyword on this vendor.
 */

export type LineConfidence = "high" | "medium" | "low" | "new";

export interface LinePricingStats {
  sampleCount: number;
  avgUnitPrice: number;
  /** Sample stddev (n − 1). Null when sample_count < 2 — treat as no signal. */
  stddevUnitPrice: number | null;
}

export interface LineConfidenceResult {
  score: LineConfidence;
  reason: string;
  /** |unit_price − avg| / stddev, or null when stddev is null. */
  stddevDistance: number | null;
}

export interface LineToScore {
  /** Null is treated as "no signal" — scorer returns null result. */
  unitPrice: number | null;
}

/**
 * Score a single line item. Returns null when there's no usable unit
 * price (scorer cannot emit a meaningful signal without one).
 */
export function scoreLine(
  line: LineToScore,
  stats: LinePricingStats | null,
): LineConfidenceResult | null {
  if (line.unitPrice === null || !Number.isFinite(line.unitPrice)) {
    return null;
  }

  // New keyword — never seen for this vendor.
  if (!stats || stats.sampleCount === 0) {
    return {
      score: "new",
      reason: "First time this item has appeared from this vendor.",
      stddevDistance: null,
    };
  }

  // PR11 H7 — reason strings surface to ALL roles via the line
  // confidence tooltip on the review page (LineConfidenceChip's title
  // attribute). The prior strings exposed exact per-vendor averages
  // ("Matches 8-invoice avg of $245.00") to viewer-only users, which
  // widened the in-org information disclosure footprint. Replace exact
  // dollar values with sample counts and σ-distance — both are
  // statistical descriptors a reviewer can act on without disclosing
  // the historical pricing baseline directly.
  if (stats.stddevUnitPrice === null || stats.stddevUnitPrice === 0) {
    if (stats.sampleCount < 2) {
      return {
        score: "low",
        reason: `Seen ${stats.sampleCount} time${stats.sampleCount === 1 ? "" : "s"} — insufficient history to compare.`,
        stddevDistance: null,
      };
    }
    return {
      score: "medium",
      reason: `Seen ${stats.sampleCount} times — prior prices were uniform so any drift cannot be scored statistically.`,
      stddevDistance: null,
    };
  }

  const dist = Math.abs(line.unitPrice - stats.avgUnitPrice) / stats.stddevUnitPrice;
  const distRounded = Math.round(dist * 100) / 100;

  if (dist <= 1.0 && stats.sampleCount >= 5) {
    return {
      score: "high",
      reason: `Within expected range across ${stats.sampleCount} prior samples (≤ 1σ).`,
      stddevDistance: distRounded,
    };
  }

  if (dist <= 2.0 || stats.sampleCount < 5) {
    return {
      score: "medium",
      reason: `${distRounded.toFixed(1)}σ from historical mean — limited history (${stats.sampleCount} samples).`,
      stddevDistance: distRounded,
    };
  }

  return {
    score: "low",
    reason: `${distRounded.toFixed(1)}σ from historical mean — statistically unusual.`,
    stddevDistance: distRounded,
  };
}

/**
 * Phase 9 — D3 rate-drift threshold helpers.
 *
 * PR10 — the prior implementation required `scoreResult.score === "low"`,
 * but scoreLine forces "medium" whenever sampleCount < 5. Net effect:
 * RATE_DRIFT_MIN_SAMPLES = 3 was dead — drift could never fire on
 * 3–4-sample vendors. This decouples the gate from the scorer's verdict
 * and checks the underlying conditions directly:
 *
 *   1. sampleCount >= RATE_DRIFT_MIN_SAMPLES — enough history to compare
 *   2. avgUnitPrice > 0                        — avoids divide-by-zero (C2)
 *   3. stddev is non-null                      — we can score σ-distance
 *   4. |unit_price − avg| / avg > RATE_DRIFT_THRESHOLD — material % drift
 *   5. σ-distance > 1.5                        — statistically material
 *
 * Conditions 4+5 together ensure we don't fire on minor-but-statistically
 * notable noise (e.g. 16% drift on a series with $1 stddev) nor on
 * large-but-statistically-explainable swings (e.g. 50% drift on a vendor
 * whose σ spans both ends).
 *
 * The scorer is no longer in the loop; the validator and the UI can
 * disagree, which is fine — the confidence column is a reviewer hint,
 * the drift finding is a deterministic rule.
 */
export const RATE_DRIFT_THRESHOLD = 0.15;
export const RATE_DRIFT_MIN_SAMPLES = 3;
const RATE_DRIFT_STDDEV_DISTANCE = 1.5;

export function isRateDrift(unitPrice: number, stats: LinePricingStats): boolean {
  if (stats.sampleCount < RATE_DRIFT_MIN_SAMPLES) return false;
  if (stats.avgUnitPrice <= 0) return false; // PR10 C2 — divide-by-zero guard
  if (stats.stddevUnitPrice === null) return false;
  if (stats.stddevUnitPrice <= 0) return false;

  const pctDrift = Math.abs(unitPrice - stats.avgUnitPrice) / stats.avgUnitPrice;
  if (pctDrift <= RATE_DRIFT_THRESHOLD) return false;

  const sigmaDistance = Math.abs(unitPrice - stats.avgUnitPrice) / stats.stddevUnitPrice;
  return sigmaDistance > RATE_DRIFT_STDDEV_DISTANCE;
}
