/**
 * sync-to-qbo — pushes approved invoices to QuickBooks Online as Bills.
 *
 * Triggered by POST /api/ap/exports with format='qbo'. Mirrors the
 * export-invoices job pattern:
 *   1. Claim the exports row (status: created → running).
 *   2. Load the accounting_connection + decrypt tokens; refresh if expired.
 *   3. For each invoice in export_items: find-or-create QBO vendor,
 *      create Bill, store QBO Bill ID in export_items.external_id.
 *   4. Mark items synced/sync_failed; advance invoices to 'exported';
 *      mark the export completed (or failed if all items failed).
 */
import type PgBoss from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import {
  exports as exportsTable,
  exportItems,
  extractedInvoices,
  extractedInvoiceLines,
  documents,
  accountingConnections,
  auditEvents,
} from "@/db/schema";
import {
  createQboBill,
  refreshQboTokens,
  type QboBillInput,
} from "@/lib/integrations/qbo/client";
import { decryptToken } from "@/lib/integrations/tokens";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

export async function handleSyncToQbo(
  job: PgBoss.Job<JobPayloads[typeof JOB.syncToQbo]>,
): Promise<void> {
  const { exportId, organizationId } = job.data;

  // ── 1. Claim the export row ───────────────────────────────────────────
  const claimed = await withOrgAsWorker(organizationId, async (tx) => {
    const [row] = await tx
      .update(exportsTable)
      .set({ status: "running" })
      .where(
        and(
          eq(exportsTable.id, exportId),
          eq(exportsTable.organizationId, organizationId),
          inArray(exportsTable.status, ["created", "failed", "running"]),
        ),
      )
      .returning({ id: exportsTable.id });
    return row ?? null;
  });

  if (!claimed) {
    console.warn(`[sync-to-qbo] export=${exportId} not claimable (already completed or missing)`);
    return;
  }

  // ── 2. Load connection + tokens ───────────────────────────────────────
  const conn = await withOrgAsWorker(organizationId, async (tx) => {
    const [c] = await tx
      .select()
      .from(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          eq(accountingConnections.provider, "qbo"),
          eq(accountingConnections.isActive, true),
        ),
      )
      .limit(1);
    return c ?? null;
  });

  if (!conn) {
    await failExport(organizationId, exportId, "No active QBO connection found");
    return;
  }

  // Refresh token if expiring within 5 minutes.
  let accessToken = decryptToken(conn.accessToken);
  if (conn.tokenExpiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    try {
      const refreshed = await refreshQboTokens(organizationId, conn.id, conn.refreshToken);
      accessToken = refreshed.accessToken;
    } catch (err) {
      await failExport(organizationId, exportId, `Token refresh failed: ${String(err).slice(0, 200)}`);
      return;
    }
  }

  const realmId = conn.realmId;
  const settings = (conn.settings ?? {}) as { defaultExpenseAccountId?: string };

  // ── 3. Load invoice data ──────────────────────────────────────────────
  const items = await withOrgAsWorker(organizationId, async (tx) => {
    return tx
      .select({
        itemId: exportItems.id,
        invoiceId: extractedInvoices.id,
        vendorName: extractedInvoices.vendorName,
        invoiceNumber: extractedInvoices.invoiceNumber,
        invoiceDate: extractedInvoices.invoiceDate,
        dueDate: extractedInvoices.dueDate,
        currency: extractedInvoices.currency,
        total: extractedInvoices.total,
        documentId: extractedInvoices.documentId,
      })
      .from(exportItems)
      .innerJoin(
        extractedInvoices,
        eq(exportItems.extractedInvoiceId, extractedInvoices.id),
      )
      .where(
        and(
          eq(exportItems.exportId, exportId),
          eq(exportItems.organizationId, organizationId),
        ),
      );
  });

  // Load line items for all invoices in one query.
  const invoiceIds = items.map((i) => i.invoiceId);
  const allLines = invoiceIds.length > 0
    ? await withOrgAsWorker(organizationId, async (tx) =>
        tx
          .select({
            extractedInvoiceId: extractedInvoiceLines.extractedInvoiceId,
            description: extractedInvoiceLines.description,
            amount: extractedInvoiceLines.amount,
          })
          .from(extractedInvoiceLines)
          .where(inArray(extractedInvoiceLines.extractedInvoiceId, invoiceIds))
      )
    : [];

  // ── 4. Push each invoice to QBO ───────────────────────────────────────
  let syncedCount = 0;
  let failedCount = 0;

  for (const item of items) {
    const lines = allLines
      .filter((l) => l.extractedInvoiceId === item.invoiceId)
      .map((l) => ({
        description: l.description,
        amount: l.amount ? parseFloat(l.amount) : 0,
      }))
      .filter((l) => l.amount > 0);

    const input: QboBillInput = {
      vendorName: item.vendorName ?? "Unknown Vendor",
      total: item.total ? parseFloat(item.total) : 0,
      invoiceDate: item.invoiceDate
        ? new Date(item.invoiceDate).toISOString().slice(0, 10)
        : null,
      dueDate: item.dueDate
        ? new Date(item.dueDate).toISOString().slice(0, 10)
        : null,
      invoiceNumber: item.invoiceNumber,
      currency: item.currency ?? "USD",
      defaultExpenseAccountId: settings.defaultExpenseAccountId ?? null,
      lineItems: lines,
    };

    try {
      const result = await createQboBill(realmId, accessToken, input);

      await withOrgAsWorker(organizationId, async (tx) => {
        await tx
          .update(exportItems)
          .set({ status: "synced", externalId: result.billId })
          .where(eq(exportItems.id, item.itemId));
      });
      syncedCount++;
    } catch (err) {
      console.error(`[sync-to-qbo] invoice=${item.invoiceId} failed:`, err);
      await withOrgAsWorker(organizationId, async (tx) => {
        await tx
          .update(exportItems)
          .set({ status: "sync_failed" })
          .where(eq(exportItems.id, item.itemId));
      });
      failedCount++;
    }
  }

  // ── 5. Complete or fail the export ────────────────────────────────────
  const allFailed = failedCount === items.length && items.length > 0;

  await withOrgAsWorker(organizationId, async (tx) => {
    if (allFailed) {
      await tx
        .update(exportsTable)
        .set({
          status: "failed",
          errorMessage: `All ${failedCount} invoice(s) failed to sync to QBO`,
        })
        .where(
          and(
            eq(exportsTable.id, exportId),
            eq(exportsTable.status, "running"),
          ),
        );
      return;
    }

    // Advance synced invoices to 'exported'.
    if (syncedCount > 0) {
      const syncedItems = await tx
        .select({ extractedInvoiceId: exportItems.extractedInvoiceId })
        .from(exportItems)
        .where(
          and(
            eq(exportItems.exportId, exportId),
            eq(exportItems.status, "synced"),
          ),
        );
      const syncedInvoiceIds = syncedItems.map((i) => i.extractedInvoiceId);

      await tx
        .update(extractedInvoices)
        .set({ reviewStatus: "exported", updatedAt: new Date() })
        .where(
          and(
            inArray(extractedInvoices.id, syncedInvoiceIds),
            eq(extractedInvoices.reviewStatus, "approved"),
          ),
        );

      // Advance parent documents.
      const syncedDocs = items
        .filter((i) => syncedInvoiceIds.includes(i.invoiceId))
        .map((i) => i.documentId);
      if (syncedDocs.length > 0) {
        await tx
          .update(documents)
          .set({ status: "exported" })
          .where(
            and(
              inArray(documents.id, syncedDocs),
              eq(documents.status, "approved"),
            ),
          );
      }
    }

    await tx
      .update(exportsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(exportsTable.id, exportId),
          eq(exportsTable.status, "running"),
        ),
      );

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "export.qbo_sync_completed",
      entityType: "export",
      entityId: exportId,
      metadataJson: { syncedCount, failedCount },
    });
  });
}

async function failExport(
  organizationId: string,
  exportId: string,
  errorMessage: string,
): Promise<void> {
  await withOrgAsWorker(organizationId, async (tx) => {
    await tx
      .update(exportsTable)
      .set({ status: "failed", errorMessage: errorMessage.slice(0, 500) })
      .where(
        and(
          eq(exportsTable.id, exportId),
          inArray(exportsTable.status, ["created", "running"]),
        ),
      );
  });
}
