/**
 * Generic CSV + JSON exporters. PRD §"Functional Requirements > Export":
 *   - CSV export "with core invoice fields"
 *   - JSON export returns "the normalized invoice object and line items"
 *
 * QuickBooks- / Xero-specific shapes are a follow-up (PRD open question).
 * The generic CSV is column-stable so downstream tooling can rely on it.
 */

/** The columns shipped in the V1 CSV — order matters; keep stable. */
export const CSV_COLUMNS = [
  "invoice_id",
  "document_id",
  "vendor_name",
  "vendor_address",
  "invoice_number",
  "invoice_date",
  "due_date",
  "purchase_order_number",
  "payment_terms",
  "currency",
  "subtotal",
  "tax",
  "shipping",
  "discount",
  "total",
  "document_type",
  "confidence",
  "approved_at",
  "po_match_status",
  "po_variance_pct",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export interface ExportRow {
  invoice_id: string;
  document_id: string;
  vendor_name: string | null;
  vendor_address: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  purchase_order_number: string | null;
  payment_terms: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  shipping: string | null;
  discount: string | null;
  total: string | null;
  document_type: string;
  confidence: string | null;
  approved_at: string | null;
  /** PO matching — null when no PO number was on the invoice. */
  po_match_status: string | null;
  /** Signed percentage as a decimal string, e.g. "0.0125". Null when no PO matched. */
  po_variance_pct: string | null;
  line_items: Array<{
    line_number: number | null;
    description: string | null;
    quantity: string | null;
    unit_price: string | null;
    amount: string | null;
  }>;
}

/**
 * RFC 4180-ish CSV. Always quote string fields so commas / newlines /
 * quotes in vendor names don't blow up downstream parsers. Numeric fields
 * remain unquoted when they're already strings of digits.
 *
 * Null → empty cell. UTF-8 throughout.
 */
export function toCsv(rows: ExportRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => csvCell(row[col])).join(","),
  );
  // PRD doesn't specify line endings; CRLF is the RFC 4180 default and what
  // Excel expects on Windows. Most modern parsers accept either.
  return [header, ...lines].join("\r\n") + "\r\n";
}

function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  // Numeric-looking strings (e.g. "1353.13") pass through unquoted —
  // accountants are sensitive to Excel treating them as text.
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  // Everything else: quote and double any internal quotes.
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** Normalized JSON shape — array of invoices with embedded line items. */
export function toJson(rows: ExportRow[]): string {
  return JSON.stringify({ invoices: rows }, null, 2);
}
