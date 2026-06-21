/**
 * Phase 9.5 PR2 — contract → vendor resolver.
 *
 * Looks up an existing vendor whose canonical name (or any alias)
 * matches the contract's extracted vendor name. Strictly deterministic:
 *
 *   1. normalize_vendor_text(extractedName) === vendors.normalizedName
 *   2. normalize_vendor_text(extractedName) === ANY(vendors.aliases)
 *
 * No fuzzy / Jaccard pass. The invoice approval flow (Phase 7) uses
 * fuzzy matching because reviewers see the result and can correct it
 * inline before approval; contract activation, by contrast, is an
 * admin action with no inline correction loop, so a confident match
 * is the only safe automatic path. When this resolver returns null,
 * the admin assigns the vendor manually at activation time.
 *
 * No vendor row is created here — that's the admin's call too. A
 * contract for an unknown vendor sits in `extracted` with vendor_id
 * NULL until the admin either creates the vendor (existing /vendors
 * create flow, future PR) or maps it to an existing one.
 */
import { and, eq, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { vendors } from "@/db/schema";

export interface ResolveContractVendorInput {
  organizationId: string;
  extractedVendorName: string | null;
  /**
   * Optional client scope. When present, only vendors belonging to
   * this client are considered. When null, any vendor in the org is
   * a candidate (matches the invoice path's broader scope when the
   * contract upload doesn't specify a client).
   */
  clientId: string | null;
}

export interface ResolveContractVendorResult {
  vendorId: string;
  /** 'normalized' (exact match on canonical name) | 'alias' (matched a stored alias). */
  method: "normalized" | "alias";
}

export async function resolveContractVendor(
  tx: Tx,
  input: ResolveContractVendorInput,
): Promise<ResolveContractVendorResult | null> {
  if (!input.extractedVendorName) return null;

  // normalize_vendor_text() is the SQL function added in sidecar 0011 —
  // single source of truth that the Phase 7 vendor_pricing_history,
  // PR8's functional index, and the recompute job all rely on. Calling
  // it server-side keeps JS and SQL in lockstep.
  const rows = await tx
    .select({
      id: vendors.id,
      normalizedName: vendors.normalizedName,
      // Drizzle returns Postgres text[] as string[]. We compare against
      // the normalized form so a stored alias like 'acme supplies'
      // matches an extracted 'ACME Supplies, LLC.'.
    })
    .from(vendors)
    .where(
      and(
        eq(vendors.organizationId, input.organizationId),
        // Per-client scoping when the contract carries a client.
        input.clientId
          ? eq(vendors.clientId, input.clientId)
          : // No-op true filter when client is unscoped.
            sql`true`,
        or(
          sql`${vendors.normalizedName} = normalize_vendor_text(${input.extractedVendorName})`,
          sql`normalize_vendor_text(${input.extractedVendorName}) = ANY(${vendors.aliases})`,
        ),
      ),
    )
    .limit(2);

  if (rows.length === 0) return null;

  // Two matches mean an alias has been promoted onto a different
  // vendor by mistake (data-integrity edge case). Prefer the row
  // whose canonical name matches — that's strictly the safer call.
  if (rows.length > 1) {
    const normalizedMatch = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.organizationId, input.organizationId),
          sql`${vendors.normalizedName} = normalize_vendor_text(${input.extractedVendorName})`,
        ),
      )
      .limit(1);
    if (normalizedMatch[0]) {
      return { vendorId: normalizedMatch[0].id, method: "normalized" };
    }
    // Both are alias-only matches against different vendors. Decline to
    // auto-resolve — admin assignment at activation time is safer than
    // guessing.
    return null;
  }

  // Single match. Differentiate normalized vs alias by re-checking the
  // canonical name — alias matches set method to 'alias' so the audit
  // event records *how* we resolved.
  const onlyRow = rows[0];
  if (
    onlyRow.normalizedName !== null &&
    (await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.id, onlyRow.id),
          sql`${vendors.normalizedName} = normalize_vendor_text(${input.extractedVendorName})`,
        ),
      )
      .limit(1)).length > 0
  ) {
    return { vendorId: onlyRow.id, method: "normalized" };
  }

  return { vendorId: onlyRow.id, method: "alias" };
}
