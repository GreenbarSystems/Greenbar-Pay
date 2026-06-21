/**
 * Phase 9.5 — contract schema parity + parse tests.
 *
 * Pins:
 *   · The Zod schema and the JSON Schema agree on the same field set.
 *   · A canonical "happy path" extraction parses cleanly.
 *   · Common malformations (missing required fields, unexpected types)
 *     are rejected so the LLM gateway's retry path fires.
 */
import { describe, it, expect } from "vitest";
import {
  ContractExtractionSchema,
  CONTRACT_TOOL_JSON_SCHEMA,
} from "@/lib/llm/contract-schema";

const HAPPY: unknown = {
  contractNumber: "MSA-2026-04",
  vendorName: "ACME Supplies LLC",
  effectiveDate: "2026-01-01",
  expiryDate: "2026-12-31",
  paymentTerms: "Net 30",
  currency: "USD",
  earlyPaymentDiscountPct: 2,
  earlyPaymentDiscountDays: 10,
  lineItems: [
    {
      description: "Premium Widget 24oz",
      unitPrice: 12.5,
      currency: "USD",
      priceBasis: "per_unit",
      minQuantity: null,
      maxQuantity: null,
      notes: null,
    },
    {
      description: "Installation Labor",
      unitPrice: 85,
      currency: "USD",
      priceBasis: "per_hour",
      minQuantity: null,
      maxQuantity: null,
      notes: "Travel billed separately",
    },
  ],
  warnings: [],
  confidence: "high",
};

describe("ContractExtractionSchema", () => {
  it("parses a complete contract", () => {
    const r = ContractExtractionSchema.safeParse(HAPPY);
    expect(r.success).toBe(true);
  });

  it("accepts an open-ended contract (null expiryDate)", () => {
    const r = ContractExtractionSchema.safeParse({
      ...(HAPPY as Record<string, unknown>),
      expiryDate: null,
    });
    expect(r.success).toBe(true);
  });

  it("accepts an MSA with no rate card (lineItems = [])", () => {
    const r = ContractExtractionSchema.safeParse({
      ...(HAPPY as Record<string, unknown>),
      lineItems: [],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-ISO effective date", () => {
    const r = ContractExtractionSchema.safeParse({
      ...(HAPPY as Record<string, unknown>),
      effectiveDate: "01/01/2026",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-numeric unit price", () => {
    const r = ContractExtractionSchema.safeParse({
      ...(HAPPY as Record<string, unknown>),
      lineItems: [
        {
          description: "Bad",
          unitPrice: "12.50" as unknown as number,
          currency: "USD",
          priceBasis: "per_unit",
          minQuantity: null,
          maxQuantity: null,
          notes: null,
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown confidence band", () => {
    const r = ContractExtractionSchema.safeParse({
      ...(HAPPY as Record<string, unknown>),
      confidence: "very_high",
    });
    expect(r.success).toBe(false);
  });
});

describe("CONTRACT_TOOL_JSON_SCHEMA <-> ContractExtractionSchema parity", () => {
  it("required field lists agree", () => {
    const zodKeys = Object.keys(ContractExtractionSchema.shape).sort();
    const jsonRequired = [...CONTRACT_TOOL_JSON_SCHEMA.required].sort();
    expect(zodKeys).toEqual(jsonRequired);
  });

  it("line-item required field lists agree", () => {
    // The Zod array element shape vs the JSON Schema array.items.required.
    const lineShape = ContractExtractionSchema.shape.lineItems.element.shape;
    const zodKeys = Object.keys(lineShape).sort();
    const jsonRequired = [
      ...CONTRACT_TOOL_JSON_SCHEMA.properties.lineItems.items.required,
    ].sort();
    expect(zodKeys).toEqual(jsonRequired);
  });
});
