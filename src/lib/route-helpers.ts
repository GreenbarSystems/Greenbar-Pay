/**
 * Small shared helpers for App Router route handlers.
 */
import { NextResponse } from "next/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard for dynamic route segments that must be UUIDs. Returning the
 * NextResponse directly keeps the handler one-liner:
 *
 *   const bad = requireUuid(params.id);
 *   if (bad) return bad;
 *
 * Without this guard, Postgres raises `invalid input syntax for type
 * uuid` and the request 500s — noisy log spam from any garbage probe.
 */
export function requireUuid(value: string): NextResponse | null {
  if (UUID_RE.test(value)) return null;
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

/**
 * Snapshot only the listed keys from a row. Used to populate
 * audit_events.before_json / after_json without dragging in
 * timestamp / FK columns.
 */
export function pickFields<T extends Record<string, unknown>, K extends keyof T>(
  row: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = row[k];
  return out;
}

/**
 * The header fields the review UI lets a user edit, and the same fields
 * we snapshot into audit_events.before_json on approve / reject / patch.
 * Single source of truth so the three handlers can't drift.
 */
export const INVOICE_HEADER_FIELDS = [
  "documentType",
  "vendorName",
  "vendorAddress",
  "remitToName",
  "remitToAddress",
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "paymentTerms",
  "purchaseOrderNumber",
  "currency",
  "subtotal",
  "tax",
  "shipping",
  "discount",
  "total",
  "confidence",
] as const;
