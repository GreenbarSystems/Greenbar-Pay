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
  "remit_to_name",
  "remitToName",
  "remit_to_address",
  "remitToAddress",
  // Email pipeline PII (email_messages table: fromEmail, fromName, bodyText).
  // 2026-07-13 audit F9 — these were missing; they can surface in Postgres
  // error messages echoing insert values, and in structured objects passed
  // to scrub() from error catch paths.
  "email",
  "from_email",
  "fromEmail",
  "from_name",
  "fromName",
  "body_text",
  "bodyText",
  // Whole-payload poison: the document text and the prompt body.
  "userText",
  "systemPrompt",
  "documentText",
  "outputJson",
  "output_json",
];

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

const REDACTED = "[REDACTED]";

/**
 * PR4 — review #26: pre-compile the per-key regex pairs ONCE at module
 * load. Previously scrubError() built `2 * SENSITIVE_KEYS.length`
 * RegExp objects per call (40 today). The compiled regexes are kept
 * `lastIndex`-stateless thanks to the `g` flag + .replace usage.
 */
const SCRUB_PATTERNS: ReadonlyArray<{ quoted: RegExp; bare: RegExp }> =
  SENSITIVE_KEYS.map((k) => ({
    // "key":"…"
    quoted: new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`, "gi"),
    // key=…
    bare: new RegExp(`(${k}\\s*=\\s*)\\S+`, "gi"),
  }));

/**
 * Recursively redact known-sensitive keys. Returns the input as-is when
 * possible (PR4 — review #27 short-circuit).
 */
export function scrub<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    // Short-circuit: if every element is a primitive AND no element is
    // itself an object/array, return as-is. The common audit-log case
    // doesn't allocate.
    if (value.every((v) => typeof v !== "object" || v === null)) return value;
    return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  }
  if (typeof value === "object") {
    // Short-circuit: shallow object with no sensitive keys and no nested
    // objects/arrays → return as-is.
    let needsClone = false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_SET.has(k.toLowerCase())) {
        needsClone = true;
        break;
      }
      if (v !== null && typeof v === "object") {
        needsClone = true;
        break;
      }
    }
    if (!needsClone) return value;

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
  let message = base.message;
  // Iterate the pre-compiled regexes (PR4 — review #26).
  for (const p of SCRUB_PATTERNS) {
    message = message.replace(p.quoted, (_, prefix) => `${prefix}"${REDACTED}"`);
    message = message.replace(p.bare, (_, prefix) => `${prefix}${REDACTED}`);
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
