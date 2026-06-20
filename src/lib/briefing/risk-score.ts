/**
 * Deterministic risk score (Phase 8 — D2).
 *
 * Per the design decision I flagged in the spec review: the SCORE is
 * deterministic and reproducible across runs; the LLM only writes the
 * justification prose. That makes the number defensible to auditors
 * and stable across model upgrades.
 *
 * Score is a 0–100 value where higher = more reviewer attention warranted.
 *
 * Composition:
 *   start at 0;
 *   add for each blocking validation finding;
 *   add for each warning validation finding;
 *   add for vendor terms drift;
 *   add when vendor's duplicate_submission_count > 0;
 *   add when the active extraction's text quality is low;
 *   add when vendor profile is "warming up" (< 3 invoices) — we
 *     genuinely know less, so the human should pay more attention.
 *
 * The returned factors list is fed to the LLM prompt so the
 * justification prose can reference the strongest contributing factor.
 */

/**
 * PR6 — review #4: version tag for the weight table.
 *
 * Bump on ANY change to WEIGHTS (or to the formula in computeRiskScore).
 * Stored on briefing_cards.risk_score_version so an auditor can
 * reproduce a historical score by checking out the matching commit.
 *
 * Bumping policy: monotonically increasing, dotted, semver-flavored.
 * Major bumps for a re-weight that materially changes the band
 * distribution; minor for adding a factor; patch for tightening
 * descriptions.
 */
export const RISK_SCORE_VERSION = "1.1.0";

export interface RiskFactor {
  code: string;
  weight: number;
  note?: string;
}

export interface RiskScoreInput {
  blockingFindingCount: number;
  warningFindingCount: number;
  vendorTermsDrift: boolean;
  vendorDuplicateCount: number;
  textQualityLow: boolean;
  vendorWarmingUp: boolean;
  /**
   * Phase 9 — D3 rate drift. Count of `unit_price_drift` findings on
   * the active validation row. Each drifting line nudges the score
   * upward, capped at RATE_DRIFT_LINE_CAP so a long invoice with many
   * drifters doesn't red-bar everything by itself.
   */
  rateDriftCount: number;
  /**
   * Phase 9 — F06 new line items. Boolean (whether any line keyword is
   * new for this vendor) rather than a count — first invoice from a
   * vendor with 30 line items should fire once, not 30 times.
   */
  hasNewLineItem: boolean;
}

export interface RiskScoreResult {
  score: number; // 0–100 clamp
  factors: RiskFactor[];
}

const WEIGHTS = {
  blockingFinding: 30,
  warningFinding: 6,
  termsDrift: 12,
  vendorDuplicates: 10,
  lowTextQuality: 8,
  warmingUp: 6,
  // Phase 9 — D3 + F06. Per-line drift gets a meaningful nudge; new
  // line items a one-shot bump.
  rateDriftPerLine: 8,
  newLineItem: 5,
} as const;

const RATE_DRIFT_LINE_CAP = 3;

export function computeRiskScore(input: RiskScoreInput): RiskScoreResult {
  const factors: RiskFactor[] = [];
  let score = 0;

  if (input.blockingFindingCount > 0) {
    const w = WEIGHTS.blockingFinding * input.blockingFindingCount;
    score += w;
    factors.push({
      code: "blocking_findings",
      weight: w,
      note: `${input.blockingFindingCount} blocking finding${input.blockingFindingCount === 1 ? "" : "s"}`,
    });
  }
  if (input.warningFindingCount > 0) {
    const w = WEIGHTS.warningFinding * input.warningFindingCount;
    score += w;
    factors.push({
      code: "warning_findings",
      weight: w,
      note: `${input.warningFindingCount} warning finding${input.warningFindingCount === 1 ? "" : "s"}`,
    });
  }
  if (input.vendorTermsDrift) {
    score += WEIGHTS.termsDrift;
    factors.push({
      code: "vendor_terms_drift",
      weight: WEIGHTS.termsDrift,
      note: "payment terms differ from this vendor's default",
    });
  }
  if (input.vendorDuplicateCount > 0) {
    score += WEIGHTS.vendorDuplicates;
    factors.push({
      code: "vendor_duplicate_history",
      weight: WEIGHTS.vendorDuplicates,
      note: `${input.vendorDuplicateCount} prior duplicate submission${input.vendorDuplicateCount === 1 ? "" : "s"}`,
    });
  }
  if (input.textQualityLow) {
    score += WEIGHTS.lowTextQuality;
    factors.push({
      code: "low_text_quality",
      weight: WEIGHTS.lowTextQuality,
      note: "OCR/native extraction text scored low",
    });
  }
  if (input.vendorWarmingUp) {
    score += WEIGHTS.warmingUp;
    factors.push({
      code: "vendor_warming_up",
      weight: WEIGHTS.warmingUp,
      note: "vendor profile has fewer than 3 prior invoices",
    });
  }
  if (input.rateDriftCount > 0) {
    const capped = Math.min(input.rateDriftCount, RATE_DRIFT_LINE_CAP);
    const w = WEIGHTS.rateDriftPerLine * capped;
    score += w;
    factors.push({
      code: "rate_drift",
      weight: w,
      note: `${input.rateDriftCount} line item${input.rateDriftCount === 1 ? "" : "s"} priced materially above vendor history`,
    });
  }
  if (input.hasNewLineItem) {
    score += WEIGHTS.newLineItem;
    factors.push({
      code: "new_line_item",
      weight: WEIGHTS.newLineItem,
      note: "one or more line items have not been seen from this vendor before",
    });
  }

  // Sort factors by weight desc so the strongest is first in the list
  // — the LLM prompt explicitly tells the model to reference the
  // strongest contributing factor.
  factors.sort((a, b) => b.weight - a.weight);

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    factors,
  };
}

/** Color band per the spec §7.1: green 0–30, amber 31–60, red 61–100. */
export function riskBand(score: number): "green" | "amber" | "red" {
  if (score <= 30) return "green";
  if (score <= 60) return "amber";
  return "red";
}
