/**
 * Dashboard — client tiles (when ENABLE_MULTI_CLIENT is on) or org-level
 * quick-access tiles (solo mode) in the main body, pilot metrics below.
 */
import Link from "next/link";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { SpendSearch } from "./SpendSearch";
import {
  documents,
  extractedInvoices,
  exports as exportsTable,
  validationResults,
  clients,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { isMultiClientEnabled } from "@/lib/featureFlags";

interface ClientTileRow {
  id: string;
  name: string;
  slug: string;
  externalAccountingSystem: string | null;
  pendingDocs: number;
  pendingReview: number;
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId } = session.user;

  const multiClient = isMultiClientEnabled();

  // Per-client tile data — only fetched when the flag is on.
  const clientTiles: ClientTileRow[] = multiClient
    ? await withOrg(organizationId, async (tx) => {
        const rows = await tx.execute<{
          id: string;
          name: string;
          slug: string;
          external_accounting_system: string | null;
          pending_docs: string;
          pending_review: string;
        }>(
          sql`
            select
              c.id,
              c.name,
              c.slug,
              c.external_accounting_system,
              count(d.id) filter (
                where d.status in ('received','processing','text_extracted','review_required')
              ) as pending_docs,
              count(ei.id) filter (
                where ei.review_status in ('pending','needs_review')
              ) as pending_review
            from ${clients} c
            left join ${documents} d on d.client_id = c.id
            left join ${extractedInvoices} ei on ei.document_id = d.id
            where c.organization_id = ${organizationId}
            group by c.id, c.name, c.slug, c.external_accounting_system
            order by c.name
          `,
        );
        return rows.rows.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          externalAccountingSystem: r.external_accounting_system,
          pendingDocs: Number(r.pending_docs),
          pendingReview: Number(r.pending_review),
        }));
      })
    : [];

  const metrics = await withOrg(organizationId, async (tx) => {
    // PR4 — review #19: fire all six aggregates in parallel. They share
    // the withOrg transaction's serializable snapshot so the results
    // remain consistent (no torn-counts across the dashboard).
    // Local-dev impact is small (~6ms saved); on a non-local DB
    // deployment 5 round trips of 5–20ms each are eliminated.
    const [docs, dupes, confidence, exp] = await Promise.all([
      tx
        .select({
          total: sql<number>`count(*)::int`,
          uploaded: sql<number>`count(*) filter (where ${documents.source} = 'upload')::int`,
          email: sql<number>`count(*) filter (where ${documents.source} = 'email')::int`,
          textExtracted: sql<number>`count(*) filter (where ${documents.status} in ('text_extracted','llm_extracted','review_required','approved','exported'))::int`,
          reviewRequired: sql<number>`count(*) filter (where ${documents.status} = 'review_required')::int`,
          approved: sql<number>`count(*) filter (where ${documents.status} = 'approved')::int`,
          exported: sql<number>`count(*) filter (where ${documents.status} = 'exported')::int`,
          rejected: sql<number>`count(*) filter (where ${documents.status} = 'rejected')::int`,
          failed: sql<number>`count(*) filter (where ${documents.status} = 'failed')::int`,
        })
        .from(documents)
        .where(eq(documents.organizationId, organizationId))
        .then((rows) => rows[0]),

      tx
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(validationResults)
        .where(
          and(
            eq(validationResults.organizationId, organizationId),
            // PR2: validation_results is append-only — count only the
            // active row per invoice, not every superseded copy.
            sql`${validationResults.supersededAt} is null`,
            sql`${validationResults.errorsJson} @> '[{"code":"duplicate_invoice"}]'::jsonb`,
          ),
        )
        .then((rows) => rows[0]),

      tx
        .select({
          high: sql<number>`count(*) filter (where ${extractedInvoices.confidence} = 'high')::int`,
          medium: sql<number>`count(*) filter (where ${extractedInvoices.confidence} = 'medium')::int`,
          low: sql<number>`count(*) filter (where ${extractedInvoices.confidence} = 'low')::int`,
        })
        .from(extractedInvoices)
        .where(eq(extractedInvoices.organizationId, organizationId))
        .then((rows) => rows[0]),

      tx
        .select({
          total: sql<number>`count(*)::int`,
          completed: sql<number>`count(*) filter (where ${exportsTable.status} = 'completed')::int`,
          failed: sql<number>`count(*) filter (where ${exportsTable.status} = 'failed')::int`,
        })
        .from(exportsTable)
        .where(eq(exportsTable.organizationId, organizationId))
        .then((rows) => rows[0]),
    ]);

    return { docs, dupes, confidence, exp };
  });

  const pctReached =
    metrics.docs.total > 0
      ? Math.round((metrics.docs.textExtracted / metrics.docs.total) * 100)
      : 0;
  const exportSuccessRate =
    metrics.exp.total > 0
      ? Math.round((metrics.exp.completed / metrics.exp.total) * 100)
      : 0;

  const inProgressDocs =
    metrics.docs.total -
    metrics.docs.approved -
    metrics.docs.exported -
    metrics.docs.rejected -
    metrics.docs.failed;

  const totalPendingReview = multiClient
    ? clientTiles.reduce((sum, c) => sum + c.pendingReview, 0)
    : metrics.docs.reviewRequired;

  return (
    <div>
      <div className="mb-5">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
          {totalPendingReview > 0 && (
            <Link
              href="/review"
              className="text-sm font-medium text-amber-600 hover:text-amber-700"
            >
              {totalPendingReview} invoice{totalPendingReview !== 1 ? "s" : ""} awaiting review →
            </Link>
          )}
        </div>
        <p className="mt-0.5 text-xs text-gray-400">
          as of {new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
        </p>
      </div>

      {/* ── NL spend search ── */}
      <SpendSearch />

      {/* ── Client tiles (multi-client) or org quick-access (solo) ── */}
      {multiClient ? (
        clientTiles.length === 0 ? (
          <div className="mb-8 rounded-lg border border-dashed border-gray-200 bg-white p-10 text-center">
            <p className="text-sm text-gray-500">No clients yet.</p>
          </div>
        ) : (
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {clientTiles.map((c) => (
              <ClientTile key={c.id} client={c} />
            ))}
          </div>
        )
      ) : (
        /* Solo mode — two quick-access tiles for the main workflows */
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link
            href="/review"
            className="group flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-6 transition-shadow hover:shadow-md"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-500">Review queue</span>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-gray-400">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 5v3l2 1.5" />
              </svg>
            </div>
            <p className={`text-4xl font-semibold tabular-nums ${metrics.docs.reviewRequired > 0 ? "text-amber-600" : "text-gray-900"}`}>
              {metrics.docs.reviewRequired}
            </p>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">awaiting review</p>
              <span className="text-xs font-medium text-green-700">
                Open →
              </span>
            </div>
          </Link>

          <Link
            href="/inbox"
            className="group flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-6 transition-shadow hover:shadow-md"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-500">AP Inbox</span>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-gray-400">
                <path d="M1.5 4.5h13v8a1 1 0 01-1 1h-11a1 1 0 01-1-1v-8z" />
                <path d="M1.5 4.5l5.7 4.7a1.4 1.4 0 001.6 0l5.7-4.7" />
              </svg>
            </div>
            <p className="text-4xl font-semibold tabular-nums text-gray-900">{inProgressDocs}</p>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">documents in progress</p>
              <span className="text-xs font-medium text-green-700">
                Open →
              </span>
            </div>
          </Link>
        </div>
      )}

      {/* ── Pilot metrics (collapsed by default) ── */}
      <details className="mt-7 group/analytics">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-600">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 transition-transform group-open/analytics:rotate-90" aria-hidden="true">
            <path d="M4 2l4 4-4 4" />
          </svg>
          Analytics
        </summary>

        <Section title="Volume">
          <Card label="Uploaded" value={metrics.docs.uploaded} hint={`${metrics.docs.email} via email`} />
          <Card label="Extracted" value={metrics.docs.textExtracted} hint={`${pctReached}% of total`} />
          <Card label="Needs review" value={metrics.docs.reviewRequired} />
          <Card label="Approved" value={metrics.docs.approved + metrics.docs.exported} hint={`${metrics.docs.exported} exported`} />
        </Section>

        <Section title="Confidence &amp; quality">
          <Card label="High confidence" value={metrics.confidence.high} small />
          <Card label="Medium" value={metrics.confidence.medium} small />
          <Card label="Low" value={metrics.confidence.low} small />
          <Card label="Duplicates caught" value={metrics.dupes.count} small />
        </Section>

        <Section title="Exports">
          <Card label="Total" value={metrics.exp.total} small />
          <Card label="Completed" value={metrics.exp.completed} small />
          <Card label="Success rate" value={`${exportSuccessRate}%`} small />
          <Card label="Failed" value={metrics.exp.failed} small />
        </Section>
      </details>
    </div>
  );
}

function ClientTile({ client }: { client: ClientTileRow }) {
  const hasPending = client.pendingDocs > 0 || client.pendingReview > 0;
  return (
    <Link
      href={`/inbox?clientId=${client.id}`}
      className="group flex flex-col gap-4 rounded-xl border border-gray-200 bg-white p-6 transition-shadow hover:shadow-md"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-gray-900">{client.name}</p>
          {client.externalAccountingSystem && (
            <p className="mt-0.5 truncate text-xs text-gray-400">{client.externalAccountingSystem}</p>
          )}
        </div>
        <span
          className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
            hasPending
              ? "bg-amber-100 text-amber-700"
              : "bg-green-100 text-green-700"
          }`}
        >
          {hasPending ? "Needs attention" : "Up to date"}
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 border-t border-gray-100 pt-4">
        <div>
          <p className="text-xs text-gray-400">Needs review</p>
          <p className={`mt-0.5 text-2xl font-semibold tabular-nums ${client.pendingReview > 0 ? "text-amber-600" : "text-gray-900"}`}>
            {client.pendingReview}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400">In progress</p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums text-gray-900">
            {client.pendingDocs}
          </p>
        </div>
      </div>

      {/* CTA */}
      <p className="text-xs font-medium text-green-700">
        Open working session →
      </p>
    </Link>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <h2 className="mb-3 text-sm font-medium text-gray-500">
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {children}
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  hint,
  small,
}: {
  label: string;
  value: number | string;
  hint?: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3.5">
      <p className="text-xs text-gray-500">{label}</p>
      <p
        className={
          small
            ? "mt-1 text-xl font-semibold tabular-nums text-gray-900"
            : "mt-1 text-2xl font-semibold tabular-nums text-gray-900"
        }
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
