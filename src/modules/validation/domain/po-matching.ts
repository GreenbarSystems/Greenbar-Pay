/**
 * Pure PO-matching logic — 2-way and 3-way purchase order validation.
 *
 * 2-way: match on PO number + verify invoice total is within tolerance.
 * 3-way: additionally require receipt confirmation and check line quantities.
 *
 * PO_AMOUNT_TOLERANCE mirrors MATH_TOLERANCE (0.02) from engine.ts —
 * a 2% band is the industry standard for minor shipping/rounding drift.
 *
 * The function is pure: no I/O, no DB, no env reads. The caller (the
 * use-case) resolves the PO from the DB and passes `threeWayEnabled`
 * from its environment context.
 */
import type { ValidationFinding } from "./engine";

export const PO_AMOUNT_TOLERANCE = 0.02;

export interface PoLine {
  lineNumber: number;
  description: string;
  itemKeyword: string | null;
  quantity: string;
  receivedQuantity: string | null;
}

export interface PoWithLines {
  id: string;
  poNumber: string;
  total: string;
  status: string;
  receiptConfirmedAt: Date | null;
  lines: PoLine[];
}

export interface PoMatchInputs {
  poNumber: string | null;
  invoiceTotal: number;
  /** Null only when poNumber was present but no matching PO was found in the register. */
  po: PoWithLines | null;
  threeWayEnabled: boolean;
}

export interface LineVariance {
  lineNumber: number;
  ordered: string;
  received: string | null;
}

export interface PoMatchOutput {
  findings: ValidationFinding[];
  matchType: "2-way" | "3-way" | null;
  status: string;
  purchaseOrderId: string | null;
  poTotal: number | null;
  variancePct: number | null;
  lineVariances: LineVariance[] | null;
}

export function matchAgainstPo(inputs: PoMatchInputs): PoMatchOutput {
  const { poNumber, invoiceTotal, po, threeWayEnabled } = inputs;

  // No PO number on the invoice — nothing to match, not an error.
  if (!poNumber) {
    return {
      findings: [],
      matchType: null,
      status: "no_po_number",
      purchaseOrderId: null,
      poTotal: null,
      variancePct: null,
      lineVariances: null,
    };
  }

  if (!po) {
    return {
      findings: [
        {
          code: "po_not_found",
          severity: "blocking",
          message: `Purchase order '${poNumber}' was not found in the PO register.`,
          context: { poNumber },
        },
      ],
      matchType: null,
      status: "not_found",
      purchaseOrderId: null,
      poTotal: null,
      variancePct: null,
      lineVariances: null,
    };
  }

  if (po.status === "closed" || po.status === "cancelled") {
    return {
      findings: [
        {
          code: "po_closed",
          severity: "blocking",
          message: `Purchase order '${poNumber}' has status '${po.status}' and cannot receive invoices.`,
          context: { poNumber, poStatus: po.status },
        },
      ],
      matchType: null,
      status: "closed",
      purchaseOrderId: po.id,
      poTotal: Number(po.total),
      variancePct: null,
      lineVariances: null,
    };
  }

  const poTotal = Number(po.total);
  const variancePct = poTotal > 0 ? (invoiceTotal - poTotal) / poTotal : null;
  const findings: ValidationFinding[] = [];

  // 2-way: invoice total within tolerance of the PO total.
  if (variancePct !== null && variancePct > PO_AMOUNT_TOLERANCE) {
    findings.push({
      code: "po_amount_exceeded",
      severity: "blocking",
      message: `Invoice total exceeds PO total by ${(variancePct * 100).toFixed(2)}% (tolerance ${(PO_AMOUNT_TOLERANCE * 100).toFixed(0)}%).`,
      context: {
        invoiceTotal,
        poTotal,
        variancePct: variancePct.toFixed(4),
        tolerancePct: PO_AMOUNT_TOLERANCE,
      },
    });
  }

  // 3-way: receipt confirmation + line quantity checks.
  let lineVariances: LineVariance[] | null = null;
  if (threeWayEnabled) {
    if (!po.receiptConfirmedAt) {
      findings.push({
        code: "po_receipt_not_confirmed",
        severity: "blocking",
        message: `Purchase order '${poNumber}' has not been marked as received.`,
        context: { poNumber },
      });
    }

    const variances: LineVariance[] = po.lines
      .filter(
        (l) =>
          l.receivedQuantity !== null &&
          Number(l.receivedQuantity) < Number(l.quantity),
      )
      .map((l) => ({
        lineNumber: l.lineNumber,
        ordered: l.quantity,
        received: l.receivedQuantity,
      }));

    if (variances.length > 0) {
      lineVariances = variances;
      findings.push({
        code: "po_line_quantity_variance",
        severity: "warning",
        message: `${variances.length} PO line(s) have not been fully received.`,
        context: {
          lines: variances.map((v) => ({
            lineNumber: v.lineNumber,
            ordered: v.ordered,
            received: v.received,
          })),
        },
      });
    }
  }

  const matchType = threeWayEnabled ? "3-way" : "2-way";

  let status: string;
  if (findings.some((f) => f.code === "po_amount_exceeded")) {
    status = "amount_exceeded";
  } else if (findings.some((f) => f.code === "po_receipt_not_confirmed")) {
    status = "receipt_not_confirmed";
  } else if (lineVariances && lineVariances.length > 0) {
    status = "line_quantity_variance";
  } else {
    status = "matched";
  }

  return {
    findings,
    matchType,
    status,
    purchaseOrderId: po.id,
    poTotal,
    variancePct,
    lineVariances,
  };
}
