/**
 * PoRegisterRepository implementation.
 * Queries purchase_orders / purchase_order_lines; writes po_match_results.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  purchaseOrders,
  purchaseOrderLines,
  poMatchResults,
} from "@/db/schema";
import type {
  PoMatchResultWrite,
  PoRegisterRepository,
} from "../application/ports";
import type { PoWithLines } from "../domain/po-matching";

async function findByPoNumber(
  tx: Tx,
  orgId: string,
  poNumber: string,
): Promise<PoWithLines | null> {
  const [po] = await tx
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      total: purchaseOrders.total,
      status: purchaseOrders.status,
      receiptConfirmedAt: purchaseOrders.receiptConfirmedAt,
    })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.organizationId, orgId),
        eq(purchaseOrders.poNumber, poNumber),
      ),
    )
    .limit(1);

  if (!po) return null;

  const lines = await tx
    .select({
      lineNumber: purchaseOrderLines.lineNumber,
      description: purchaseOrderLines.description,
      itemKeyword: purchaseOrderLines.itemKeyword,
      quantity: purchaseOrderLines.quantity,
      receivedQuantity: purchaseOrderLines.receivedQuantity,
    })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(purchaseOrderLines.lineNumber);

  return {
    id: po.id,
    poNumber: po.poNumber,
    total: po.total ?? "0",
    status: po.status,
    receiptConfirmedAt: po.receiptConfirmedAt,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber,
      description: l.description,
      itemKeyword: l.itemKeyword,
      quantity: l.quantity,
      receivedQuantity: l.receivedQuantity,
    })),
  };
}

async function upsertMatchResult(
  tx: Tx,
  result: PoMatchResultWrite,
): Promise<void> {
  await tx
    .update(poMatchResults)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(poMatchResults.extractedInvoiceId, result.extractedInvoiceId),
        isNull(poMatchResults.supersededAt),
      ),
    );

  await tx.insert(poMatchResults).values({
    organizationId: result.organizationId,
    extractedInvoiceId: result.extractedInvoiceId,
    purchaseOrderId: result.purchaseOrderId ?? undefined,
    matchType: result.matchType ?? undefined,
    status: result.status,
    invoiceTotal: result.invoiceTotal ?? undefined,
    poTotal: result.poTotal ?? undefined,
    variancePct: result.variancePct ?? undefined,
    lineVariancesJson: result.lineVariancesJson ?? undefined,
  });
}

export const drizzlePoRepository: PoRegisterRepository = {
  findByPoNumber,
  upsertMatchResult,
};
