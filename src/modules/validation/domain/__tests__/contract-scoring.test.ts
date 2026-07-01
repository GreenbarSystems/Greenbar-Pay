/**
 * Phase 9.5 PR3 — scoreLineAgainstContract pure tests.
 *
 * Pins:
 *   · null-keyword / null-price / empty-contract-lines short-circuit
 *   · within-contract (≤ warn threshold) → info finding
 *   · above warn (10%-25%) → warning finding
 *   · above block (> 25%) → blocking finding
 *   · currency mismatch → warning finding with currency_mismatch reason
 *   · keyword miss within a populated contract → null (caller falls
 *     through to statistical rate-drift)
 *   · below-contract pricing → info "at or below" message
 */
import { describe, it, expect } from "vitest";
import {
  scoreLineAgainstContract,
  CONTRACT_WARNING_OVERAGE,
  CONTRACT_BLOCKING_OVERAGE,
  type ContractLineMatch,
} from "@/modules/validation/domain/contract-scoring";

const LINES: ContractLineMatch[] = [
  {
    itemKeyword: "premium widget",
    unitPrice: 10,
    currency: "USD",
    priceBasis: "per_unit",
  },
  {
    itemKeyword: "install labor",
    unitPrice: 85,
    currency: "USD",
    priceBasis: "per_hour",
  },
];

describe("scoreLineAgainstContract — short-circuits", () => {
  it("returns null when invoiceKeyword is null", () => {
    const r = scoreLineAgainstContract(
      {
        lineNumber: 1,
        invoiceKeyword: null,
        invoiceUnitPrice: 12,
        invoiceCurrency: "USD",
      },
      LINES,
    );
    expect(r).toBeNull();
  });

  it("returns null when invoiceUnitPrice is null", () => {
    const r = scoreLineAgainstContract(
      {
        lineNumber: 1,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: null,
        invoiceCurrency: "USD",
      },
      LINES,
    );
    expect(r).toBeNull();
  });

  it("returns null when contractLines is empty", () => {
    const r = scoreLineAgainstContract(
      {
        lineNumber: 1,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: 12,
        invoiceCurrency: "USD",
      },
      [],
    );
    expect(r).toBeNull();
  });

  it("returns null when the keyword isn't in the contract", () => {
    const r = scoreLineAgainstContract(
      {
        lineNumber: 1,
        invoiceKeyword: "unknown widget",
        invoiceUnitPrice: 12,
        invoiceCurrency: "USD",
      },
      LINES,
    );
    expect(r).toBeNull();
  });
});

describe("scoreLineAgainstContract — tiers", () => {
  it("emits within_contract_rate info for at-or-below pricing", () => {
    const r = scoreLineAgainstContract(
      {
        lineNumber: 3,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: 9, // 10% below
        invoiceCurrency: "USD",
      },
      LINES,
    );
    expect(r).not.toBeNull();
    expect(r!.finding.code).toBe("within_contract_rate");
    expect(r!.finding.severity).toBe("info");
    expect(r!.finding.message.toLowerCase()).toContain("at or below");
  });

  it("emits within_contract_rate info for ≤ warn-threshold overage", () => {
    const justUnder = 10 * (1 + CONTRACT_WARNING_OVERAGE - 0.001);
    const r = scoreLineAgainstContract(
      {
        lineNumber: 4,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: justUnder,
        invoiceCurrency: "USD",
      },
      LINES,
    );
    expect(r!.finding.code).toBe("within_contract_rate");
    expect(r!.finding.severity).toBe("info");
  });

  it("emits above_contract_rate warning between warn and block thresholds", () => {
    const r = scoreLineAgainstContract(
      {
        lineNumber: 5,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: 12, // 20% over
        invoiceCurrency: "USD",
      },
      LINES,
    );
    expect(r!.finding.code).toBe("above_contract_rate");
    expect(r!.finding.severity).toBe("warning");
    expect(r!.contractUnitPrice).toBe(10);
    expect(r!.overage).toBeCloseTo(0.2);
  });

  it("emits severely_above_contract_rate blocking past block threshold", () => {
    const justOver = 10 * (1 + CONTRACT_BLOCKING_OVERAGE + 0.001);
    const r = scoreLineAgainstContract(
      {
        lineNumber: 6,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: justOver,
        invoiceCurrency: "USD",
      },
      LINES,
    );
    expect(r!.finding.code).toBe("severely_above_contract_rate");
    expect(r!.finding.severity).toBe("blocking");
  });

  it("emits currency_mismatch warning when currencies differ", () => {
    const r = scoreLineAgainstContract(
      {
        lineNumber: 7,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: 10,
        invoiceCurrency: "EUR",
      },
      LINES,
    );
    expect(r!.finding.code).toBe("above_contract_rate");
    expect(r!.finding.severity).toBe("warning");
    expect(
      (r!.finding.context as { reason?: string } | undefined)?.reason,
    ).toBe("currency_mismatch");
  });

  it("does not flag currency mismatch when either side is null", () => {
    // null invoice currency — assume the contract currency
    const r1 = scoreLineAgainstContract(
      {
        lineNumber: 8,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: 11,
        invoiceCurrency: null,
      },
      LINES,
    );
    expect(r1!.finding.code).toBe("within_contract_rate");

    // null contract currency — same
    const r2 = scoreLineAgainstContract(
      {
        lineNumber: 9,
        invoiceKeyword: "premium widget",
        invoiceUnitPrice: 11,
        invoiceCurrency: "USD",
      },
      LINES.map((l) =>
        l.itemKeyword === "premium widget" ? { ...l, currency: null } : l,
      ),
    );
    expect(r2!.finding.code).toBe("within_contract_rate");
  });
});
