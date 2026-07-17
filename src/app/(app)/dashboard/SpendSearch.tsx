"use client";

import { useState } from "react";
import type { SpendQueryIntent } from "@/lib/llm/spend-query-schema";

interface SpendQueryResult {
  intent: SpendQueryIntent;
  columns: string[];
  rows: Record<string, string | number | null>[];
  summary: { totalSpend: string | null; invoiceCount: number };
}

const SUGGESTIONS = [
  "Total spend by vendor last 30 days",
  "Approved invoices over $5,000 this year",
  "Monthly spend trend this year",
  "Invoices needing review",
];

function formatCurrency(val: string | number | null): string {
  if (val == null) return "—";
  const n = parseFloat(String(val));
  if (isNaN(n)) return String(val);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function formatCell(col: string, val: string | number | null): string {
  if (val == null || val === "") return "—";
  if (col === "total" || col === "total_spend" || col === "avg_spend") {
    return formatCurrency(val);
  }
  return String(val);
}

function BarChart({ rows, valueCol, labelCol }: {
  rows: Record<string, string | number | null>[];
  valueCol: string;
  labelCol: string;
}) {
  const maxVal = Math.max(
    ...rows.map((r) => parseFloat(String(r[valueCol] ?? "0")) || 0),
  );
  if (maxVal <= 0) return null;

  return (
    <div className="mt-4 space-y-2">
      {rows.slice(0, 12).map((row, i) => {
        const val = parseFloat(String(row[valueCol] ?? "0")) || 0;
        const pct = Math.round((val / maxVal) * 100);
        return (
          <div key={i} className="flex items-center gap-3">
            <span className="w-32 shrink-0 truncate text-right text-xs text-gray-500">
              {String(row[labelCol] ?? "—")}
            </span>
            <div className="flex-1">
              <div className="h-5 overflow-hidden rounded-sm bg-gray-100">
                <div
                  className="h-full bg-green-600 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-gray-700">
              {formatCurrency(row[valueCol])}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const CHART_METRICS = ["total_spend", "avg_spend", "count"];
const CHART_LABELS = ["vendor", "period", "status"];

export function SpendSearch() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SpendQueryResult | null>(null);

  async function search(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/ap/spend/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q.trim() }),
      });
      if (res.status === 429) throw new Error("Daily LLM quota reached. Try again tomorrow.");
      if (res.status === 503) throw new Error("AI service temporarily unavailable.");
      if (!res.ok) throw new Error("Search failed. Please try again.");
      const data: SpendQueryResult = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    search(question);
  }

  const chartMetricCol = result?.columns.find((c) => CHART_METRICS.includes(c));
  const chartLabelCol = result?.columns.find((c) => CHART_LABELS.includes(c));
  const showChart =
    result &&
    chartMetricCol &&
    chartLabelCol &&
    result.rows.length > 1 &&
    result.intent.groupBy != null;

  return (
    <div className="mb-8 rounded-xl border border-gray-200 bg-white p-5">
      <p className="mb-3 text-sm font-medium text-gray-700">Ask about your spend</p>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Total spend by vendor last 30 days"
          className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="shrink-0 rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-40"
        >
          {loading ? "…" : "Ask"}
        </button>
      </form>

      {!result && !loading && !error && (
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQuestion(s);
                search(s);
              }}
              className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-500 hover:border-gray-300 hover:bg-gray-100 hover:text-gray-700"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <p className="mt-4 text-sm text-gray-400">Searching…</p>
      )}

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-xs text-gray-400">{result.intent.explanation}</p>
            <div className="flex shrink-0 gap-3 text-right">
              {result.summary.totalSpend && (
                <span className="text-sm font-semibold tabular-nums text-gray-900">
                  {formatCurrency(result.summary.totalSpend)}
                </span>
              )}
              <span className="text-sm text-gray-500">
                {result.summary.invoiceCount} invoice{result.summary.invoiceCount !== 1 ? "s" : ""}
              </span>
            </div>
          </div>

          {showChart && chartMetricCol && chartLabelCol && (
            <BarChart
              rows={result.rows}
              valueCol={chartMetricCol}
              labelCol={chartLabelCol}
            />
          )}

          {result.rows.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    {result.columns.map((col) => (
                      <th
                        key={col}
                        className="pb-2 pr-4 text-xs font-medium uppercase tracking-wider text-gray-400"
                      >
                        {col.replace(/_/g, " ")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 50).map((row, i) => (
                    <tr key={i} className="border-b border-gray-100 last:border-0">
                      {result.columns.map((col) => (
                        <td key={col} className="py-2 pr-4 tabular-nums text-gray-700">
                          {formatCell(col, row[col] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.rows.length > 50 && (
                <p className="mt-2 text-xs text-gray-400">
                  Showing 50 of {result.rows.length} rows.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-gray-400">No results found.</p>
          )}
        </div>
      )}
    </div>
  );
}
