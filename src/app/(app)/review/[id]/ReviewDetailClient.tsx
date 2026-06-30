"use client";

/**
 * Side-by-side review UI.
 *
 * - File preview via signed S3/MinIO URL
 *     · PDF → react-pdf (Phase 11.1), inline render with page nav + zoom
 *     · image → <img>
 * - Editable header fields. PATCH includes `If-Match: <updated_at>` so
 *   §4.7 concurrency rejects stale edits with a 409.
 * - Approve / reject use `Idempotency-Key` (§4.6).
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { UserRole } from "@/lib/rbac";
import { can } from "@/lib/rbac";

// Phase 11.1 — react-pdf touches window/document at import time. Lazy-
// load with ssr: false so the SSR pass doesn't pull pdfjs-dist into the
// server bundle. The fallback while the chunk loads matches the same
// loading state the viewer renders for the document itself, so the
// transition is invisible.
const PdfViewer = dynamic(() => import("./PdfViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[78vh] items-center justify-center rounded border border-gray-200 bg-gray-50 text-xs text-gray-500">
      Loading viewer…
    </div>
  ),
});

/**
 * Phase 11.2 — F02 Stop Work Authority canonical reject reasons. Must
 * stay in lock-step with src/app/api/ap/review/[id]/reject/route.ts's
 * RejectReasonCode enum.
 */
const REJECT_REASONS: Array<{ code: string; label: string }> = [
  { code: "not_an_invoice", label: "Not an invoice" },
  { code: "duplicate_submission", label: "Duplicate submission" },
  { code: "wrong_vendor", label: "Wrong vendor" },
  { code: "wrong_amount", label: "Wrong amount" },
  { code: "missing_information", label: "Missing information" },
  { code: "policy_violation", label: "Policy violation" },
  { code: "other", label: "Other" },
];

const OVERRIDE_MIN_JUSTIFICATION = 20;

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

interface OverrideMetadata {
  approvedAt: string;
  blockingFindingCodes: string[];
  secondApprover: string | null;
}

interface Props {
  role: UserRole;
  /**
   * Phase 11.2 — F02 server-resolved permission. Composed against the
   * invoice's clientId via loadEffectiveRole, so per-client elevations
   * compose correctly. The client never sees the underlying role —
   * only the boolean — so a DevTools tamper can't elevate.
   */
  canOverride: boolean;
  /** Phase 11.2 — when this invoice was approved via override, the
   *  metadata surfaces the override badge + tooltip. Null otherwise. */
  override: OverrideMetadata | null;
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
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  const isTerminal = ["approved", "rejected", "exported"].includes(form.reviewStatus);

  // Phase 11.2 — F02 gate. blocking findings drive the banner + button
  // swap. The approve route enforces the same gate, so a tampered DOM
  // posting a clean approve when blocking findings exist will still
  // 422 — but the UI nudges the legitimate path.
  const blockingFindings = props.findings.filter(
    (f) => f.severity === "blocking",
  );
  const hasBlockingFindings = blockingFindings.length > 0;

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

  async function handleApprove(overridePayload?: {
    overrideJustification: string;
    secondApproverId: string | null;
  }) {
    if (!canApprove || isTerminal) return;
    // Phase 11.2 — clean-path approve cannot fire while blocking
    // findings are present; the route would 422 anyway. The check here
    // prevents a misclick when the override modal is closed.
    if (hasBlockingFindings && !overridePayload) return;
    setError(null);
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: overridePayload
        ? JSON.stringify({
            overrideJustification: overridePayload.overrideJustification,
            secondApproverId: overridePayload.secondApproverId ?? undefined,
          })
        : "{}",
    };
    const res = await fetch(`/api/ap/review/${form.id}/approve`, init);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.message ?? j.error ?? `HTTP ${res.status}`);
      return;
    }
    setOverrideOpen(false);
    router.refresh();
  }

  async function handleReject(payload: { reasonCode: string; note?: string }) {
    if (!canReject || isTerminal) return;
    setError(null);
    const res = await fetch(`/api/ap/review/${form.id}/reject`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.message ?? j.error ?? `HTTP ${res.status}`);
      return;
    }
    setRejectOpen(false);
    router.refresh();
  }

  return (
    <>
    {/* Phase 11.2 — F02 modals live as siblings to the grid so the
        backdrop covers the full viewport. State + handlers are owned
        by the parent so the modal is a controlled component. */}
    {overrideOpen && (
      <OverrideModal
        invoiceId={form.id}
        blockingFindings={blockingFindings}
        onCancel={() => setOverrideOpen(false)}
        onSubmit={(payload) => handleApprove(payload)}
      />
    )}
    {rejectOpen && (
      <RejectModal
        onCancel={() => setRejectOpen(false)}
        onSubmit={(payload) => handleReject(payload)}
      />
    )}
    {/* Phase 8 — spec §7.2: Source 40% / Extracted 30% / Briefing+Coaching 30%.
        minmax(0, …) prevents long line-item descriptions from blowing out
        the column widths. */}
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
          // Phase 11.1 — inline PDF render via react-pdf. The viewer
          // falls back to a plain <iframe> internally if PDF.js can't
          // load the file (corrupt PDF, CSP block, network error) so
          // reviewers are never stuck with a blank panel.
          <PdfViewer
            fileUrl={props.fileUrl}
            fallbackUrl={props.fileUrl}
            onRefreshUrl={async () => {
              // Re-issue a 120s signed URL without a full page reload —
              // a navigation would discard unsaved form edits. Returns
              // null on auth/RBAC/404/network failure so PdfViewer
              // falls back to the iframe path.
              try {
                const res = await fetch(
                  `/api/ap/review/${props.invoice.id}/file-url`,
                  { cache: "no-store" },
                );
                if (!res.ok) return null;
                const data = (await res.json()) as { url?: string };
                return data.url ?? null;
              } catch {
                return null;
              }
            }}
          />
        )}
      </div>

      {/* ── Column 2: Extracted fields + actions + lines + findings ── */}
      <div className="space-y-4">
        <div className="rounded-md border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-700">Extracted fields</h2>
            <div className="flex items-center gap-2">
              {/* Phase 11 — D4: Audit-ready evidence packet download.
                  Surfaces once the invoice is in a terminal post-review
                  state. The assemble job runs async, so a fresh approval
                  may show the link before the packet is sealed — the GET
                  endpoint returns 404 with a "not_ready" body in that
                  window. */}
              {(form.reviewStatus === "approved" ||
                form.reviewStatus === "exported") && (
                <a
                  href={`/api/ap/exports/evidence/${props.invoice.id}`}
                  className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                  title="Download the audit-ready evidence packet"
                >
                  Evidence packet
                </a>
              )}
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs uppercase tracking-wide text-gray-700">
                {form.reviewStatus}
              </span>
              {/* Phase 11.2 — F02 override badge. Surfaced once an
                  override row exists for this invoice. The tooltip
                  carries the second-approver name and waived finding
                  codes; click target is the badge itself so an auditor
                  reading the page can spot the override at a glance. */}
              {props.override && (
                <span
                  title={
                    `Approved via Stop Work Authority on ${props.override.approvedAt.slice(0, 16).replace("T", " ")}` +
                    (props.override.secondApprover
                      ? ` · co-approver: ${props.override.secondApprover}`
                      : "") +
                    (props.override.blockingFindingCodes.length > 0
                      ? ` · waived: ${props.override.blockingFindingCodes.join(", ")}`
                      : "")
                  }
                  className="rounded border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-red-800"
                >
                  Override
                </span>
              )}
            </div>
          </div>

          {/* Phase 11.2 — F02 Override Required banner. Visible only
              while the invoice is still in a reviewable state AND
              blocking findings remain. Once approved (override or
              clean) the banner is suppressed — the override badge by
              the status pill carries that signal post-fact. */}
          {hasBlockingFindings && !isTerminal && (
            <OverrideBanner
              canOverride={props.canOverride}
              canApprove={canApprove}
              blockingCodes={blockingFindings.map((f) => f.code)}
              onOpen={() => setOverrideOpen(true)}
            />
          )}

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
            {/* Phase 11.2 — Three approve paths:
                  · no blocking findings → green Approve (existing)
                  · blocking + canOverride → red Override & Approve
                  · blocking + !canOverride → disabled hint
                The gate is enforced server-side in the approve route;
                the UI just mirrors it so the reviewer isn't lured into
                a guaranteed 422. */}
            {hasBlockingFindings ? (
              props.canOverride ? (
                <button
                  onClick={() => setOverrideOpen(true)}
                  disabled={!canApprove || isTerminal}
                  className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:bg-gray-400"
                  title="Approve despite blocking validation findings (Stop Work Authority)"
                >
                  Override & approve
                </button>
              ) : (
                <button
                  disabled
                  className="rounded-md border border-gray-300 bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-500"
                  title="An admin or owner must approve this invoice via Stop Work Authority."
                >
                  Awaiting admin override
                </button>
              )
            ) : (
              <button
                onClick={() => handleApprove()}
                disabled={!canApprove || isTerminal}
                className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800 disabled:bg-gray-400"
              >
                Approve
              </button>
            )}
            <button
              onClick={() => setRejectOpen(true)}
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
        {/* PR16 M3 — coaching is an approver nudge; viewer/clerk roles
            with invoice.read have no action to take so showing them
            financial-impact figures (and the dismiss action that fires
            an audit event under their id) is information overshare.
            Analogous to PR11 H7's confidenceReason gate. */}
        {canApprove &&
          props.briefingCard &&
          props.briefingCard.coachingPrompts.length > 0 && (
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
            {props.audits.map((a) => {
              // Phase 11.2 — surface override + denial events distinctly.
              // The action name is the source of truth (auditor reads it
              // verbatim); the row tint just helps them spot it.
              const isOverride =
                a.action === "invoice.override_recorded" ||
                a.action === "invoice.override";
              const isDenial = a.action === "invoice.sod_denied";
              const rowClass = isOverride
                ? "rounded bg-red-50 px-1.5 py-0.5 text-red-900"
                : isDenial
                  ? "rounded bg-amber-50 px-1.5 py-0.5 text-amber-900"
                  : "";
              return (
                <li key={a.id} className={`flex justify-between ${rowClass}`}>
                  <span>
                    <span className="font-mono font-medium">{a.action}</span>{" "}
                    by {a.actorType}
                  </span>
                  <span className="text-gray-500">
                    {a.createdAt.slice(0, 16).replace("T", " ")}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      </div>
    </div>
    </>
  );
}

/**
 * Phase 11.2 — F02 Stop Work Authority banner.
 *
 * Rendered at the top of the extracted-fields panel when blocking
 * validation findings remain on a non-terminal invoice. The copy
 * branches on canOverride: when the caller is admin/owner, we tell
 * them they're the one who has to make the call; otherwise we tell
 * them to escalate. The action button is the only path to the
 * override modal — the regular Approve button is suppressed by the
 * gate logic in the parent.
 */
function OverrideBanner({
  canOverride,
  canApprove,
  blockingCodes,
  onOpen,
}: {
  canOverride: boolean;
  canApprove: boolean;
  blockingCodes: string[];
  onOpen: () => void;
}) {
  return (
    <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-sm font-semibold text-red-900">
            Override required — blocking validation findings
          </p>
          <p className="mt-1 text-xs leading-snug text-red-900">
            This invoice has {blockingCodes.length} blocking finding
            {blockingCodes.length === 1 ? "" : "s"} (
            <span className="font-mono">{blockingCodes.join(", ")}</span>).
            {canOverride
              ? " Resolve via Save edits, or exercise Stop Work Authority to approve despite the gate."
              : " Resolve via Save edits, or escalate to an admin/owner who can exercise Stop Work Authority."}
          </p>
        </div>
        {canOverride && canApprove && (
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 rounded-md border border-red-700 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
          >
            Open override
          </button>
        )}
      </div>
    </div>
  );
}

interface ApproverOption {
  id: string;
  name: string | null;
  email: string;
  role: string;
}

/**
 * Phase 11.2 — F02 Override modal.
 *
 * Two-step flow:
 *   1. Edit — write justification (≥20 chars enforced client-side AND
 *      server-side), optionally pick a second approver from the
 *      org's admin+owner roster.
 *   2. Confirm — read-only preview of the blocking findings + the
 *      justification + the second approver. The submit button is in
 *      step 2 only; step 1 cannot accidentally fire the approve.
 *
 * The approvers list is fetched once on mount. Failure is non-fatal:
 * the picker collapses to a "(unavailable — proceed without)" hint;
 * the modal still works with no second approver, which matches the
 * F02 spec (recommended, not required, in the MVP).
 */
function OverrideModal({
  invoiceId,
  blockingFindings,
  onCancel,
  onSubmit,
}: {
  invoiceId: string;
  blockingFindings: Finding[];
  onCancel: () => void;
  onSubmit: (payload: {
    overrideJustification: string;
    secondApproverId: string | null;
  }) => void | Promise<void>;
}) {
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [justification, setJustification] = useState("");
  const [secondApproverId, setSecondApproverId] = useState<string>("");
  const [approvers, setApprovers] = useState<ApproverOption[] | null>(null);
  const [approversError, setApproversError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ap/users/approvers");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { approvers: ApproverOption[] };
        if (!cancelled) setApprovers(j.approvers ?? []);
      } catch {
        if (!cancelled) setApproversError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = justification.trim();
  const tooShort = trimmed.length < OVERRIDE_MIN_JUSTIFICATION;
  const selectedApprover = approvers?.find((a) => a.id === secondApproverId) ?? null;

  async function doSubmit() {
    if (tooShort || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        overrideJustification: trimmed,
        secondApproverId: secondApproverId || null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Stop Work Authority override"
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Stop Work Authority override
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Invoice <span className="font-mono">{invoiceId.slice(0, 8)}…</span>{" "}
              · Step {step === "edit" ? "1" : "2"} of 2
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            aria-label="Close override modal"
          >
            ✕
          </button>
        </div>

        {/* Blocking findings — read-only in both steps so the approver
            is never far from what they're waiving. */}
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-900">
            Waiving {blockingFindings.length} blocking finding
            {blockingFindings.length === 1 ? "" : "s"}
          </p>
          <ul className="space-y-0.5 text-xs text-red-900">
            {blockingFindings.map((f) => (
              <li key={f.code}>
                <span className="font-mono">{f.code}</span> — {f.message}
              </li>
            ))}
          </ul>
        </div>

        {step === "edit" ? (
          <>
            <label className="block text-xs font-medium text-gray-700">
              Justification
              <textarea
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                rows={4}
                placeholder="Explain why this invoice should be approved despite the blocking findings. Minimum 20 characters."
                className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-900 focus:outline-none"
              />
            </label>
            <div className="mt-1 flex items-center justify-between text-[11px]">
              <span className={tooShort ? "text-red-700" : "text-gray-500"}>
                {tooShort
                  ? `${OVERRIDE_MIN_JUSTIFICATION - trimmed.length} more character${OVERRIDE_MIN_JUSTIFICATION - trimmed.length === 1 ? "" : "s"} required`
                  : "Justification persisted to invoice_override_log (append-only)."}
              </span>
              <span className="font-mono text-gray-400">
                {trimmed.length}/{OVERRIDE_MIN_JUSTIFICATION}+
              </span>
            </div>

            <label className="mt-3 block text-xs font-medium text-gray-700">
              Second approver{" "}
              <span className="font-normal text-gray-500">
                (recommended — admin or owner)
              </span>
              {approversError ? (
                <p className="mt-1 text-[11px] italic text-gray-500">
                  Approver list unavailable — proceeding without a second
                  approver is permitted in the MVP.
                </p>
              ) : approvers === null ? (
                <p className="mt-1 text-[11px] italic text-gray-500">
                  Loading approvers…
                </p>
              ) : (
                <select
                  value={secondApproverId}
                  onChange={(e) => setSecondApproverId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-900 focus:outline-none"
                >
                  <option value="">— None —</option>
                  {approvers.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name ?? a.email} ({a.role})
                    </option>
                  ))}
                </select>
              )}
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setStep("confirm")}
                disabled={tooShort}
                className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-400"
              >
                Review →
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-3 text-xs">
              <div>
                <p className="font-semibold uppercase tracking-wide text-gray-500">
                  Justification
                </p>
                <p className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 text-sm text-gray-900">
                  {trimmed}
                </p>
              </div>
              <div>
                <p className="font-semibold uppercase tracking-wide text-gray-500">
                  Second approver
                </p>
                <p className="mt-1 text-sm text-gray-900">
                  {selectedApprover
                    ? `${selectedApprover.name ?? selectedApprover.email} (${selectedApprover.role})`
                    : "— None —"}
                </p>
              </div>
              <p className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] leading-snug text-amber-900">
                This action records an immutable row in{" "}
                <span className="font-mono">invoice_override_log</span> and
                emits an <span className="font-mono">invoice.override_recorded</span>{" "}
                audit event. Both are append-only.
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStep("edit")}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                ← Edit
              </button>
              <button
                type="button"
                onClick={doSubmit}
                disabled={submitting}
                className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:bg-gray-400"
              >
                {submitting ? "Submitting…" : "Override & approve"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Phase 11.2 — Reject modal. Replaces the prior window.prompt path
 * with a reasonCode picker (matching the PR19 enum) and an optional
 * free-text note. The note is NOT persisted on audit_events (per
 * PR19); the route stores it on the invoice's warningsJson only.
 */
function RejectModal({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (payload: { reasonCode: string; note?: string }) => void | Promise<void>;
}) {
  const [reasonCode, setReasonCode] = useState(REJECT_REASONS[0].code);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function doSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        reasonCode,
        note: note.trim() ? note.trim().slice(0, 280) : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Reject invoice"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            Reject invoice
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            aria-label="Close reject modal"
          >
            ✕
          </button>
        </div>

        <label className="block text-xs font-medium text-gray-700">
          Reason
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-900 focus:outline-none"
          >
            {REJECT_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 block text-xs font-medium text-gray-700">
          Note <span className="font-normal text-gray-500">(optional, max 280)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={280}
            placeholder="Optional context for your team. NOT written to the audit log."
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-900 focus:outline-none"
          />
          <span className="mt-0.5 block text-right font-mono text-[10px] text-gray-400">
            {note.length}/280
          </span>
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doSubmit}
            disabled={submitting}
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:bg-gray-400"
          >
            {submitting ? "Submitting…" : "Reject"}
          </button>
        </div>
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
