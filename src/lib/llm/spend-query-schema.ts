import { z } from "zod";

/**
 * Structured intent extracted by the LLM from a natural-language spend
 * question. The query builder turns this into a Drizzle query.
 *
 * `timeframe` is a preset name OR a custom range in "YYYY-MM-DD..YYYY-MM-DD"
 * format. Keeping it a single string avoids anyOf in the tool JSON schema,
 * which some models struggle to emit reliably.
 */
export const SpendQueryIntentSchema = z.object({
  timeframe: z.string(),
  vendors: z.array(z.string()),
  amountMin: z.number().nullable(),
  amountMax: z.number().nullable(),
  statuses: z.array(z.enum(["pending", "needs_review", "approved", "rejected", "exported"])),
  groupBy: z.enum(["vendor", "month", "week", "status"]).nullable(),
  metric: z.enum(["total_spend", "invoice_count", "avg_invoice", "list"]),
  lineKeywords: z.array(z.string()),
  explanation: z.string(),
});

export type SpendQueryIntent = z.infer<typeof SpendQueryIntentSchema>;

export const SPEND_QUERY_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    timeframe: {
      type: "string",
      description:
        'One of: "last_30_days", "last_quarter", "last_year", "ytd", "all_time", or a custom date range in "YYYY-MM-DD..YYYY-MM-DD" format.',
    },
    vendors: {
      type: "array",
      items: { type: "string" },
      description: "Partial vendor name fragments to search for.",
    },
    amountMin: {
      type: ["number", "null"],
      description: "Minimum invoice total (USD). null = no minimum.",
    },
    amountMax: {
      type: ["number", "null"],
      description: "Maximum invoice total (USD). null = no maximum.",
    },
    statuses: {
      type: "array",
      items: {
        type: "string",
        enum: ["pending", "needs_review", "approved", "rejected", "exported"],
      },
      description: "Filter by approval status. Empty array = all statuses.",
    },
    groupBy: {
      type: ["string", "null"],
      enum: ["vendor", "month", "week", "status", null],
      description: "How to group aggregated results. null = no grouping.",
    },
    metric: {
      type: "string",
      enum: ["total_spend", "invoice_count", "avg_invoice", "list"],
      description:
        '"list" returns individual invoices. Others return aggregates.',
    },
    lineKeywords: {
      type: "array",
      items: { type: "string" },
      description:
        "Keywords to search in invoice line item descriptions (e.g. \"consulting\", \"software\").",
    },
    explanation: {
      type: "string",
      description:
        "Short plain-English description of what was searched for, shown to the user.",
    },
  },
  required: [
    "timeframe",
    "vendors",
    "amountMin",
    "amountMax",
    "statuses",
    "groupBy",
    "metric",
    "lineKeywords",
    "explanation",
  ],
} as const;
