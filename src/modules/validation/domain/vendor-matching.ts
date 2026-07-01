/**
 * Vendor matching. Moved verbatim from src/lib/validation/vendor-match.ts.
 *
 * Phase 7 — D1 from the updated MVP spec:
 *
 *   normalize → exact on normalized_name OR any alias → top Jaccard candidate.
 *
 * The alias check resolves entity variations ("ABC Supplies" ↔
 * "A.B.C. Supplies LLC") immediately as `exact_alias` instead of relying
 * on Jaccard. Aliases are populated by the approve handler when a
 * fuzzy match resolves with reviewer confirmation, so the second
 * occurrence of any variant is a guaranteed exact match.
 */
import { normalizeVendor } from "./engine";

export interface VendorCandidate {
  id: string;
  name: string;
  normalizedName: string;
  /** Normalized variant spellings the matcher has seen previously. */
  aliases?: string[];
}

export type MatchMethod = "exact_normalized" | "exact_alias" | "jaccard" | "none";

export interface VendorMatchResult {
  vendorId: string | null;
  confidence: "low" | "medium" | "high";
  score: number;
  method: MatchMethod;
  candidates: Array<{ id: string; name: string; score: number }>;
}

export function matchVendor(
  extractedName: string | null,
  candidates: VendorCandidate[],
): VendorMatchResult {
  if (!extractedName || candidates.length === 0) {
    return {
      vendorId: null,
      confidence: "low",
      score: 0,
      method: "none",
      candidates: [],
    };
  }

  const target = normalizeVendor(extractedName);
  const targetTokens = new Set(target.split(" ").filter(Boolean));

  // 1. Exact on canonical normalized_name.
  const exact = candidates.find((c) => c.normalizedName === target);
  if (exact) {
    return {
      vendorId: exact.id,
      confidence: "high",
      score: 1,
      method: "exact_normalized",
      candidates: [{ id: exact.id, name: exact.name, score: 1 }],
    };
  }

  // 2. Exact on any alias (already normalized when stored).
  const aliasHit = candidates.find((c) =>
    (c.aliases ?? []).some((a) => a === target),
  );
  if (aliasHit) {
    return {
      vendorId: aliasHit.id,
      confidence: "high",
      score: 1,
      method: "exact_alias",
      candidates: [{ id: aliasHit.id, name: aliasHit.name, score: 1 }],
    };
  }

  // 3. Jaccard token overlap (in-place counter — PR4 review #27).
  const targetSize = targetTokens.size;
  const scored = candidates
    .map((c) => {
      const candTokens = new Set(c.normalizedName.split(" ").filter(Boolean));
      let intersection = 0;
      for (const t of targetTokens) {
        if (candTokens.has(t)) intersection += 1;
      }
      const union = targetSize + candTokens.size - intersection;
      const score = union === 0 ? 0 : intersection / union;
      return { id: c.id, name: c.name, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const best = scored[0];
  const confidence: "low" | "medium" | "high" =
    best.score >= 0.8 ? "high" : best.score >= 0.5 ? "medium" : "low";

  return {
    vendorId: confidence === "low" ? null : best.id,
    confidence,
    score: round4(best.score),
    method: "jaccard",
    candidates: scored,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
