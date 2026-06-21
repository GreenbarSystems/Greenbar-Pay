import Link from "next/link";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  documents,
  extractedInvoices,
  validationResults,
} from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import ApprovedExporter from "./ApprovedExporter";

const STATUS_TABS = [
  { key: "needs_review", label: "Needs Review" },
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "exported", label: "Exported" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All Active" },
] as const;

type Status = (typeof STATUS_TABS)[number]["key"];

// Drizzle's inArray expects a mutable array; `as const` would type
// this as readonly and fail the overload check.
const ACTIVE_REVIEW: Array<"pending" | "needs_review"> = ["pending", "needs_review"];

export default async function ReviewListPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId } = session.user;

  const active: Status =
    (STATUS_TABS.find((t) => t.key === searchParams.status)?.key as Status) ??
    "needs_review";

  const rows = await withOrg(organizationId, async (tx) => {
    // Pull the active validation_results errors via a lateral subquery.
    // PR2: append-only — filter to superseded_at IS NULL for the live row.
    const latestValidation = sql`(
      select errors_json
      from validation_results vr
      where vr.entity_type = 'extracted_invoice'
        and vr.entity_id   = ${extractedInvoices.id}
        and vr.superseded_at is null
      order by vr.created_at desc
      limit 1
    )`;

    // Phase 11.2 — F02 override indicator. invoice_override_log is
    // append-only (DB-level RULE) so EXISTS is sufficient; no need to
    // join the row itself when the queue cell only renders a badge.
    // Index idx_override_log_invoice (org, invoice) makes this O(1).
    const isOverride = sql<boolean>`exists (
      select 1
      from invoice_override_log ol
      where ol.extracted_invoice_id = ${extractedInvoices.id}
    )`;

    const where =
      active === "all"
        ? and(
            eq(extractedInvoices.organizationId, organizationId),
            inArray(extractedInvoices.reviewStatus, ACTIVE_REVIEW),
          )
        : and(
            eq(extractedInvoices.organizationId, organizationId),
            eq(extractedInvoices.reviewStatus, active),
          );

    return tx
      .select({
        id: extractedInvoices.id,
        documentId: extractedInvoices.documentId,
        vendorName: extractedInvoices.vendorName,
        invoiceNumber: extractedInvoices.invoiceNumber,
        total: extractedInvoices.total,
        currency: extractedInvoices.currency,
        confidence: extractedInvoices.confidence,
        reviewStatus: extractedInvoices.reviewStatus,
        receivedAt: documents.receivedAt,
        warnings: sql<unknown[]>`coalesce(${latestValidation}, '[]'::jsonb)`,
        isOverride,
      })
      .from(extractedInvoices)
      .innerJoin(documents, eq(documents.id, extractedInvoices.documentId))
      .where(where)
      .orderBy(desc(documents.receivedAt))
      .limit(100);
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Review queue</h1>
      </div>

      <nav className="mb-4 flex gap-1 border-b border-gray-200 text-sm">
        {STATUS_TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <a
              key={t.key}
              href={`/review?status=${t.key}`}
              className={
                isActive
                  ? "border-b-2 border-gray-900 px-3 py-2 font-medium text-gray-900"
                  : "border-b-2 border-transparent px-3 py-2 text-gray-600 hover:text-gray-900"
              }
            >
              {t.label}
            </a>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 bg-white p-12 text-center text-gray-500">
          Nothing in this view.
        </div>
      ) : active === "approved" ? (
        <ApprovedExporter
          rows={rows.map((r) => ({
            id: r.id,
            vendorName: r.vendorName,
            invoiceNumber: r.invoiceNumber,
            total: r.total,
            currency: r.currency,
          }))}
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Vendor</th>
                <th className="px-4 py-2 text-left">Invoice #</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Warnings</th>
                <th className="px-4 py-2 text-left">Confidence</th>
                <th className="px-4 py-2 text-left">Received</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const warnings = Array.isArray(r.warnings)
                  ? (r.warnings as Array<{ severity: string }>)
                  : [];
                const blockingCount = warnings.filter(
                  (w) => w.severity === "blocking",
                ).length;
                const warningCount = warnings.length - blockingCount;
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2 font-medium text-gray-900">
                      {r.vendorName ?? <em className="text-gray-400">—</em>}
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {r.invoiceNumber ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900">
                      {r.total ? `${r.currency ?? ""} ${r.total}` : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <ReviewBadge status={r.reviewStatus} />
                        {/* Phase 11.2 — F02 override marker. Visible
                            on approved + exported rows that came in via
                            Stop Work Authority so an auditor scanning
                            the queue spots them without opening each. */}
                        {r.isOverride && (
                          <span
                            title="Approved via Stop Work Authority"
                            className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-800"
                          >
                            OVR
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <WarningPills
                        blocking={blockingCount}
                        warning={warningCount}
                      />
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {r.confidence ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {r.receivedAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/review/${r.id}`}
                        className="text-sm text-gray-700 underline hover:text-gray-900"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReviewBadge({ status }: { status: string }) {
  const color =
    status === "approved" || status === "exported"
      ? "bg-green-100 text-green-800"
      : status === "rejected"
        ? "bg-red-100 text-red-800"
        : status === "needs_review"
          ? "bg-amber-100 text-amber-800"
          : "bg-gray-100 text-gray-700";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  );
}

function WarningPills({ blocking, warning }: { blocking: number; warning: number }) {
  if (blocking + warning === 0) {
    return <span className="text-gray-400">—</span>;
  }
  return (
    <div className="flex gap-1 text-xs">
      {blocking > 0 && (
        <span className="rounded bg-red-100 px-2 py-0.5 font-medium text-red-800">
          {blocking} blocking
        </span>
      )}
      {warning > 0 && (
        <span className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
          {warning} warn
        </span>
      )}
    </div>
  );
}
