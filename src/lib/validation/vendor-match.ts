/**
 * Vendor matching — Phase 4 ships the simple-but-honest version:
 *   normalize → exact match → top candidate by Jaccard token overlap.
 *
 * Returns the best vendor + confidence + score, or null if no candidates.
 * Fuzzy match via Postgres pg_trgm is a later upgrade; this stays pure.
 */
import { normalizeVendor } from ".";

export interface VendorCandidate {
  id: string;
  name: string;
  normalizedName: string;
}

export interface VendorMatchResult {
  vendorId: string | null;
  confidence: "low" | "medium" | "high";
  score: number;
  candidates: Array<{ id: string; name: string; score: number }>;
}

export function matchVendor(
  extractedName: string | null,
  candidates: VendorCandidate[],
): VendorMatchResult {
  if (!extractedName || candidates.length === 0) {
    return { vendorId: null, confidence: "low", score: 0, candidates: [] };
  }

  const target = normalizeVendor(extractedName);
  const targetTokens = new Set(target.split(" ").filter(Boolean));

  // Exact normalized match short-circuits.
  const exact = candidates.find((c) => c.normalizedName === target);
  if (exact) {
    return {
      vendorId: exact.id,
      confidence: "high",
      score: 1,
      candidates: [{ id: exact.id, name: exact.name, score: 1 }],
    };
  }

  // Jaccard overlap on tokens. Cheap, no deps.
  const scored = candidates
    .map((c) => {
      const candTokens = new Set(c.normalizedName.split(" ").filter(Boolean));
      const intersection = [...targetTokens].filter((t) => candTokens.has(t)).length;
      const union = new Set([...targetTokens, ...candTokens]).size;
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
    candidates: scored,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
