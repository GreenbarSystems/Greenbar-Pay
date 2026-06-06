"use client";

/**
 * Side-by-side review UI.
 *
 * - File preview via signed S3/MinIO URL (PDF → <iframe>, image → <img>).
 * - Editable header fields. PATCH includes `If-Match: <updated_at>` so
 *   §4.7 concurrency rejects stale edits with a 409.
 * - Approve / reject use `Idempotency-Key` (§4.6).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@/lib/rbac";
import { can } from "@/lib/rbac";

type Numeric = string | null;

interface InvoiceShape {
  id: string;
  documentType: string;
  vendorName: string | null;
  vendorAddress: string | null;
  remitToName: string | null;
  remitToAddress: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  paymentTerms: string | null;
  purchaseOrderNumber: string | null;
  currency: string | null;
  subtotal: Numeric;
  tax: Numeric;
  shipping: Numeric;
  discount: Numeric;
  total: Numeric;
  confidence: string | null;
  reviewStatus: string;
  updatedAt: string; // ISO string used as the If-Match value
}

interface LineShape {
  id: string;
  lineNumber: number | null;
  description: string | null;
  quantity: Numeric;
  unitPrice: Numeric;
  amount: Numeric;
}

interface Finding {
  code: string;
  severity: string;
  message: string;
}

interface Audit {
  id: string;
  action: string;
  actorType: string;
  createdAt: string;
}

interface Props {
  role: UserRole;
  fileUrl: string;
  fileMime: string;
  invoice: InvoiceShape;
  lines: LineShape[];
  findings: Finding[];
  vendorMatch: {
    confidence: string;
    score: Numeric;
    candidates: Array<{ id: string; name: string; score: number }>;
  } | null;
  audits: Audit[];
}

const FIELDS: Array<keyof InvoiceShape> = [
  "vendorName",
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
];

const FIELD_LABEL: Record<string, string> = {
  vendorName: "Vendor",
  invoiceNumber: "Invoice #",
  invoiceDate: "Invoice date",
  dueDate: "Due date",
  paymentTerms: "Payment terms",
  purchaseOrderNumber: "PO #",
  currency: "Currency",
  subtotal: "Subtotal",
  tax: "Tax",
  shipping: "Shipping",
  discount: "Discount",
  total: "Total",
};

export default function ReviewDetailClient(props: Props) {
  const router = useRouter();
  const canEdit = can(props.role, "invoice.edit");
  const canApprove = can(props.role, "invoice.approve");
  const canReject = can(props.role, "invoice.reject");

  const [form, setForm] = useState<InvoiceShape>(props.invoice);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const isTerminal = ["approved", "rejected", "exported"].includes(form.reviewStatus);

  async function handleSave() {
    if (!canEdit || isTerminal) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    const body: Record<string, unknown> = {};
    for (const k of FIELDS) {
      body[k] = form[k];
    }
    try {
      const res = await fetch(`/api/ap/review/${form.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "If-Match": form.updatedAt,
        },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        setError(
          "This invoice was edited elsewhere. Reload to see the latest version.",
        );
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message ?? j.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
      setInfo("Saved.");
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    if (!canApprove || isTerminal) return;
    const res = await fetch(`/api/ap/review/${form.id}/approve`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.message ?? j.error ?? `HTTP ${res.status}`);
      return;
    }
    router.refresh();
  }

  async function handleReject() {
    if (!canReject || isTerminal) return;
    const reason = window.prompt("Reason for rejection?")?.trim();
    if (!reason) return;
    const res = await fetch(`/api/ap/review/${form.id}/reject`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.message ?? j.error ?? `HTTP ${res.status}`);
      return;
    }
    router.refresh();
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      {/* ── File preview ────────────────────────────────────────────── */}
      <div className="rounded-md border border-gray-200 bg-white p-2">
        <div className="mb-2 flex items-center justify-between px-2">
          <h2 className="text-sm font-medium text-gray-700">Original</h2>
          <a
            href={props.fileUrl}
            className="text-xs text-gray-500 underline hover:text-gray-700"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in new tab
          </a>
        </div>
        {props.fileMime.startsWith("image/") ? (
          <img
            src={props.fileUrl}
            alt="Invoice preview"
            className="mx-auto max-h-[80vh] w-auto rounded border border-gray-200"
          />
        ) : (
          <iframe
            src={props.fileUrl}
            className="h-[80vh] w-full rounded border border-gray-200"
            title="Invoice preview"
          />
        )}
      </div>

      {/* ── Extraction editor + actions ─────────────────────────────── */}
      <div className="space-y-4">
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-700">Extracted fields</h2>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs uppercase tracking-wide text-gray-700">
              {form.reviewStatus}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {FIELDS.map((k) => (
              <label key={k} className="block text-xs font-medium text-gray-600">
                {FIELD_LABEL[k]}
                <input
                  type="text"
                  value={(form[k] as string | null) ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, [k]: e.target.value === "" ? null : e.target.value })
                  }
                  disabled={!canEdit || isTerminal}
                  className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-sm focus:border-gray-900 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
                />
              </label>
            ))}
          </div>

          {error && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900">
              {error}
            </div>
          )}
          {info && !error && (
            <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-2 text-xs text-green-900">
              {info}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={handleSave}
              disabled={!canEdit || saving || isTerminal}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-400"
            >
              {saving ? "Saving…" : "Save edits"}
            </button>
            <button
              onClick={handleApprove}
              disabled={!canApprove || isTerminal}
              className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800 disabled:bg-gray-400"
            >
              Approve
            </button>
            <button
              onClick={handleReject}
              disabled={!canReject || isTerminal}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:border-gray-200 disabled:text-gray-400"
            >
              Reject
            </button>
          </div>
        </div>

        {/* ── Validation findings ─────────────────────────────────── */}
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-700">Validation</h2>
          {props.findings.length === 0 ? (
            <p className="text-xs text-gray-500">No findings — clean extraction.</p>
          ) : (
            <ul className="space-y-1">
              {props.findings.map((f, i) => (
                <li
                  key={i}
                  className={
                    f.severity === "blocking"
                      ? "rounded bg-red-50 px-2 py-1 text-xs text-red-900"
                      : "rounded bg-amber-50 px-2 py-1 text-xs text-amber-900"
                  }
                >
                  <span className="font-mono">{f.code}</span> · {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Line items ──────────────────────────────────────────── */}
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-700">Line items</h2>
          {props.lines.length === 0 ? (
            <p className="text-xs text-gray-500">None.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left">#</th>
                  <th className="text-left">Description</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Unit</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {props.lines.map((l) => (
                  <tr key={l.id} className="border-t border-gray-100">
                    <td className="py-1 text-gray-500">{l.lineNumber ?? "—"}</td>
                    <td className="py-1 text-gray-900">{l.description ?? "—"}</td>
                    <td className="py-1 text-right font-mono">{l.quantity ?? ""}</td>
                    <td className="py-1 text-right font-mono">{l.unitPrice ?? ""}</td>
                    <td className="py-1 text-right font-mono">{l.amount ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Vendor match ────────────────────────────────────────── */}
        {props.vendorMatch && (
          <div className="rounded-md border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-medium text-gray-700">Vendor match</h2>
            <p className="text-xs text-gray-700">
              Confidence:{" "}
              <span className="font-medium">{props.vendorMatch.confidence}</span>
              {props.vendorMatch.score && (
                <>
                  {" · score="}
                  <span className="font-mono">{props.vendorMatch.score}</span>
                </>
              )}
            </p>
            {props.vendorMatch.candidates.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
                {props.vendorMatch.candidates.slice(0, 5).map((c) => (
                  <li key={c.id}>
                    {c.name} <span className="font-mono">({c.score.toFixed(2)})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── Audit ──────────────────────────────────────────────── */}
        <details className="rounded-md border border-gray-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-medium text-gray-700">
            Audit history ({props.audits.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-gray-700">
            {props.audits.map((a) => (
              <li key={a.id} className="flex justify-between">
                <span>
                  <span className="font-mono">{a.action}</span> by {a.actorType}
                </span>
                <span className="text-gray-500">
                  {a.createdAt.slice(0, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
