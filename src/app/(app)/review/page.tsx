import Link from "next/link";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  documents,
  extractedInvoices,
  validationResults,
} from "@/db/schema";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import ApprovedExporter from "./ApprovedExporter";
import { QuickActions } from "./QuickActions";
import { decodeCursor, encodeCursor, splitPage } from "@/lib/pagination";

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

const PAGE_SIZE = 100;

interface ReviewCursor {
  receivedAt: string; // ISO
  id: string;
}

export default async function ReviewListPage({
  searchParams,
}: {
  searchParams: { status?: string; cursor?: string };
}) {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId } = session.user;

  const active: Status =
    (STATUS_TABS.find((t) => t.key === searchParams.status)?.key as Status) ??
    "needs_review";

  const cursor = decodeCursor<ReviewCursor>(searchParams.cursor);

  const statsRow = await withOrg(organizationId, async (tx) => {
    const result = await tx.execute<{
      needs_review: string;
      approved_total: string;
      low_confidence: string;
    }>(
      sql`
        select
          count(*) filter (where review_status in ('pending', 'needs_review')) as needs_review,
          count(*) filter (where review_status in ('approved', 'exported')) as approved_total,
          count(*) filter (
            where confidence::numeric < 0.75
              and review_status in ('pending', 'needs_review')
          ) as low_confidence
        from extracted_invoices
        where organization_id = ${organizationId}
      `,
    );
    return result.rows[0] ?? { needs_review: "0", approved_total: "0", low_confidence: "0" };
  });

  const { pageRows: rows, hasNext } = await withOrg(organizationId, async (tx) => {
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

    const statusFilter =
      active === "all"
        ? and(
            eq(extractedInvoices.organizationId, organizationId),
            inArray(extractedInvoices.reviewStatus, ACTIVE_REVIEW),
          )
        : and(
            eq(extractedInvoices.organizationId, organizationId),
            eq(extractedInvoices.reviewStatus, active),
          );

    // Cursor pagination: rows strictly after (cursor.receivedAt,
    // cursor.id) in the same (receivedAt DESC, id DESC) order as the
    // ORDER BY below. `id` is a stable tiebreaker for rows that share
    // the exact same receivedAt timestamp — without it, LIMIT-based
    // pagination can show duplicate or skipped rows across pages when
    // timestamps tie (uncommon but real: batch uploads land at
    // effectively the same instant).
    const cursorFilter = cursor
      ? or(
          lt(documents.receivedAt, new Date(cursor.receivedAt)),
          and(
            eq(documents.receivedAt, new Date(cursor.receivedAt)),
            lt(extractedInvoices.id, cursor.id),
          ),
        )
      : undefined;

    const where = cursorFilter ? and(statusFilter, cursorFilter) : statusFilter;

    const fetched = await tx
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
      .orderBy(desc(documents.receivedAt), desc(extractedInvoices.id))
      .limit(PAGE_SIZE + 1);

    return splitPage(fetched, PAGE_SIZE);
  });

  const needsReview = Number(statsRow.needs_review);
  const approvedTotal = Number(statsRow.approved_total);
  const lowConfidence = Number(statsRow.low_confidence);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Review queue</h1>
      </div>

      {/* Stats cards */}
      <div className="mb-5 grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3.5">
          <p className="text-xs text-gray-500">Pending review</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${needsReview > 0 ? "text-amber-600" : "text-gray-900"}`}>
            {needsReview}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3.5">
          <p className="text-xs text-gray-500">Approved (all time)</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-green-700">{approvedTotal}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3.5">
          <p className="text-xs text-gray-500">Low confidence (&lt;75%)</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${lowConfidence > 0 ? "text-red-600" : "text-gray-900"}`}>
            {lowConfidence}
          </p>
        </div>
      </div>

      <nav className="mb-4 flex gap-0.5 border-b border-gray-200 text-sm">
        {STATUS_TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <a
              key={t.key}
              href={`/review?status=${t.key}`}
              className={
                isActive
                  ? "border-b-2 border-green-700 px-3 py-2 font-medium text-green-800"
                  : "border-b-2 border-transparent px-3 py-2 text-gray-500 hover:text-gray-900"
              }
            >
              {t.label}
            </a>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-12 text-center text-gray-500">
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
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <th className="px-4 py-3 text-left">Vendor</th>
                <th className="px-4 py-3 text-left">Invoice #</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-left">Confidence</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Warnings</th>
                <th className="px-4 py-3 text-left">Received</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const warnings = Array.isArray(r.warnings)
                  ? (r.warnings as Array<{ severity: string }>)
                  : [];
                const blockingCount = warnings.filter((w) => w.severity === "blocking").length;
                const warningCount = warnings.length - blockingCount;
                const invoiceLabel = [
                  r.invoiceNumber ? ` ${r.invoiceNumber}` : "",
                  r.vendorName ? ` from ${r.vendorName}` : "",
                ].join("");

                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">
                        {r.vendorName ?? <em className="font-normal text-gray-400">Unknown</em>}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {r.invoiceNumber ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums text-gray-900">
                      {r.total
                        ? `${r.currency ? r.currency + " " : ""}${Number(r.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : <span className="font-normal text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <ConfidenceBar value={r.confidence} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <ReviewBadge status={r.reviewStatus} />
                        {/* Phase 11.2 — F02: override marker for Stop Work Authority approvals */}
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
                    <td className="px-4 py-3">
                      <WarningPills blocking={blockingCount} warning={warningCount} />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {r.receivedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <QuickActions
                        id={r.id}
                        invoiceLabel={invoiceLabel}
                        confidence={r.confidence}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasNext && rows.length > 0 && (
        <div className="mt-4 flex justify-end">
          <Link
            href={`/review?status=${active}&cursor=${encodeCursor({
              receivedAt: rows[rows.length - 1].receivedAt.toISOString(),
              id: rows[rows.length - 1].id,
            } satisfies ReviewCursor)}`}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Next page →
          </Link>
        </div>
      )}
    </div>
  );
}

function ReviewBadge({ status }: { status: string }) {
  const LABELS: Record<string, string> = {
    needs_review: "Needs review",
    pending: "Pending",
    approved: "Approved",
    exported: "Exported",
    rejected: "Rejected",
  };
  const color =
    status === "approved" || status === "exported"
      ? "bg-green-100 text-green-800"
      : status === "rejected"
        ? "bg-red-100 text-red-800"
        : status === "needs_review"
          ? "bg-amber-100 text-amber-800"
          : "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${color}`}>
      {LABELS[status] ?? status}
    </span>
  );
}

function ConfidenceBar({ value }: { value: string | null }) {
  if (!value) return <span className="text-xs text-gray-300">—</span>;
  const pct = Math.round(Number(value) * 100);
  const fillColor = pct >= 85 ? "bg-green-500" : pct >= 60 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-gray-200">
        <div className={`h-full rounded-full ${fillColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-gray-500">{pct}%</span>
    </div>
  );
}

function WarningPills({ blocking, warning }: { blocking: number; warning: number }) {
  if (blocking + warning === 0) {
    return <span className="text-xs text-gray-300">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1 text-[11px]">
      {blocking > 0 && (
        <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">
          {blocking} blocking
        </span>
      )}
      {warning > 0 && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700">
          {warning} warn
        </span>
      )}
    </div>
  );
}
