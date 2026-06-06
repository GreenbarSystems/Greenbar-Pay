/**
 * Text quality scoring — PRD: "text length, invoice keyword score, and
 * extraction method". Single 0..1 number drives the OCR-fallback decision.
 *
 * Heuristic, not learned. Cheap, deterministic, and good enough for "is
 * there enough usable text here, or should we try OCR?"
 */

// Words that overwhelmingly appear on real AP invoices. A document with
// several of these is almost certainly an invoice that extracted readable
// text. The list intentionally avoids language-specific terms.
const INVOICE_KEYWORDS = [
  "invoice",
  "bill",
  "total",
  "subtotal",
  "tax",
  "due",
  "date",
  "amount",
  "balance",
  "qty",
  "quantity",
  "price",
  "unit",
  "remit",
  "po",
  "terms",
  "net",
  "vendor",
  "customer",
];

export function scoreText(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  // Length contribution: caps out around 1500 chars. Most real invoices
  // hit this — below 100 chars is "almost certainly OCR-needed."
  const lengthScore = Math.min(trimmed.length / 1500, 1);

  // Keyword contribution: how many of the canonical AP terms appear?
  const lower = trimmed.toLowerCase();
  const hits = INVOICE_KEYWORDS.filter((k) =>
    new RegExp(`\\b${k}\\b`, "i").test(lower),
  ).length;
  const keywordScore = Math.min(hits / 8, 1); // 8 hits → full marks

  // Garbage-character ratio: high non-printable or run-on ratios suggest
  // failed OCR or mis-decoded bytes.
  const printable = trimmed.replace(/[^\x20-\x7E\s]/g, "").length;
  const printableRatio = printable / trimmed.length;
  const cleanlinessScore = printableRatio; // already 0..1

  // Weighted average. Length matters less than keywords for the
  // fallback decision; cleanliness gates the rest.
  return Number(
    (lengthScore * 0.3 + keywordScore * 0.5 + cleanlinessScore * 0.2).toFixed(4),
  );
}

/** Threshold the process-document job uses to decide "try OCR." */
export const LOW_QUALITY_THRESHOLD = 0.25;

/** §2.6 warning threshold: low text length flag for the review queue. */
export const LOW_TEXT_LENGTH = 100;
