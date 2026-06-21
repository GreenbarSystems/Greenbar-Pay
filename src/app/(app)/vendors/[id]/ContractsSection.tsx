"use client";

/**
 * Phase 9.5 PR4 — vendor-detail Contracts section.
 *
 * Renders all contracts for the vendor (any status) plus the active
 * one's rate-card. Admin/owner can:
 *   · Upload a new contract — posts multipart to /api/invoices/upload
 *     with documentKind='contract' and the vendor's clientId. The
 *     process-document → extract-contract-data pipeline takes over.
 *   · Activate an extracted contract — POST /api/ap/contracts/[id]/
 *     activate. Server-side it supersedes any prior active for this
 *     vendor in the same tx.
 *
 * Read-only for everyone else; the gate matches the activate
 * endpoint's invoice.override permission so a viewer can't trick
 * the UI into showing affordances the API will reject.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Numeric = string | null;

export interface ContractRow {
  id: string;
  status: string;
  contractNumber: string | null;
  effectiveDate: string | null;
  expiryDate: string | null;
  paymentTerms: string | null;
  currency: string | null;
  confidence: string | null;
  earlyPaymentDiscountPct: Numeric;
  earlyPaymentDiscountDays: number | null;
  documentId: string;
  createdAt: string;
  supersededAt: string | null;
}

export interface ActiveContractLine {
  id: string;
  description: string;
  itemKeyword: string | null;
  unitPrice: Numeric;
  currency: string | null;
  priceBasis: string | null;
  minQuantity: Numeric;
  maxQuantity: Numeric;
  notes: string | null;
}

interface Props {
  vendorId: string;
  clientId: string | null;
  contracts: ContractRow[];
  activeLines: ActiveContractLine[];
  canManage: boolean;
}

export default function ContractsSection({
  vendorId: _vendorId,
  clientId,
  contracts,
  activeLines,
  canManage,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const active = contracts.find((c) => c.status === "active") ?? null;
  const extracted = contracts.filter((c) => c.status === "extracted");
  const archived = contracts.filter(
    (c) => c.status !== "active" && c.status !== "extracted",
  );

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    setInfo(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("documentKind", "contract");
      if (clientId) fd.append("clientId", clientId);
      const res = await fetch("/api/invoices/upload", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message ?? j.error ?? `HTTP ${res.status}`);
        return;
      }
      setInfo(
        "Contract uploaded. Extraction runs in the background — refresh in a moment.",
      );
      router.refresh();
    } finally {
      setUploading(false);
    }
  }

  async function handleActivate(contractId: string) {
    setActivatingId(contractId);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/ap/contracts/${contractId}/activate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: "{}",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message ?? j.error ?? `HTTP ${res.status}`);
        return;
      }
      setInfo("Contract activated.");
      router.refresh();
    } finally {
      setActivatingId(null);
    }
  }

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-700">Contracts</h2>
        {canManage && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf,image/png,image/jpeg,image/tiff"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="rounded-md bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-800 disabled:bg-gray-400"
            >
              {uploading ? "Uploading…" : "Upload contract"}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
          {error}
        </div>
      )}
      {info && !error && (
        <div className="mb-3 rounded border border-green-200 bg-green-50 p-2 text-xs text-green-900">
          {info}
        </div>
      )}

      {contracts.length === 0 ? (
        <p className="text-xs text-gray-500">
          No contracts on file.
          {canManage
            ? " Upload a vendor agreement PDF to seed the rate card."
            : ""}
        </p>
      ) : (
        <div className="space-y-4">
          {/* ── Active contract — primary surface ───────────────── */}
          {active && (
            <div>
              <ContractHeader contract={active} badge="active" />
              {activeLines.length === 0 ? (
                <p className="mt-2 text-xs text-gray-500">
                  No rate card extracted from this contract (header-only
                  agreement).
                </p>
              ) : (
                <table className="mt-2 w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-2 py-1 text-left">Description</th>
                      <th className="px-2 py-1 text-left">Keyword</th>
                      <th className="px-2 py-1 text-right">Rate</th>
                      <th className="px-2 py-1 text-left">Basis</th>
                      <th className="px-2 py-1 text-left">Bracket</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {activeLines.map((l) => (
                      <tr key={l.id}>
                        <td className="px-2 py-1 text-gray-900">
                          {l.description}
                        </td>
                        <td className="px-2 py-1 font-mono text-gray-500">
                          {l.itemKeyword ?? "—"}
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-gray-900">
                          {l.unitPrice
                            ? `${l.currency ?? ""} ${l.unitPrice}`
                            : "—"}
                        </td>
                        <td className="px-2 py-1 text-gray-700">
                          {l.priceBasis ?? "—"}
                        </td>
                        <td className="px-2 py-1 text-gray-700">
                          {l.minQuantity || l.maxQuantity
                            ? `${l.minQuantity ?? "0"}–${l.maxQuantity ?? "∞"}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ── Extracted (not yet active) — needs admin action ─ */}
          {extracted.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">
                Awaiting activation
              </p>
              <ul className="space-y-1">
                {extracted.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs"
                  >
                    <ContractHeaderInline contract={c} />
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => handleActivate(c.id)}
                        disabled={activatingId === c.id}
                        className="rounded bg-gray-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-gray-800 disabled:bg-gray-400"
                      >
                        {activatingId === c.id ? "Activating…" : "Activate"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Archived (superseded / expired / failed) — collapsed by default ─ */}
          {archived.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-gray-500">
                History ({archived.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {archived.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs"
                  >
                    <ContractHeaderInline contract={c} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, string> = {
    active: "bg-green-100 text-green-800 border-green-200",
    extracted: "bg-amber-100 text-amber-800 border-amber-200",
    pending_extraction: "bg-gray-100 text-gray-700 border-gray-200",
    superseded: "bg-gray-100 text-gray-600 border-gray-200",
    expired: "bg-gray-100 text-gray-600 border-gray-200",
    failed: "bg-red-100 text-red-800 border-red-200",
  };
  const klass = palette[status] ?? "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${klass}`}
    >
      {status}
    </span>
  );
}

function ContractHeader({
  contract,
  badge,
}: {
  contract: ContractRow;
  badge?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <StatusBadge status={badge ?? contract.status} />
        <span className="text-sm font-medium text-gray-900">
          {contract.contractNumber ?? "Untitled contract"}
        </span>
        <span className="text-xs text-gray-500">
          {contract.effectiveDate ?? "?"} → {contract.expiryDate ?? "open"}
        </span>
        {contract.paymentTerms && (
          <span className="text-xs text-gray-700">
            · {contract.paymentTerms}
          </span>
        )}
        {contract.currency && (
          <span className="text-xs text-gray-700">· {contract.currency}</span>
        )}
        {contract.earlyPaymentDiscountPct && (
          <span className="text-xs text-gray-700">
            · {contract.earlyPaymentDiscountPct}% disc /{" "}
            {contract.earlyPaymentDiscountDays ?? "?"}d
          </span>
        )}
      </div>
      <span className="text-[10px] text-gray-400">
        Created {contract.createdAt.slice(0, 10)}
      </span>
    </div>
  );
}

function ContractHeaderInline({ contract }: { contract: ContractRow }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <StatusBadge status={contract.status} />
      <span className="font-medium text-gray-900">
        {contract.contractNumber ?? "Untitled"}
      </span>
      <span className="text-gray-500">
        {contract.effectiveDate ?? "?"} → {contract.expiryDate ?? "open"}
      </span>
    </div>
  );
}
