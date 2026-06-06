/**
 * Inbound address scheme (addendum §3.2):
 *
 *   ap+<org_slug>--<client_slug>@in.<product-domain>
 *
 * - org_slug and client_slug are URL-safe ASCII (lowercased on org/client creation).
 * - The `--` separator picks the boundary between slugs deterministically
 *   even when slugs themselves contain hyphens.
 * - A wildcard SES receipt rule matches `ap+*@in.<product-domain>`; the
 *   worker parses the left-hand side.
 *
 * Returns null on a malformed local-part. Returns slugs (not IDs) — the
 * caller does the DB lookup so this stays pure / testable.
 */

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface ParsedAddress {
  orgSlug: string;
  clientSlug: string;
  /** Domain portion AFTER the `@`. Useful for env validation. */
  domain: string;
  /** The full original address, lowercased. */
  raw: string;
}

export function parseInboxAddress(address: string): ParsedAddress | null {
  if (typeof address !== "string") return null;
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 2) return null;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (!domain) return null;

  // Must start with `ap+`.
  if (!local.startsWith("ap+")) return null;
  const payload = local.slice(3);

  // Split on the FIRST `--` so a client slug containing `-` is safe.
  const sep = payload.indexOf("--");
  if (sep <= 0 || sep === payload.length - 2) return null;
  const orgSlug = payload.slice(0, sep);
  const clientSlug = payload.slice(sep + 2);

  if (!SLUG_RE.test(orgSlug) || !SLUG_RE.test(clientSlug)) return null;

  return { orgSlug, clientSlug, domain, raw: lower };
}

/**
 * Compose the canonical address for an (orgSlug, clientSlug) pair. Used by
 * the org-settings UI to show "send invoices to this address" copy.
 */
export function composeInboxAddress(args: {
  orgSlug: string;
  clientSlug: string;
  domain: string;
}): string {
  return `ap+${args.orgSlug}--${args.clientSlug}@${args.domain}`;
}
