/**
 * Reviewer correction capture and RAG retrieval.
 *
 * Capture: called from the capture-and-embed job after an invoice is
 * approved. Loads all invoice.edited audit events for the invoice,
 * folds the field-level diffs, and inserts one extraction_corrections
 * row (ON CONFLICT DO NOTHING — idempotent on job retries).
 *
 * Retrieval: called from generateBriefingCard. Tries cosine similarity
 * search via pgvector when embeddings exist; falls back to exact
 * vendor_id match otherwise.
 *
 * Context text format deliberately buckets amounts and omits invoice
 * numbers so exact-value PII stays off the Voyage AI API boundary.
 * Vendor names ARE included — same risk class as invoice text already
 * sent to Anthropic for extraction.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import { withOrgAsWorker } from "@/db/client";
import {
  auditEvents,
  extractedInvoices,
  extractionCorrections,
  vendorMatches,
} from "@/db/schema";
import type { CorrectedField } from "@/db/schema/extractionCorrections";
import { scrubError } from "@/lib/llm/scrub";

export type { CorrectedField };

export interface CorrectionSignal {
  /** Which header fields were corrected, e.g. ["vendorName","total"]. */
  fields: string[];
  confirmedAt: string; // ISO string
}

// ---------------------------------------------------------------------------
// Context text builders
// ---------------------------------------------------------------------------

/** Build the text stored in correction_context_text (and embedded). */
export function buildCorrectionContextText(args: {
  vendorName: string | null;
  lineKeywords: string[];
  correctedFieldNames: string[];
}): string {
  const parts: string[] = [];
  if (args.vendorName) parts.push(`Vendor: ${args.vendorName}`);
  const kws = args.lineKeywords.slice(0, 4).join(", ");
  if (kws) parts.push(`Lines: ${kws}`);
  if (args.correctedFieldNames.length > 0) {
    parts.push(`Reviewer corrected: ${args.correctedFieldNames.join(", ")}`);
  }
  return parts.join(". ");
}

/** Build the query text for the CURRENT invoice (embedding search query). */
export function buildQueryContextText(args: {
  vendorName: string | null;
  lineDescriptions: (string | null)[];
  total: number | null;
}): string {
  const parts: string[] = [];
  if (args.vendorName) parts.push(`Vendor: ${args.vendorName}`);
  const keywords = args.lineDescriptions
    .filter((d): d is string => d !== null && d.trim().length > 0)
    .map((d) => d.split(/\s+/).slice(0, 3).join(" "))
    .slice(0, 4);
  if (keywords.length > 0) parts.push(`Lines: ${keywords.join(", ")}`);
  if (args.total !== null) parts.push(`Amount: ${bucketAmount(args.total)}`);
  return parts.join(". ");
}

function bucketAmount(n: number): string {
  if (n < 500) return "<$500";
  if (n < 2_000) return "~$1k";
  if (n < 7_500) return "~$5k";
  if (n < 20_000) return "~$10k";
  if (n < 75_000) return "~$50k";
  if (n < 200_000) return "~$100k";
  return ">$100k";
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture reviewer corrections for an approved invoice.
 *
 * Returns `{correctionId, contextText}` when a row was found or
 * created, `null` when there were no reviewer edits before approval.
 *
 * Idempotent: uses ON CONFLICT DO NOTHING on the unique index
 * `uniq_extraction_corrections_invoice`, then reads back the row.
 *
 * Called from the `capture-and-embed-correction` job (worker context).
 */
export async function captureApproveCorrections(args: {
  extractedInvoiceId: string;
  organizationId: string;
}): Promise<{ correctionId: string; contextText: string } | null> {
  return withOrgAsWorker(args.organizationId, async (tx) => {
    // 1. Load all invoice.edited events (reviewer PATCHes before approval).
    const editEvents = await tx
      .select({
        beforeJson: auditEvents.beforeJson,
        afterJson: auditEvents.afterJson,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, args.organizationId),
          eq(auditEvents.entityType, "extracted_invoice"),
          eq(auditEvents.entityId, args.extractedInvoiceId),
          eq(auditEvents.action, "invoice.edited"),
        ),
      )
      .orderBy(auditEvents.seq); // ascending — oldest edit first

    if (editEvents.length === 0) return null;

    // 2. Fold events into a map of {field → {extracted, corrected}}.
    //    extracted = the LLM's original value (earliest before).
    //    corrected = the reviewer's final value (latest after).
    const fieldChanges = new Map<
      string,
      { extracted: string | null; corrected: string | null }
    >();
    for (const event of editEvents) {
      const before =
        (event.beforeJson as Record<string, unknown> | null) ?? {};
      const after = (event.afterJson as Record<string, unknown> | null) ?? {};
      for (const [field, afterVal] of Object.entries(after)) {
        const beforeStr =
          before[field] != null ? String(before[field]) : null;
        const afterStr = afterVal != null ? String(afterVal) : null;
        if (afterStr === beforeStr) continue; // field didn't change
        const existing = fieldChanges.get(field);
        if (existing) {
          existing.corrected = afterStr; // update to latest after
        } else {
          fieldChanges.set(field, {
            extracted: beforeStr,
            corrected: afterStr,
          });
        }
      }
    }

    if (fieldChanges.size === 0) return null; // all edits were no-ops

    const correctedFields: CorrectedField[] = Array.from(
      fieldChanges.entries(),
    ).map(([field, { extracted, corrected }]) => ({
      field,
      extracted,
      corrected,
    }));

    // 3. Load invoice header for vendor name + line keywords.
    const [invoice] = await tx
      .select({
        vendorName: extractedInvoices.vendorName,
        total: extractedInvoices.total,
      })
      .from(extractedInvoices)
      .where(eq(extractedInvoices.id, args.extractedInvoiceId))
      .limit(1);

    // 4. Resolve vendor_id from the latest vendor_match.
    const [latestMatch] = await tx
      .select({ vendorId: vendorMatches.vendorId })
      .from(vendorMatches)
      .where(eq(vendorMatches.extractedInvoiceId, args.extractedInvoiceId))
      .orderBy(desc(vendorMatches.createdAt))
      .limit(1);

    const contextText = buildCorrectionContextText({
      vendorName: invoice?.vendorName ?? null,
      lineKeywords: [],
      correctedFieldNames: correctedFields.map((f) => f.field),
    });

    // 5. Insert (idempotent — skip on conflict with the unique index).
    await tx
      .insert(extractionCorrections)
      .values({
        organizationId: args.organizationId,
        extractedInvoiceId: args.extractedInvoiceId,
        vendorId: latestMatch?.vendorId ?? null,
        correctedFields,
        contextText,
        confirmedAt: new Date(),
      })
      .onConflictDoNothing();

    // 6. Read back the row (just inserted or pre-existing from a prior run).
    const [row] = await tx
      .select({
        id: extractionCorrections.id,
        contextText: extractionCorrections.contextText,
      })
      .from(extractionCorrections)
      .where(
        eq(
          extractionCorrections.extractedInvoiceId,
          args.extractedInvoiceId,
        ),
      )
      .limit(1);

    if (!row) return null;
    return { correctionId: row.id, contextText: row.contextText };
  });
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve past corrections similar to the current invoice context.
 *
 * Primary: cosine similarity search via pgvector when VOYAGE_API_KEY
 * is set and the target table has embedded rows.
 *
 * Fallback: vendor_id exact match ordered by recency.
 *
 * Called from generateBriefingCard between Phase 1 and the LLM dispatch
 * (outside any transaction — the Voyage AI call must not hold a DB conn).
 */
export async function retrieveSimilarCorrections(args: {
  organizationId: string;
  vendorId: string | null;
  queryContextText: string;
  limit?: number;
}): Promise<CorrectionSignal[]> {
  const limit = args.limit ?? 3;

  // Vector path — requires VOYAGE_API_KEY and at least some embedded rows.
  if (process.env.VOYAGE_API_KEY && args.queryContextText) {
    try {
      // Lazy import to keep the happy path fast when key is absent.
      const { generateEmbedding } = await import("@/lib/embeddings");
      const embedding = await generateEmbedding(args.queryContextText);
      if (embedding) {
        const signals = await vectorSearch({
          organizationId: args.organizationId,
          embedding,
          limit,
        });
        if (signals.length > 0) return signals;
        // Fall through to vendor fallback when no embedded rows exist yet.
      }
    } catch (err) {
      console.warn(
        "[corrections] vector search failed, falling back to vendor match:",
        scrubError(err),
      );
    }
  }

  // Vendor fallback — exact vendor_id match, most-recent first.
  if (args.vendorId) {
    return vendorSearch({
      organizationId: args.organizationId,
      vendorId: args.vendorId,
      limit,
    });
  }

  return [];
}

// -- Internal helpers --------------------------------------------------------

type RawCorrectionRow = {
  corrected_fields: unknown;
  confirmed_at: unknown;
};

async function vectorSearch(args: {
  organizationId: string;
  embedding: number[];
  limit: number;
}): Promise<CorrectionSignal[]> {
  // Run inside withOrgAsWorker so the tenant isolation RLS policy fires.
  return withOrgAsWorker(args.organizationId, async (tx) => {
    const embeddingLiteral = `[${args.embedding.join(",")}]`;
    const result = await tx.execute<RawCorrectionRow>(sql`
      SELECT corrected_fields, confirmed_at::text AS confirmed_at
      FROM extraction_corrections
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${embeddingLiteral}::vector
      LIMIT ${args.limit}
    `);
    return rowsToSignals(result.rows);
  });
}

async function vendorSearch(args: {
  organizationId: string;
  vendorId: string;
  limit: number;
}): Promise<CorrectionSignal[]> {
  return withOrgAsWorker(args.organizationId, async (tx) => {
    const rows = await tx
      .select({
        correctedFields: extractionCorrections.correctedFields,
        confirmedAt: extractionCorrections.confirmedAt,
      })
      .from(extractionCorrections)
      .where(eq(extractionCorrections.vendorId, args.vendorId))
      .orderBy(desc(extractionCorrections.confirmedAt))
      .limit(args.limit);
    return rows.map((r) => ({
      fields: ((r.correctedFields as CorrectedField[]) ?? []).map(
        (f) => f.field,
      ),
      confirmedAt: r.confirmedAt?.toISOString() ?? "",
    }));
  });
}

function rowsToSignals(rows: RawCorrectionRow[]): CorrectionSignal[] {
  return rows.map((r) => ({
    fields: ((r.corrected_fields as CorrectedField[]) ?? []).map(
      (f) => f.field,
    ),
    confirmedAt:
      r.confirmed_at instanceof Date
        ? r.confirmed_at.toISOString()
        : String(r.confirmed_at ?? ""),
  }));
}
