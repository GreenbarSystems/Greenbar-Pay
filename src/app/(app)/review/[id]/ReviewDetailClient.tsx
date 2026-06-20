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
  /** Phase 9 — F06 line-item confidence. Null when never scored. */
  confidenceScore: "high" | "medium" | "low" | "new" | null;
  confidenceReason: string | null;
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
    method: string | null;
    candidates: Array<{ id: string; name: string; score: number }>;
  } | null;
  /** Phase 7 — D1: full longitudinal profile snapshot when a vendor is matched. */
  vendorProfile: {
    id: string;
    name: string;
    invoiceCount: number;
    spend30d: Numeric;
    spend90d: Numeric;
    avgInvoiceAmount: Numeric;
    defaultPaymentTerms: string | null;
    termsDriftDetected: boolean;
    duplicateSubmissionCount: number;
    lastInvoiceDate: string | null;
  } | null;
  /** Phase 8 — D2: the active Briefing Card snapshot, if generation succeeded. */
  briefingCard: {
    glCode: string | null;
    glRationale: string;
    anomalyFlags: Array<{
      code: string;
      severity: "info" | "warning" | "critical";
      message: string;
      /** Phase 9 — F07: optional labelled evidence chain per anomaly. */
      evidenceChain?: Array<{ label: string; detail: string }>;
    }>;
    deltaSummary: string;
    riskScore: number;
    riskJustification: string;
    generatedAt: string;
    /** Phase 10 — D5: deterministic coaching prompts. */
    id: string;
    coachingPrompts: Array<{
      code: string;
      severity: "info" | "warning" | "critical";
      message: string;
      dollarImpact?: number | null;
    }>;
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
          // PR2: client-generated UUID makes network retries replay-safe
          // (server caches the prior response for 24h, avoiding phantom
          // audit rows from duplicate deliveries).
          "Idempotency-Key": crypto.randomUUID(),
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
    // Phase 8 — spec §7.2: Source 40% / Extracted 30% / Briefing+Coaching 30%.
    // minmax(0, …) prevents long line-item descriptions from blowing out
    // the column widths.
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,40fr)_minmax(0,30fr)_minmax(0,30fr)]">
      {/* ── Column 1: Source Document ────────────────────────────────── */}
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

      {/* ── Column 2: Extracted fields + actions + lines + findings ── */}
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
                  <th className="text-left">Confidence</th>
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
                    <td className="py-1">
                      <LineConfidenceChip
                        score={l.confidenceScore}
                        reason={l.confidenceReason}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </div>

      {/* ── Column 3: Briefing Card + Vendor snapshot + Audit ─────── */}
      <div className="space-y-4">
        {/* Phase 8 — D2: the AI's plain-English review brief. */}
        {props.briefingCard ? (
          <BriefingCardPanel card={props.briefingCard} />
        ) : (
          <div className="rounded-md border border-dashed border-gray-300 bg-white p-4 text-xs text-gray-500">
            Briefing pending — generation runs after validation completes.
          </div>
        )}

        {/* Phase 10 — D5: Pre-Approval Coaching. Rendered when the
            briefing produced any prompts; absent otherwise (no need to
            draw an empty panel). */}
        {props.briefingCard && props.briefingCard.coachingPrompts.length > 0 && (
          <CoachingPanel
            invoiceId={props.invoice.id}
            briefingCardId={props.briefingCard.id}
            prompts={props.briefingCard.coachingPrompts}
          />
        )}

        {/* ── Vendor snapshot (Phase 7 — D1) ──────────────────────── */}
        {props.vendorProfile ? (
          <div className="rounded-md border border-gray-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-700">Vendor snapshot</h2>
              <a
                href={`/vendors/${props.vendorProfile.id}`}
                className="text-xs text-gray-600 underline hover:text-gray-900"
              >
                Full profile →
              </a>
            </div>
            <p className="mb-2 text-sm font-medium text-gray-900">
              {props.vendorProfile.name}
            </p>

            {/* The spec's "3 data points": spend run-rate, duplicate
                history, terms status. */}
            <dl className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <dt className="text-gray-500">30d spend</dt>
                <dd className="mt-0.5 font-mono text-gray-900">
                  {props.vendorProfile.invoiceCount >= 3
                    ? props.vendorProfile.spend30d
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Duplicates</dt>
                <dd className="mt-0.5 font-mono text-gray-900">
                  {props.vendorProfile.duplicateSubmissionCount}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Terms</dt>
                <dd className="mt-0.5 text-gray-900">
                  {props.vendorProfile.defaultPaymentTerms ?? "—"}
                  {props.vendorProfile.termsDriftDetected && (
                    <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800">
                      drift
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            <div className="mt-3 border-t border-gray-100 pt-2 text-xs text-gray-600">
              <div>
                {props.vendorProfile.invoiceCount} invoice
                {props.vendorProfile.invoiceCount === 1 ? "" : "s"} on file
                {props.vendorProfile.lastInvoiceDate &&
                  ` · last ${props.vendorProfile.lastInvoiceDate}`}
              </div>
              {props.vendorMatch?.method && (
                <div className="mt-0.5 text-gray-500">
                  Match: <span className="font-mono">{props.vendorMatch.method}</span>
                  {props.vendorMatch.score && (
                    <>
                      {" · "}
                      <span className="font-mono">{props.vendorMatch.score}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : props.vendorMatch ? (
          // Unmatched / low-confidence — show candidates so the reviewer
          // can decide. Same shape as Phase 4 but explicitly labeled.
          <div className="rounded-md border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-medium text-gray-700">
              Vendor — no profile yet
            </h2>
            <p className="text-xs text-gray-700">
              Confidence:{" "}
              <span className="font-medium">{props.vendorMatch.confidence}</span>
              {props.vendorMatch.method && (
                <>
                  {" · method="}
                  <span className="font-mono">{props.vendorMatch.method}</span>
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
            <p className="mt-2 text-xs text-gray-500">
              A vendor record will be created automatically on approval.
            </p>
          </div>
        ) : null}

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

/**
 * Briefing Card panel — Phase 8 (D2 from updated MVP spec).
 *
 * Renders the LLM's structured review brief: GL coding rationale,
 * anomaly flags with severity pills, delta from the last invoice,
 * and a color-banded risk score with one-sentence justification.
 *
 * Risk band per spec §7.1: green 0–30, amber 31–60, red 61–100.
 */
function BriefingCardPanel({
  card,
}: {
  card: NonNullable<Props["briefingCard"]>;
}) {
  const band =
    card.riskScore <= 30 ? "green" : card.riskScore <= 60 ? "amber" : "red";
  const riskClasses = {
    green: "bg-green-50 text-green-900 border-green-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    red: "bg-red-50 text-red-900 border-red-200",
  }[band];

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-700">Briefing card</h2>
        <span className="text-xs text-gray-500">
          {card.generatedAt.slice(0, 16).replace("T", " ")}
        </span>
      </div>

      {/* Risk score with color band */}
      <div className={`mb-4 rounded-md border ${riskClasses} p-3`}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide">
            Risk score
          </span>
          <span className="text-2xl font-semibold tabular-nums">
            {card.riskScore}
            <span className="text-sm text-gray-500"> / 100</span>
          </span>
        </div>
        <p className="mt-1 text-xs leading-snug">{card.riskJustification}</p>
      </div>

      {/* GL coding suggestion */}
      <div className="mb-3">
        <p className="text-xs uppercase tracking-wide text-gray-500">GL coding</p>
        <p className="mt-1 text-sm font-medium text-gray-900">
          {card.glCode ?? (
            <em className="font-normal text-gray-400">No suggestion</em>
          )}
        </p>
        <p className="mt-1 text-xs leading-snug text-gray-700">
          {card.glRationale}
        </p>
      </div>

      {/* Anomaly flags */}
      <div className="mb-3">
        <p className="mb-1 text-xs uppercase tracking-wide text-gray-500">
          Anomaly flags
        </p>
        {card.anomalyFlags.length === 0 ? (
          <p className="text-xs text-gray-500">None.</p>
        ) : (
          <ul className="space-y-1">
            {card.anomalyFlags.map((f, i) => (
              <AnomalyFlagItem key={i} flag={f} />
            ))}
          </ul>
        )}
      </div>

      {/* Delta from last invoice */}
      {card.deltaSummary && (
        <div>
          <p className="mb-1 text-xs uppercase tracking-wide text-gray-500">
            Delta from last invoice
          </p>
          <p className="text-xs leading-snug text-gray-700">{card.deltaSummary}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Phase 9 — F07 evidence chain expander. Click the flag's severity chip
 * to expand the reasoning steps. Collapsed by default so the briefing
 * card stays at-a-glance scannable.
 */
function AnomalyFlagItem({
  flag,
}: {
  flag: {
    code: string;
    severity: "info" | "warning" | "critical";
    message: string;
    evidenceChain?: Array<{ label: string; detail: string }>;
  };
}) {
  const [open, setOpen] = useState(false);
  const severityClass = {
    info: "bg-gray-100 text-gray-800",
    warning: "bg-amber-100 text-amber-800",
    critical: "bg-red-100 text-red-800",
  }[flag.severity];
  const hasChain = Array.isArray(flag.evidenceChain) && flag.evidenceChain.length > 0;

  return (
    <li className="text-xs leading-snug">
      <button
        type="button"
        onClick={() => hasChain && setOpen((v) => !v)}
        className={`mr-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${severityClass} ${hasChain ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
        aria-expanded={hasChain ? open : undefined}
        aria-label={hasChain ? `${open ? "Hide" : "Show"} evidence for ${flag.code}` : undefined}
      >
        {flag.severity}
        {hasChain && <span className="ml-1">{open ? "▾" : "▸"}</span>}
      </button>
      {flag.message}
      {hasChain && open && (
        <ul className="ml-6 mt-1 space-y-0.5 text-[11px] text-gray-700">
          {flag.evidenceChain!.map((step, i) => (
            <li key={i} className="flex gap-1">
              <span className="font-medium text-gray-500">{step.label}:</span>
              <span>{step.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Phase 9 — F06: line-item confidence chip. Tooltip shows the reason
 * (number of prior samples, σ distance, etc.). Renders "—" when the
 * line wasn't scored.
 */
function LineConfidenceChip({
  score,
  reason,
}: {
  score: "high" | "medium" | "low" | "new" | null;
  reason: string | null;
}) {
  if (!score) return <span className="text-gray-400">—</span>;
  const palette = {
    high: "bg-emerald-100 text-emerald-800",
    medium: "bg-amber-100 text-amber-800",
    low: "bg-red-100 text-red-800",
    new: "bg-sky-100 text-sky-800",
  }[score];
  return (
    <span
      title={reason ?? undefined}
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${palette}`}
    >
      {score}
    </span>
  );
}

/**
 * Phase 10 — D5: Pre-Approval Coaching panel.
 *
 * Renders the deterministic coaching prompts the briefing job stored
 * on this card. Each prompt is dismissible — dismissal is session-only
 * at the UI layer (refresh restores them) but logs a coaching.prompt_
 * dismissed audit event so the compliance trail records every prompt
 * the approver chose to ignore.
 *
 * F03 — Behavioural nudges: messages are loss-framed by the compute
 * function. We don't reformat them here; the panel is a thin renderer.
 */
function CoachingPanel({
  invoiceId,
  briefingCardId,
  prompts,
}: {
  invoiceId: string;
  briefingCardId: string;
  prompts: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    message: string;
    dollarImpact?: number | null;
  }>;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const visible = prompts.filter((p) => !dismissed.has(p.code));

  async function dismiss(code: string) {
    // Optimistic — never block the UI on the audit log write.
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(code);
      return next;
    });
    try {
      await fetch(`/api/ap/review/${invoiceId}/coaching/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptCode: code, briefingCardId }),
      });
    } catch {
      // If the audit write fails, we still hide the prompt for the
      // session — the user has clearly indicated they don't want to
      // see it. The compliance gap (no log entry) is preferable to a
      // sticky prompt the reviewer can't dismiss.
    }
  }

  if (visible.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-200 bg-white p-3 text-xs text-gray-400">
        Coaching prompts dismissed.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-700">Coaching</h2>
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          {visible.length} prompt{visible.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-2">
        {visible.map((p) => {
          const severityClass = {
            info: "border-l-2 border-sky-400 bg-sky-50",
            warning: "border-l-2 border-amber-400 bg-amber-50",
            critical: "border-l-2 border-red-400 bg-red-50",
          }[p.severity];
          return (
            <li
              key={p.code}
              className={`flex items-start justify-between gap-2 rounded p-2 text-xs ${severityClass}`}
            >
              <div className="flex-1">
                <p className="leading-snug text-gray-900">{p.message}</p>
                {typeof p.dollarImpact === "number" && (
                  <p className="mt-0.5 text-[11px] text-gray-600">
                    Estimated impact:{" "}
                    <span className="font-mono">
                      {p.dollarImpact >= 0 ? "+" : "−"}$
                      {Math.abs(p.dollarImpact).toFixed(2)}
                    </span>
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(p.code)}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 hover:bg-gray-200 hover:text-gray-800"
                aria-label={`Dismiss ${p.code}`}
              >
                Dismiss
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
