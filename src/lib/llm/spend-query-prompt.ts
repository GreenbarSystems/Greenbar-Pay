import { createHash } from "crypto";
import type { BuiltPrompt } from "./prompt";
import { SPEND_QUERY_TOOL_JSON_SCHEMA } from "./spend-query-schema";

export const SPEND_QUERY_PROMPT_NAME = "spend_query_extraction";
export const SPEND_QUERY_PROMPT_VERSION = "2026-07-17";

const SYSTEM_PROMPT = `You are an AP spend-analysis assistant. Extract a structured query intent from the user's natural-language question about their invoice data. You MUST call the extract_spend_query tool.

Today's date: {{TODAY}}

Rules:
- Default timeframe: "last_30_days" when none is specified.
- Vendor names: partial fragments only (e.g. "Acme" not "Acme Corp, Inc.").
- lineKeywords: service/product category words from the question (e.g. "consulting", "software licenses").
- metric "list": return individual invoices. Use for "show me", "find", "which invoices".
- metric "total_spend": use for "how much", "total", "spend".
- metric "invoice_count": use for "how many invoices".
- metric "avg_invoice": use for "average invoice size".
- groupBy "vendor": use when the user wants a breakdown by vendor.
- groupBy "month": use for monthly trends.
- groupBy "status": use for status breakdowns.
- explanation: 1-sentence plain English, e.g. "Approved invoices from Acme in Q1 2026."`;

export function buildSpendQueryPrompt(question: string, today: string): BuiltPrompt {
  const systemPrompt = SYSTEM_PROMPT.replace("{{TODAY}}", today);
  const userText = question.trim();
  const content = systemPrompt + "\n" + userText;

  return {
    systemPrompt,
    userText,
    inputHash: createHash("sha256").update(content).digest("hex"),
    estimatedTokens: Math.ceil(content.length / 4),
    tool: {
      name: "extract_spend_query",
      description:
        "Extract a structured spend query intent from a natural-language question about invoice data.",
      input_schema: SPEND_QUERY_TOOL_JSON_SCHEMA,
    },
  };
}
