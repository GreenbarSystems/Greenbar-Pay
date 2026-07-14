/**
 * Remit-to drift detection — fixes "F7: Prompt injection can steer
 * extracted remit-to/total fields" from the 2026-07-13 security audit.
 *
 * This is the defense-in-depth half of the F7 fix (see
 * src/lib/llm/prompt.ts for the instruction-layer hardening). It
 * catches the actual attack outcome — an invoice whose payment
 * destination has changed — REGARDLESS of whether prompt injection,
 * OCR corruption, or a genuinely malicious vendor caused it. A model
 * that resists every injection attempt is still only as good as the
 * next prompt-injection technique; a vendor's remit-to changing
 * unexpectedly is a real, checkable fact about the data.
 *
 * Deliberately a WARNING, not blocking: vendors legitimately change
 * bank details (new bank, factoring arrangement, M&A). The point is
 * to put the change in front of a human reviewer, not to auto-reject
 * it. Comparison is intentionally simple (normalize, exact match) —
 * false positives from benign formatting differences ("Suite 100" vs
 * "Ste 100") are an acceptable cost for a reviewer-facing nudge, not a
 * definitive fraud verdict.
 */

export interface RemitToInfo {
  remitToName: string | null;
  remitToAddress: string | null;
}

export interface RemitToDriftResult {
  changed: boolean;
  priorRemitToName: string | null;
  priorRemitToAddress: string | null;
}

function normalize(s: string | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param current This invoice's extracted remit-to fields.
 * @param prior The vendor's most recently APPROVED invoice's remit-to
 *   fields, or null if this is the vendor's first approved invoice
 *   (nothing to compare against — never "changed" with no baseline).
 */
export function detectRemitToDrift(
  current: RemitToInfo,
  prior: RemitToInfo | null,
): RemitToDriftResult {
  if (!prior) {
    return { changed: false, priorRemitToName: null, priorRemitToAddress: null };
  }

  const priorName = normalize(prior.remitToName);
  const priorAddress = normalize(prior.remitToAddress);
  const currentName = normalize(current.remitToName);
  const currentAddress = normalize(current.remitToAddress);

  // Only compare a field when BOTH sides have a value for it — a
  // field missing on either side isn't evidence of a changed payment
  // destination, just incomplete extraction on one of the invoices.
  const nameChanged = priorName !== "" && currentName !== "" && currentName !== priorName;
  const addressChanged =
    priorAddress !== "" && currentAddress !== "" && currentAddress !== priorAddress;

  return {
    changed: nameChanged || addressChanged,
    priorRemitToName: prior.remitToName,
    priorRemitToAddress: prior.remitToAddress,
  };
}
