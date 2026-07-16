import Link from "next/link";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { documents, documentExtractions, extractedInvoices } from "@/db/schema";
import { desc, eq, and, sql } from "drizzle-orm";

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "received", label: "Received" },
  { key: "processing", label: "Processing" },
  { key: "text_extracted", label: "Text Extracted" },
  { key: "review_required", label: "Needs Review" },
  { key: "approved", label: "Approved" },
  { key: "exported", label: "Exported" },
  { key: "rejected", label: "Rejected" },
] as const;

type Status = (typeof STATUS_TABS)[number]["key"];

export default async function InboxPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId } = session.user;

  const active: Status =
    (STATUS_TABS.find((t) => t.key === searchParams.status)?.key as Status) ?? "all";

  const rows = await withOrg(organizationId, async (tx) => {
    // Latest-extraction lateral join (§4.1 append-only readers pattern).
    // Lateral keeps it to one row per document even when retries pile up.
    const latestExtraction = sql`(
      select method, text_length, quality_score
      from document_extractions de
      where de.document_id = ${documents.id}
      order by de.created_at desc
      limit 1
    )`;

    // Latest extracted_invoice id for this document, used to link the
    // inbox row directly to /review/[id] once extraction has completed.
    // NULL for documents still in early pipeline stages (received /
    // processing / text_extracted) that have no extracted invoice yet.
    const latestExtractedInvoiceId = sql<string | null>`(
      select id
      from extracted_invoices ei
      where ei.document_id = ${documents.id}
      order by ei.created_at desc
      limit 1
    )`;

    const latestVendorName = sql<string | null>`(
      select vendor_name
      from extracted_invoices ei
      where ei.document_id = ${documents.id}
      order by ei.created_at desc
      limit 1
    )`;

    const latestTotal = sql<string | null>`(
      select total
      from extracted_invoices ei
      where ei.document_id = ${documents.id}
      order by ei.created_at desc
      limit 1
    )`;

    const latestCurrency = sql<string | null>`(
      select currency
      from extracted_invoices ei
      where ei.document_id = ${documents.id}
      order by ei.created_at desc
      limit 1
    )`;

    return tx
      .select({
        id: documents.id,
        filename: documents.originalFilename,
        status: documents.status,
        source: documents.source,
        receivedAt: documents.receivedAt,
        extractionMethod: sql<string | null>`(${latestExtraction}).method`,
        textLength: sql<number | null>`(${latestExtraction}).text_length`,
        qualityScore: sql<string | null>`(${latestExtraction}).quality_score`,
        extractedInvoiceId: latestExtractedInvoiceId,
        vendorName: latestVendorName,
        total: latestTotal,
        currency: latestCurrency,
      })
      .from(documents)
      .where(
        active === "all"
          ? eq(documents.organizationId, organizationId)
          : and(
              eq(documents.organizationId, organizationId),
              eq(documents.status, active),
            ),
      )
      .orderBy(desc(documents.receivedAt))
      .limit(100);
  });

  const now = new Date();

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">AP Inbox</h1>
        <Link
          href="/upload"
          className="flex items-center gap-1.5 rounded-md bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800"
        >
          <svg viewBox="0 0 14 14" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
            <path d="M7 1v8M4.5 3.5L7 1l2.5 2.5" />
            <path d="M1.5 10.5v1a1 1 0 001 1h9a1 1 0 001-1v-1" />
          </svg>
          Upload invoice
        </Link>
      </div>

      <nav className="mb-4 flex gap-0.5 border-b border-gray-200 text-sm">
        {STATUS_TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <a
              key={t.key}
              href={`/inbox?status=${t.key}`}
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
          No documents yet.{" "}
          <Link href="/upload" className="text-green-700 underline hover:text-green-800">
            Upload an invoice
          </Link>{" "}
          to get started.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          {/* Column headers */}
          <div className="grid grid-cols-[20px_1fr_160px_110px_100px_90px_60px] items-center gap-x-4 border-b border-gray-100 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <div />
            <div>Document</div>
            <div>Vendor</div>
            <div>Amount</div>
            <div>Received</div>
            <div>Status</div>
            <div />
          </div>

          <div className="divide-y divide-gray-100">
            {rows.map((r) => {
              const isPending =
                r.status === "received" ||
                r.status === "processing" ||
                r.status === "text_extracted" ||
                r.status === "review_required";
              const ageDiffMs = now.getTime() - r.receivedAt.getTime();
              const ageHours = ageDiffMs / (1000 * 60 * 60);
              const isRecent = ageHours < 24;
              const showDot = isPending && isRecent;

              let receivedLabel: string;
              if (ageHours < 1) {
                receivedLabel = `${Math.max(1, Math.round(ageDiffMs / 60000))}m ago`;
              } else if (ageHours < 24) {
                receivedLabel = `${Math.floor(ageHours)}h ago`;
              } else if (ageHours < 48) {
                receivedLabel = "Yesterday";
              } else {
                receivedLabel = r.receivedAt.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                });
              }

              const amountDisplay =
                r.total
                  ? `${r.currency ?? ""}${r.currency ? " " : ""}${Number(r.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : null;

              return (
                <div
                  key={r.id}
                  className={`grid grid-cols-[20px_1fr_160px_110px_100px_90px_60px] items-center gap-x-4 px-4 py-3 hover:bg-gray-50 ${isPending && isRecent ? "bg-white" : ""}`}
                >
                  {/* Unread dot */}
                  <div className="flex items-center justify-center">
                    {showDot && (
                      <span className="block h-1.5 w-1.5 rounded-full bg-green-600" aria-label="New" />
                    )}
                  </div>

                  {/* Document / subject */}
                  <div className="min-w-0">
                    <p className={`truncate text-sm ${showDot ? "font-semibold text-gray-900" : "font-medium text-gray-700"}`}>
                      {r.filename}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-400 capitalize">{r.source}</p>
                  </div>

                  {/* Vendor */}
                  <div className="truncate text-sm text-gray-600">
                    {r.vendorName ?? <span className="text-gray-300">—</span>}
                  </div>

                  {/* Amount */}
                  <div className="text-sm font-medium tabular-nums text-gray-900">
                    {amountDisplay ?? <span className="font-normal text-gray-300">—</span>}
                  </div>

                  {/* Received */}
                  <div className="text-xs text-gray-400">{receivedLabel}</div>

                  {/* Status */}
                  <div>
                    <StatusBadge status={r.status} />
                  </div>

                  {/* Action */}
                  <div className="text-right">
                    {r.extractedInvoiceId ? (
                      <Link
                        href={`/review/${r.extractedInvoiceId}`}
                        aria-label={`Open review for ${r.filename}`}
                        className="text-xs font-medium text-green-700 hover:text-green-900"
                      >
                        Open
                      </Link>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const LABELS: Record<string, string> = {
    received: "Received",
    processing: "Processing",
    text_extracted: "Extracting",
    llm_extracted: "Extracting",
    review_required: "Needs review",
    validation_failed: "Needs review",
    approved: "Approved",
    exported: "Exported",
    rejected: "Rejected",
    failed: "Failed",
  };
  const color =
    status === "approved" || status === "exported"
      ? "bg-green-100 text-green-800"
      : status === "rejected" || status === "failed"
        ? "bg-red-100 text-red-800"
        : status === "review_required" || status === "validation_failed"
          ? "bg-amber-100 text-amber-800"
          : status === "text_extracted" || status === "llm_extracted" || status === "processing"
            ? "bg-purple-100 text-purple-800"
            : "bg-gray-100 text-gray-500";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${color}`}>
      {LABELS[status] ?? status}
    </span>
  );
}
