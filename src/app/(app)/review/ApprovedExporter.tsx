"use client";

/**
 * Client island that wraps the `approved` review-queue table with
 * multi-select checkboxes + bulk Export action.
 *
 * Renders its children (the existing table) untouched; the checkboxes
 * live in a parallel column slot.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

interface Row {
  id: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  total: string | null;
  currency: string | null;
}

interface Props {
  rows: Row[];
}

export default function ApprovedExporter({ rows }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = selected.size > 0 && selected.size === rows.length;

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function exportSelected() {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/ap/exports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        format,
        extractedInvoiceIds: [...selected],
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.message ?? j.error ?? `HTTP ${res.status}`);
      setSubmitting(false);
      return;
    }
    router.push("/exports");
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-white p-3">
        <span className="text-sm text-gray-700">
          {selected.size} selected
        </span>
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as "csv" | "json")}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
        <button
          onClick={exportSelected}
          disabled={selected.size === 0 || submitting}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-400"
        >
          {submitting ? "Creating…" : `Export ${selected.size}`}
        </button>
        {error && (
          <span className="text-xs text-red-700">{error}</span>
        )}
      </div>

      <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="w-8 px-2 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th className="px-4 py-2 text-left">Vendor</th>
              <th className="px-4 py-2 text-left">Invoice #</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="w-8 px-2 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleOne(r.id)}
                    aria-label={`Select ${r.invoiceNumber ?? r.id}`}
                  />
                </td>
                <td className="px-4 py-2 font-medium text-gray-900">
                  {r.vendorName ?? "—"}
                </td>
                <td className="px-4 py-2 text-gray-700">
                  {r.invoiceNumber ?? "—"}
                </td>
                <td className="px-4 py-2 text-right font-mono text-gray-900">
                  {r.total ? `${r.currency ?? ""} ${r.total}` : "—"}
                </td>
                <td className="px-4 py-2 text-right">
                  <a
                    href={`/review/${r.id}`}
                    aria-label={`Open invoice${r.invoiceNumber ? ` ${r.invoiceNumber}` : ""}${r.vendorName ? ` from ${r.vendorName}` : ""}`}
                    className="text-sm text-gray-700 underline hover:text-gray-900"
                  >
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
