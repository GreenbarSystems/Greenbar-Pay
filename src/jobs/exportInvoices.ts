/**
 * export-invoices — PRD §"Job: Export Invoices".
 *
 * Steps:
 *   1. Compare-and-set exports.status: 'created' → 'running' (§4.5).
 *      If status isn't 'created', another worker is processing this
 *      export — silent skip (idempotent).
 *   2. Load all linked extracted_invoices (+ lines) for the export.
 *   3. Re-confirm every row is still reviewStatus='approved'. If a
 *      reviewer pulled one back to needs_review between create and
 *      run, fail the whole export — partial CSV is a worse failure
 *      mode than "tell the user to retry."
 *   4. Render CSV or JSON via pure generators.
 *   5. Upload to object storage (key = exports/<org>/<exportId>.<fmt>).
 *   6. Mark exports.status='completed' + completedAt + storageKey + size.
 *   7. Advance each invoice's review_status: 'approved' → 'exported'
 *      via compare-and-set; advance documents.status the same way.
 *   8. Audit.
 */
import { createHash } from "node:crypto";
import type PgBoss from "pg-boss";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import {
  exports as exportsTable,
  exportItems,
  extractedInvoices,
  extractedInvoiceLines,
  documents,
  auditEvents,
} from "@/db/schema";
import { storage, exportStorageKey } from "@/lib/storage";
import { toCsv, toJson, type ExportRow } from "@/lib/export/format";
import { scrubError } from "@/lib/llm/scrub";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

export async function handleExportInvoices(
  job: PgBoss.Job<JobPayloads[typeof JOB.exportInvoices]>,
): Promise<void> {
  const { exportId, organizationId } = job.data;

  // ── 1. Claim ──────────────────────────────────────────────────────────
  // PR3 — review #11: claim accepts `created` OR `failed`. Without this,
  // a transient failure (S3 5xx, DB blip) put the export row into
  // `failed` permanently — no retry could ever advance it, and the
  // maker (POST /api/ap/exports) couldn't re-run since its exportId is
  // baked into the audit + idempotency cache. Now: pg-boss retries can
  // re-claim a failed run; the error_message is cleared on re-claim so
  // a later inspector sees only the current failure (if any).
  //
  // Audit follow-up: claim ALSO accepts `running`. The S3 PUT below
  // runs between the claim and the completion UPDATE; if the worker
  // process dies after the PUT but before (or during) the completion
  // tx, AND the outer catch-block fail-marking also fails (e.g. DB
  // unreachable), the row stuck at `running` would otherwise block
  // every future retry forever. Accepting `running` here closes that
  // hole. The S3 PUT is idempotent on the deterministic key
  // (`exports/<org>/<exportId>.<fmt>`), so a re-PUT just overwrites
  // with the same content. The lost-race check after the completion
  // UPDATE guards against the (vanishingly unlikely) case of two
  // workers genuinely processing the same job concurrently — pg-boss
  // singleton + visibility timeout should prevent it, but cheap to
  // verify.
  const claimed = await withOrgAsWorker(organizationId, async (tx) => {
    const rows = await tx
      .update(exportsTable)
      .set({ status: "running", errorMessage: null })
      .where(
        and(
          eq(exportsTable.id, exportId),
          eq(exportsTable.organizationId, organizationId),
          inArray(exportsTable.status, ["created", "failed", "running"]),
        ),
      )
      .returning({
        id: exportsTable.id,
        format: exportsTable.format,
      });
    return rows[0] ?? null;
  });

  if (!claimed) {
    console.log(
      `[export-invoices] export=${exportId} not claimable (status terminal or row missing); skipping`,
    );
    return;
  }

  try {
    await runExport(exportId, organizationId, claimed.format);
  } catch (err) {
    // Mark failed and let pg-boss replay according to retry policy.
    // Scrub before persisting — runExport's failure may carry SDK or
    // SQL fragments with vendor / invoice content (§2.4).
    const scrubbedMessage = scrubError(err).message.slice(0, 500);
    await withOrgAsWorker(organizationId, async (tx) => {
      await tx
        .update(exportsTable)
        .set({
          status: "failed",
          errorMessage: scrubbedMessage,
        })
        .where(eq(exportsTable.id, exportId));
      await tx.insert(auditEvents).values({
        organizationId,
        actorType: "worker",
        action: "export.failed",
        entityType: "export",
        entityId: exportId,
        metadataJson: { reason: scrubbedMessage },
      });
    });
    throw err;
  }
}

async function runExport(
  exportId: string,
  organizationId: string,
  format: "csv" | "json",
): Promise<void> {
  // ── 2. Load rows ─────────────────────────────────────────────────────
  const rows = await withOrgAsWorker(organizationId, async (tx) => {
    const items = await tx
      .select({
        invoiceId: extractedInvoices.id,
        documentId: extractedInvoices.documentId,
        documentType: extractedInvoices.documentType,
        vendorName: extractedInvoices.vendorName,
        vendorAddress: extractedInvoices.vendorAddress,
        invoiceNumber: extractedInvoices.invoiceNumber,
        invoiceDate: extractedInvoices.invoiceDate,
        dueDate: extractedInvoices.dueDate,
        purchaseOrderNumber: extractedInvoices.purchaseOrderNumber,
        paymentTerms: extractedInvoices.paymentTerms,
        currency: extractedInvoices.currency,
        subtotal: extractedInvoices.subtotal,
        tax: extractedInvoices.tax,
        shipping: extractedInvoices.shipping,
        discount: extractedInvoices.discount,
        total: extractedInvoices.total,
        confidence: extractedInvoices.confidence,
        reviewStatus: extractedInvoices.reviewStatus,
        reviewedAt: extractedInvoices.reviewedAt,
      })
      .from(exportItems)
      .innerJoin(
        extractedInvoices,
        eq(extractedInvoices.id, exportItems.extractedInvoiceId),
      )
      .where(eq(exportItems.exportId, exportId));

    // Pull line items in one shot so we can attach by id.
    const invoiceIds = items.map((i) => i.invoiceId);
    const lines =
      invoiceIds.length > 0
        ? await tx
            .select()
            .from(extractedInvoiceLines)
            .where(
              inArray(extractedInvoiceLines.extractedInvoiceId, invoiceIds),
            )
            .orderBy(extractedInvoiceLines.lineNumber)
        : [];
    const linesByInvoice = new Map<string, typeof lines>();
    for (const l of lines) {
      const arr = linesByInvoice.get(l.extractedInvoiceId) ?? [];
      arr.push(l);
      linesByInvoice.set(l.extractedInvoiceId, arr);
    }

    return items.map((i): { row: ExportRow; reviewStatus: string } => ({
      reviewStatus: i.reviewStatus,
      row: {
        invoice_id: i.invoiceId,
        document_id: i.documentId,
        vendor_name: i.vendorName,
        vendor_address: i.vendorAddress,
        invoice_number: i.invoiceNumber,
        invoice_date: i.invoiceDate,
        due_date: i.dueDate,
        purchase_order_number: i.purchaseOrderNumber,
        payment_terms: i.paymentTerms,
        currency: i.currency,
        subtotal: asString(i.subtotal),
        tax: asString(i.tax),
        shipping: asString(i.shipping),
        discount: asString(i.discount),
        total: asString(i.total),
        document_type: i.documentType,
        confidence: i.confidence,
        approved_at: i.reviewedAt ? i.reviewedAt.toISOString() : null,
        line_items: (linesByInvoice.get(i.invoiceId) ?? []).map((l) => ({
          line_number: l.lineNumber,
          description: l.description,
          quantity: asString(l.quantity),
          unit_price: asString(l.unitPrice),
          amount: asString(l.amount),
        })),
      },
    }));
  });

  // ── 3. Re-confirm approval ──────────────────────────────────────────
  const notApproved = rows.filter((r) => r.reviewStatus !== "approved");
  if (notApproved.length > 0) {
    throw new Error(
      `export ${exportId}: ${notApproved.length} invoice(s) no longer approved (status changed mid-flight)`,
    );
  }
  const dataRows = rows.map((r) => r.row);

  // ── 4–5. Render + upload ────────────────────────────────────────────
  const body =
    format === "csv" ? Buffer.from(toCsv(dataRows), "utf8") : Buffer.from(toJson(dataRows), "utf8");
  const key = exportStorageKey({ organizationId, exportId, format });
  await storage.putObject({
    key,
    body,
    contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json",
  });

  // ── 6–8. Persist completion + advance statuses + audit ──────────────
  // Compute the content hash outside the tx (deterministic, no DB IO).
  // PR20 — captures what was written so a later download event can
  // verify no storage-layer substitution occurred.
  const fileContentHash = createHash("sha256").update(body).digest("hex");

  await withOrgAsWorker(organizationId, async (tx) => {
    // Compare-and-set completion. RETURNING tells us whether this run
    // actually advanced the row. If a concurrent worker beat us — only
    // possible if pg-boss singleton + visibility timeout failed, but
    // cheap to guard — `completed` is already set and the rest of this
    // block would double-advance invoices / double-audit. Silent exit
    // is correct: the work is already done.
    const advanced = await tx
      .update(exportsTable)
      .set({
        status: "completed",
        storageKey: key,
        fileSizeBytes: body.length,
        completedAt: sql`now()`,
      })
      .where(
        and(
          eq(exportsTable.id, exportId),
          eq(exportsTable.status, "running"),
        ),
      )
      .returning({ id: exportsTable.id });

    if (advanced.length === 0) {
      console.log(
        `[export-invoices] export=${exportId} completion lost race (already completed by concurrent worker); skipping downstream advances`,
      );
      return;
    }

    // Advance invoices: only from 'approved' → 'exported'. If any have
    // since been re-edited (back to needs_review), they stay there.
    const invoiceIds = dataRows.map((r) => r.invoice_id);
    await tx
      .update(extractedInvoices)
      .set({ reviewStatus: "exported" })
      .where(
        and(
          eq(extractedInvoices.organizationId, organizationId),
          inArray(extractedInvoices.id, invoiceIds),
          eq(extractedInvoices.reviewStatus, "approved"),
        ),
      );

    // Advance documents in lockstep.
    const docIds = dataRows.map((r) => r.document_id);
    await tx
      .update(documents)
      .set({ status: "exported" })
      .where(
        and(
          eq(documents.organizationId, organizationId),
          inArray(documents.id, docIds),
          eq(documents.status, "approved"),
        ),
      );

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "export.completed",
      entityType: "export",
      entityId: exportId,
      metadataJson: {
        format,
        itemCount: dataRows.length,
        fileSizeBytes: body.length,
        fileContentHash,
      },
    });
  });
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
