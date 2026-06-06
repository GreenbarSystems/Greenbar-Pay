/**
 * Log scrubber (addendum §2.4).
 *
 *   "A Sentry/Datadog scrubber strips any field matching
 *    vendor_name|invoice_number|account_number|routing|ein|ssn|tax_id."
 *
 * Sensitive payloads should never reach stdout / APM. Application code
 * that needs to log structured context wraps it with `scrub()`. Errors
 * thrown by the LLM gateway are wrapped by `scrubError()` so the message
 * itself is sanitized — providers love echoing the offending JSON back.
 *
 * The Anthropic SDK includes structured `Anthropic.APIError` with a
 * `body` field carrying the request payload; that's what we redact.
 */
const SENSITIVE_KEYS = [
  "vendor_name",
  "vendorName",
  "invoice_number",
  "invoiceNumber",
  "account_number",
  "accountNumber",
  "routing",
  "routing_number",
  "routingNumber",
  "ein",
  "ssn",
  "tax_id",
  "taxId",
  "vendor_address",
  "vendorAddress",
  "remit_to_address",
  "remitToAddress",
  // Whole-payload poison: the document text and the prompt body.
  "userText",
  "systemPrompt",
  "documentText",
  "outputJson",
  "output_json",
];

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

const REDACTED = "[REDACTED]";

/** Recursively redact known-sensitive keys. Mutating walk on a copy. */
export function scrub<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_SET.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = scrub(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Wrap an Error so its message and any structured fields are scrubbed.
 * We don't subclass Error to preserve the original stack trace.
 */
export function scrubError(err: unknown): Error {
  const base =
    err instanceof Error ? err : new Error(typeof err === "string" ? err : "unknown");
  // Scrub the message: look for any sensitive key=value or "key":"value".
  let message = base.message;
  for (const k of SENSITIVE_KEYS) {
    // "key":"…"
    message = message.replace(
      new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`, "gi"),
      `$1"${REDACTED}"`,
    );
    // key=…
    message = message.replace(
      new RegExp(`(${k}\\s*=\\s*)\\S+`, "gi"),
      `$1${REDACTED}`,
    );
  }
  const out = new Error(message);
  out.stack = base.stack;
  // If the error carries structured fields (Anthropic SDK does), scrub them too.
  for (const k of ["body", "data", "context"] as const) {
    const v = (base as unknown as Record<string, unknown>)[k];
    if (v !== undefined) {
      (out as unknown as Record<string, unknown>)[k] = scrub(v);
    }
  }
  return out;
}
