/**
 * Strict invoice extraction schema (PRD §"LLM Extraction Schema").
 *
 * Two representations of the same shape:
 *   - `InvoiceExtractionSchema` — Zod, used for app-side validation.
 *   - `INVOICE_TOOL_JSON_SCHEMA` — the JSON Schema we pass to Anthropic's
 *     tool-use API. Constrains decoding so the model can't emit a
 *     malformed payload in the first place.
 *
 * Keep these in lockstep. The unit test asserts the Zod parse succeeds
 * on the example object from the PRD and rejects obvious malformations.
 */
import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const moneyNumber = z.number().finite();

const LineItem = z.object({
  description: z.string().nullable(),
  quantity: z.number().finite().nullable(),
  unitPrice: z.number().finite().nullable(),
  amount: moneyNumber.nullable(),
});

export const InvoiceExtractionSchema = z.object({
  documentType: z.enum(["invoice", "credit_memo", "statement", "receipt", "unknown"]),
  vendorName: z.string().nullable(),
  vendorAddress: z.string().nullable(),
  remitToName: z.string().nullable(),
  remitToAddress: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  paymentTerms: z.string().nullable(),
  purchaseOrderNumber: z.string().nullable(),
  currency: z.string().nullable(),
  subtotal: moneyNumber.nullable(),
  tax: moneyNumber.nullable(),
  shipping: moneyNumber.nullable(),
  discount: moneyNumber.nullable(),
  total: moneyNumber.nullable(),
  lineItems: z.array(LineItem),
  warnings: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});

export type InvoiceExtractionResult = z.infer<typeof InvoiceExtractionSchema>;

/**
 * JSON Schema (Draft 2020-12) handed to Anthropic tool-use. The model
 * is forced to call the `emit_invoice` tool whose input must match.
 *
 * Property order here is deliberate — recent invoices in our test set
 * are easier for the model when header fields lead line items.
 */
export const INVOICE_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    documentType: {
      type: "string",
      enum: ["invoice", "credit_memo", "statement", "receipt", "unknown"],
    },
    vendorName: { type: ["string", "null"] },
    vendorAddress: { type: ["string", "null"] },
    remitToName: { type: ["string", "null"] },
    remitToAddress: { type: ["string", "null"] },
    invoiceNumber: { type: ["string", "null"] },
    invoiceDate: {
      type: ["string", "null"],
      description: "ISO date, YYYY-MM-DD",
    },
    dueDate: {
      type: ["string", "null"],
      description: "ISO date, YYYY-MM-DD",
    },
    paymentTerms: { type: ["string", "null"] },
    purchaseOrderNumber: { type: ["string", "null"] },
    currency: {
      type: ["string", "null"],
      description: "ISO 4217 (USD, EUR, ...). Preserve the currency shown on the document.",
    },
    subtotal: { type: ["number", "null"] },
    tax: { type: ["number", "null"] },
    shipping: { type: ["number", "null"] },
    discount: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unitPrice: { type: ["number", "null"] },
          amount: { type: ["number", "null"] },
        },
        required: ["description", "quantity", "unitPrice", "amount"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "documentType",
    "vendorName",
    "vendorAddress",
    "remitToName",
    "remitToAddress",
    "invoiceNumber",
    "invoiceDate",
    "dueDate",
    "paymentTerms",
    "purchaseOrderNumber",
    "currency",
    "subtotal",
    "tax",
    "shipping",
    "discount",
    "total",
    "lineItems",
    "warnings",
    "confidence",
  ],
} as const;
