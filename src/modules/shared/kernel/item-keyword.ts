/**
 * Shared kernel: line-description → grouping-key normalization.
 *
 * Moved verbatim out of src/jobs/recomputeVendorProfile.ts. This isn't
 * private to the vendors module — vendor pricing history, contract
 * line matching (src/jobs/extractContractData.ts), and invoice
 * validation's rate-drift scoring (src/lib/validation/run.ts) all need
 * the exact same stemming so a line item resolves to the same keyword
 * everywhere it's compared. A Shared Kernel (one canonical
 * implementation multiple bounded contexts depend on) is the
 * appropriate DDD pattern here — duplicating this per module would risk
 * the three contexts drifting out of sync the way the JS/SQL
 * normalizeVendor implementations once did (see PR5 review C1 history
 * in git log for what that drift cost).
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
  "service", "services", "fee", "fees", "charge", "charges", "monthly",
  "annual", "quarterly",
]);

/**
 * Reduce a line description to a stable grouping key. Lowercase, strip
 * non-alphanumeric, drop stop words, take first 3 meaningful tokens.
 * Cheap; deterministic; collisions across loosely-related items are
 * acceptable for a Phase 7 first cut.
 */
export function itemKeyword(description: string | null): string | null {
  if (!description) return null;
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return null;
  return tokens.slice(0, 3).join(" ");
}
