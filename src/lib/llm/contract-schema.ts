/**
 * Phase 9.5 — Strict vendor contract extraction schema.
 *
 * Two representations of the same shape:
 *   · ContractExtractionSchema  — Zod, used app-side for parsing the
 *     LLM tool-call output.
 *   · CONTRACT_TOOL_JSON_SCHEMA — JSON Schema handed to Anthropic
 *     tool-use. The model is forced to call `emit_contract` whose
 *     input must match.
 *
 * Keep these in lockstep. Unit tests in
 * src/lib/llm/__tests__/contract-schema.test.ts pin the parity and
 * the Zod parse against the canonical example.
 *
 * The schema models the smallest useful contract — header (effective
 * dates, currency, payment terms, optional early-payment discount)
 * plus a rate-card line array. Out of scope for this first cut:
 *   · SLA / penalty clauses
 *   · Tiered pricing brackets (we emit lines with min/max qty but
 *     don't yet model dependent tiers)
 *   · Auto-renewal and amendment lineage
 */
import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const moneyNumber = z.number().finite();
const finiteNumber = z.number().finite();

const ContractLineItem = z.object({
  /** The literal line label from the contract (used for human display). */
  description: z.string(),
  /**
   * Unit price under this contract. Null when the line declares a
   * basis but no fixed rate (e.g. "Quoted per project").
   */
  unitPrice: moneyNumber.nullable(),
  currency: z.string().nullable(),
  /**
   * Free-text basis token. Common values: per_unit, per_hour, flat,
   * tiered, per_month, per_year. Open vocabulary — the validation
   * rule normalizes at match time.
   */
  priceBasis: z.string().nullable(),
  /** Optional tier brackets — null when the line is flat. */
  minQuantity: finiteNumber.nullable(),
  maxQuantity: finiteNumber.nullable(),
  notes: z.string().nullable(),
});

export const ContractExtractionSchema = z.object({
  /** Optional human reference like "MSA-2026-04". */
  contractNumber: z.string().nullable(),
  /** Vendor name as written on the contract (NOT the canonical name). */
  vendorName: z.string().nullable(),
  effectiveDate: isoDate.nullable(),
  expiryDate: isoDate.nullable(),
  paymentTerms: z.string().nullable(),
  /** Default currency for the contract; lines may override per-row. */
  currency: z.string().nullable(),
  /** Early-payment discount terms (e.g. 2% / 10 days). Null if absent. */
  earlyPaymentDiscountPct: finiteNumber.nullable(),
  earlyPaymentDiscountDays: z.number().int().nullable(),
  /**
   * The rate card. Empty array is valid — the contract may be a
   * master service agreement with no rates (the upload still records
   * payment terms + dates).
   */
  lineItems: z.array(ContractLineItem),
  warnings: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});

export type ContractExtractionResult = z.infer<typeof ContractExtractionSchema>;

export const CONTRACT_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    contractNumber: { type: ["string", "null"] },
    vendorName: { type: ["string", "null"] },
    effectiveDate: {
      type: ["string", "null"],
      description: "ISO date, YYYY-MM-DD",
    },
    expiryDate: {
      type: ["string", "null"],
      description: "ISO date, YYYY-MM-DD. Null = open-ended.",
    },
    paymentTerms: {
      type: ["string", "null"],
      description:
        "Free-text payment terms as written on the contract (e.g. 'Net 30').",
    },
    currency: {
      type: ["string", "null"],
      description: "ISO 4217 (USD, EUR, ...). Default currency for line items.",
    },
    earlyPaymentDiscountPct: {
      type: ["number", "null"],
      description:
        "Percentage discount for early payment (e.g. 2 means 2%). Null when no discount terms.",
    },
    earlyPaymentDiscountDays: {
      type: ["number", "null"],
      description:
        "Days before due date that qualify for the early-payment discount. Null when no discount.",
    },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          unitPrice: { type: ["number", "null"] },
          currency: { type: ["string", "null"] },
          priceBasis: {
            type: ["string", "null"],
            description:
              "Pricing unit: per_unit, per_hour, flat, tiered, per_month, per_year.",
          },
          minQuantity: { type: ["number", "null"] },
          maxQuantity: { type: ["number", "null"] },
          notes: { type: ["string", "null"] },
        },
        required: [
          "description",
          "unitPrice",
          "currency",
          "priceBasis",
          "minQuantity",
          "maxQuantity",
          "notes",
        ],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "contractNumber",
    "vendorName",
    "effectiveDate",
    "expiryDate",
    "paymentTerms",
    "currency",
    "earlyPaymentDiscountPct",
    "earlyPaymentDiscountDays",
    "lineItems",
    "warnings",
    "confidence",
  ],
} as const;
