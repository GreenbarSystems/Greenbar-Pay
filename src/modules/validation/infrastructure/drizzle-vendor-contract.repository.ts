/**
 * VendorContractRepository implementation. Moved verbatim from
 * src/lib/validation/run.ts's scoreLinesAgainstActiveContract helper
 * (the query + rate-card hash portion only — the per-line scoring loop
 * stays in the use case since it calls the pure domain scorer).
 */
import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { vendorContractLines, vendorContracts } from "@/db/schema";
import type { ContractLineMatch } from "../domain/contract-scoring";
import type { ActiveVendorContract, VendorContractRepository } from "../application/ports";

async function findActiveContractWithLines(
  tx: Tx,
  organizationId: string,
  vendorId: string,
): Promise<ActiveVendorContract | null> {
  // PR21 H5 — defence-in-depth: RLS already scopes by org via the
  // app.current_org_id GUC, but every other vendor_contracts read in
  // this codebase carries an explicit organizationId predicate.
  const [contract] = await tx
    .select({ id: vendorContracts.id })
    .from(vendorContracts)
    .where(
      and(
        eq(vendorContracts.organizationId, organizationId),
        eq(vendorContracts.vendorId, vendorId),
        eq(vendorContracts.status, "active"),
        isNull(vendorContracts.supersededAt),
      ),
    )
    .limit(1);
  if (!contract) return null;

  // PR21 H7 — push the IS NOT NULL predicates into SQL so the hot path
  // doesn't transfer (and discard) every header-only / "quoted per
  // project" line. PR21 H5 — also carry the org predicate on lines.
  const contractLineRows = await tx
    .select({
      id: vendorContractLines.id,
      itemKeyword: vendorContractLines.itemKeyword,
      unitPrice: vendorContractLines.unitPrice,
      currency: vendorContractLines.currency,
      priceBasis: vendorContractLines.priceBasis,
    })
    .from(vendorContractLines)
    .where(
      and(
        eq(vendorContractLines.organizationId, organizationId),
        eq(vendorContractLines.contractId, contract.id),
        isNotNull(vendorContractLines.itemKeyword),
        isNotNull(vendorContractLines.unitPrice),
      ),
    );

  const lines: ContractLineMatch[] = contractLineRows.map((row) => ({
    // `!` is sound — the SQL predicates above prove non-null.
    itemKeyword: row.itemKeyword!,
    unitPrice: Number(row.unitPrice!),
    currency: row.currency,
    priceBasis: row.priceBasis,
  }));

  // PR21 H2 — hash the rate-card lines that participated in scoring.
  // Sorting deterministically by id keeps the hash stable across query
  // orderings; the (id, keyword, unitPrice, currency) tuple is the
  // minimum that affects the scored outcome. Phase 11's evidence
  // packet treats this as the binding from a contract.activated event
  // to the validation.contract_scored event.
  const sortedForHash = [...contractLineRows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const rateCardHash = createHash("sha256")
    .update(
      JSON.stringify(
        sortedForHash.map((r) => ({
          id: r.id,
          k: r.itemKeyword,
          p: r.unitPrice,
          c: r.currency,
        })),
      ),
    )
    .digest("hex");

  return { contractId: contract.id, lines, rateCardHash };
}

export const drizzleVendorContractRepository: VendorContractRepository = {
  findActiveContractWithLines,
};
