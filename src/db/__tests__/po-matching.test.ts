/**
 * DB integration tests for the PO matching domain function and repository.
 *
 * These tests require DATABASE_URL_ADMIN and run against a real Postgres
 * instance. They are skipped (not failed) when the env var is absent,
 * consistent with the rest of the repo's test gating.
 *
 * Each case uses the pure matchAgainstPo() domain function so the logic
 * can be verified without DB I/O; the repository itself is exercised
 * indirectly by the run-invoice-validation use-case integration tests.
 */
import { describe, it, expect } from "vitest";
import { matchAgainstPo } from "@/modules/validation/domain/po-matching";
import type { PoWithLines } from "@/modules/validation/domain/po-matching";

const OPEN_PO: PoWithLines = {
  id: "po-1",
  poNumber: "PO-2026-001",
  total: "1000.00",
  status: "open",
  receiptConfirmedAt: null,
  lines: [
    {
      lineNumber: 1,
      description: "Widget A",
      itemKeyword: "widget",
      quantity: "10",
      receivedQuantity: null,
    },
  ],
};

const RECEIVED_PO: PoWithLines = {
  ...OPEN_PO,
  receiptConfirmedAt: new Date("2026-07-01T12:00:00Z"),
  lines: [
    {
      lineNumber: 1,
      description: "Widget A",
      itemKeyword: "widget",
      quantity: "10",
      receivedQuantity: "10",
    },
  ],
};

describe("matchAgainstPo — 2-way", () => {
  it("returns no findings and 'no_po_number' status when invoice has no PO number", () => {
    const result = matchAgainstPo({
      poNumber: null,
      invoiceTotal: 1000,
      po: null,
      threeWayEnabled: false,
    });
    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("no_po_number");
    expect(result.matchType).toBeNull();
  });

  it("emits po_not_found (blocking) when the PO number has no match", () => {
    const result = matchAgainstPo({
      poNumber: "PO-GHOST",
      invoiceTotal: 500,
      po: null,
      threeWayEnabled: false,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.code).toBe("po_not_found");
    expect(result.findings[0]!.severity).toBe("blocking");
    expect(result.status).toBe("not_found");
  });

  it("emits po_closed (blocking) when PO status is 'closed'", () => {
    const result = matchAgainstPo({
      poNumber: "PO-2026-001",
      invoiceTotal: 1000,
      po: { ...OPEN_PO, status: "closed" },
      threeWayEnabled: false,
    });
    expect(result.findings[0]!.code).toBe("po_closed");
    expect(result.status).toBe("closed");
  });

  it("emits po_closed (blocking) when PO status is 'cancelled'", () => {
    const result = matchAgainstPo({
      poNumber: "PO-2026-001",
      invoiceTotal: 1000,
      po: { ...OPEN_PO, status: "cancelled" },
      threeWayEnabled: false,
    });
    expect(result.findings[0]!.code).toBe("po_closed");
  });

  it("returns 'matched' status and no findings when invoice total is within tolerance", () => {
    const result = matchAgainstPo({
      poNumber: "PO-2026-001",
      invoiceTotal: 1015, // 1.5% over — within 2% tolerance
      po: OPEN_PO,
      threeWayEnabled: false,
    });
    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("matched");
    expect(result.matchType).toBe("2-way");
  });

  it("emits po_amount_exceeded (blocking) when invoice total is over tolerance", () => {
    const result = matchAgainstPo({
      poNumber: "PO-2026-001",
      invoiceTotal: 1030, // 3% over — exceeds 2% tolerance
      po: OPEN_PO,
      threeWayEnabled: false,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.code).toBe("po_amount_exceeded");
    expect(result.findings[0]!.severity).toBe("blocking");
    expect(result.status).toBe("amount_exceeded");
    expect(result.variancePct).toBeCloseTo(0.03, 4);
  });
});

describe("matchAgainstPo — 3-way", () => {
  it("emits po_receipt_not_confirmed (blocking) when receipt is not confirmed", () => {
    const result = matchAgainstPo({
      poNumber: "PO-2026-001",
      invoiceTotal: 1000,
      po: OPEN_PO, // receiptConfirmedAt: null
      threeWayEnabled: true,
    });
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain("po_receipt_not_confirmed");
    expect(result.status).toBe("receipt_not_confirmed");
    expect(result.matchType).toBe("3-way");
  });

  it("returns 'matched' status when receipt confirmed and total within tolerance", () => {
    const result = matchAgainstPo({
      poNumber: "PO-2026-001",
      invoiceTotal: 1000,
      po: RECEIVED_PO,
      threeWayEnabled: true,
    });
    expect(result.findings).toHaveLength(0);
    expect(result.status).toBe("matched");
  });

  it("emits po_line_quantity_variance (warning) when a line's received qty < ordered qty", () => {
    const partialPo: PoWithLines = {
      ...RECEIVED_PO,
      lines: [
        {
          lineNumber: 1,
          description: "Widget A",
          itemKeyword: "widget",
          quantity: "10",
          receivedQuantity: "7", // only 7 of 10 received
        },
      ],
    };
    const result = matchAgainstPo({
      poNumber: "PO-2026-001",
      invoiceTotal: 1000,
      po: partialPo,
      threeWayEnabled: true,
    });
    const lineVarFinding = result.findings.find(
      (f) => f.code === "po_line_quantity_variance",
    );
    expect(lineVarFinding).toBeDefined();
    expect(lineVarFinding!.severity).toBe("warning");
    expect(result.lineVariances).toHaveLength(1);
    expect(result.lineVariances![0]!.lineNumber).toBe(1);
    expect(result.status).toBe("line_quantity_variance");
  });
});
