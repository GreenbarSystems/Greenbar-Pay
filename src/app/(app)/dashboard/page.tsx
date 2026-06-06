/**
 * Pilot metrics dashboard (PRD §"Pilot Metrics").
 *
 * Each card runs a single aggregate query through withOrg so RLS does the
 * tenant scoping. Numbers are all-time within this org; a date-range
 * picker is a follow-up.
 */
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import {
  documents,
  extractedInvoices,
  documentExtractions,
  llmRuns,
  exports as exportsTable,
  validationResults,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId } = session.user;

  const metrics = await withOrg(organizationId, async (tx) => {
    const [docs] = await tx
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
      .where(eq(documents.organizationId, organizationId));

    const [extractions] = await tx
      .select({
        nativePdf: sql<number>`count(*) filter (where ${documentExtractions.method} = 'native_pdf')::int`,
        tesseractImage: sql<number>`count(*) filter (where ${documentExtractions.method} = 'tesseract_image')::int`,
        tesseractPdf: sql<number>`count(*) filter (where ${documentExtractions.method} = 'tesseract_pdf')::int`,
        avgQuality: sql<string | null>`round(avg(${documentExtractions.qualityScore})::numeric, 3)::text`,
      })
      .from(documentExtractions)
      .where(eq(documentExtractions.organizationId, organizationId));

    const [llm] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where ${llmRuns.status} = 'succeeded')::int`,
        schemaFailed: sql<number>`count(*) filter (where ${llmRuns.status} = 'schema_failed')::int`,
        providerError: sql<number>`count(*) filter (where ${llmRuns.status} = 'provider_error')::int`,
        textTooLarge: sql<number>`count(*) filter (where ${llmRuns.status} = 'text_too_large')::int`,
        circuitOpen: sql<number>`count(*) filter (where ${llmRuns.status} = 'circuit_open')::int`,
      })
      .from(llmRuns)
      .where(eq(llmRuns.organizationId, organizationId));

    const [dupes] = await tx
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(validationResults)
      .where(
        and(
          eq(validationResults.organizationId, organizationId),
          sql`${validationResults.errorsJson} @> '[{"code":"duplicate_invoice"}]'::jsonb`,
        ),
      );

    const [confidence] = await tx
      .select({
        high: sql<number>`count(*) filter (where ${extractedInvoices.confidence} = 'high')::int`,
        medium: sql<number>`count(*) filter (where ${extractedInvoices.confidence} = 'medium')::int`,
        low: sql<number>`count(*) filter (where ${extractedInvoices.confidence} = 'low')::int`,
      })
      .from(extractedInvoices)
      .where(eq(extractedInvoices.organizationId, organizationId));

    const [exp] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) filter (where ${exportsTable.status} = 'completed')::int`,
        failed: sql<number>`count(*) filter (where ${exportsTable.status} = 'failed')::int`,
      })
      .from(exportsTable)
      .where(eq(exportsTable.organizationId, organizationId));

    return { docs, extractions, llm, dupes, confidence, exp };
  });

  const pctReached =
    metrics.docs.total > 0
      ? Math.round((metrics.docs.textExtracted / metrics.docs.total) * 100)
      : 0;
  const llmSuccessRate =
    metrics.llm.total > 0
      ? Math.round((metrics.llm.succeeded / metrics.llm.total) * 100)
      : 0;
  const exportSuccessRate =
    metrics.exp.total > 0
      ? Math.round((metrics.exp.completed / metrics.exp.total) * 100)
      : 0;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Pilot dashboard</h1>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card label="Documents uploaded" value={metrics.docs.uploaded} hint={`${metrics.docs.email} via email`} />
        <Card
          label="Reached extraction"
          value={`${metrics.docs.textExtracted}`}
          hint={`${pctReached}% of total`}
        />
        <Card
          label="Awaiting review"
          value={metrics.docs.reviewRequired}
          hint="status = review_required"
        />
        <Card
          label="Approved"
          value={metrics.docs.approved + metrics.docs.exported}
          hint={`${metrics.docs.exported} exported`}
        />
      </div>

      <Section title="Extraction methods">
        <Card label="native_pdf" value={metrics.extractions.nativePdf} small />
        <Card label="tesseract_image" value={metrics.extractions.tesseractImage} small />
        <Card label="tesseract_pdf" value={metrics.extractions.tesseractPdf} small />
        <Card label="Avg quality score" value={metrics.extractions.avgQuality ?? "—"} small />
      </Section>

      <Section title="LLM gateway">
        <Card label="Total runs" value={metrics.llm.total} small />
        <Card label="Success rate" value={`${llmSuccessRate}%`} small />
        <Card label="Schema failed" value={metrics.llm.schemaFailed} small />
        <Card label="Provider errors" value={metrics.llm.providerError} small />
        <Card label="text_too_large" value={metrics.llm.textTooLarge} small />
        <Card label="circuit_open" value={metrics.llm.circuitOpen} small />
      </Section>

      <Section title="Extraction confidence">
        <Card label="high" value={metrics.confidence.high} small />
        <Card label="medium" value={metrics.confidence.medium} small />
        <Card label="low" value={metrics.confidence.low} small />
        <Card label="Duplicates caught" value={metrics.dupes.count} small />
      </Section>

      <Section title="Exports">
        <Card label="Total" value={metrics.exp.total} small />
        <Card label="Completed" value={metrics.exp.completed} small />
        <Card label="Success rate" value={`${exportSuccessRate}%`} small />
        <Card label="Failed" value={metrics.exp.failed} small />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
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
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p
        className={
          small
            ? "mt-1 text-xl font-semibold text-gray-900"
            : "mt-1 text-3xl font-semibold text-gray-900"
        }
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}
