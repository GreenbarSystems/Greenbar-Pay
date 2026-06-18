/**
 * recompute-vendor-profile — Phase 7 (D1).
 *
 * Trigger: enqueued by the approve handler after every successful
 * approval.  Idempotent on vendorId: re-running aggregates the same
 * approved invoices and writes the same numbers.
 *
 * Steps:
 *   1. Pull all approved+exported invoices for the vendor.
 *   2. Compute derived stats:
 *        invoice_count, last_invoice_date,
 *        spend_30d, spend_90d, avg_invoice_amount.
 *   3. Detect terms drift: latest approved invoice's payment_terms
 *      vs vendors.default_payment_terms.
 *   4. Increment duplicate_submission_count when the latest approved
 *      invoice has an ACTIVE validation_results row carrying a
 *      duplicate_invoice finding (the dup was approved through anyway).
 *   5. Update vendor_pricing_history: aggregate line items by
 *      normalized item_keyword, upsert avg + samples.
 *   6. Write last_profile_updated.
 *
 * Per-vendor advisory lock prevents two concurrent recomputes from
 * racing on the same vendor.
 */
import type PgBoss from "pg-boss";
import {
  and,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { withOrgAsWorker } from "@/db/client";
import {
  vendors,
  vendorPricingHistory,
  extractedInvoices,
  extractedInvoiceLines,
  validationResults,
  auditEvents,
} from "@/db/schema";
import type { JobPayloads } from "@/lib/queue";
import { JOB } from "@/lib/queue";

/** Cap historical samples per (vendor, item_keyword) to keep the math bounded. */
const PRICING_SAMPLE_CAP = 50;

const STOP_WORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
  "service", "services", "fee", "fees", "charge", "charges", "monthly",
  "annual", "quarterly",
]);

export async function handleRecomputeVendorProfile(
  job: PgBoss.Job<JobPayloads[typeof JOB.recomputeVendorProfile]>,
): Promise<void> {
  const { vendorId, organizationId } = job.data;

  await withOrgAsWorker(organizationId, async (tx) => {
    // Serialize per-vendor recomputes.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended('vendor-profile:' || ${vendorId}::text, 0)
      )
    `);

    // Confirm vendor still exists in the org.
    const [vendor] = await tx
      .select({
        id: vendors.id,
        defaultPaymentTerms: vendors.defaultPaymentTerms,
      })
      .from(vendors)
      .where(
        and(
          eq(vendors.id, vendorId),
          eq(vendors.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!vendor) return;

    // 1. Approved (and exported) invoices for this vendor.
    //    We look up by normalized name match — vendor_id isn't set on
    //    extracted_invoices today (Phase 7 adds the link via approve's
    //    bootstrap). For the FIRST recompute of a freshly bootstrapped
    //    vendor we still need to find their invoices; we match on the
    //    aliases the bootstrap wrote.
    // PR5 — review C1: the original join had malformed SQL (one unclosed
    // paren in the nested sql template) AND didn't replicate JS
    // normalizeVendor (no whitespace collapse / trim). Now we use the
    // `normalize_vendor_text(text)` SQL function added in sidecar 0011,
    // which is the single source of truth for normalization in both
    // languages.
    //
    // Match path: invoice's vendor_name normalized === vendor's
    // normalized_name OR is in the vendor's aliases (already stored
    // pre-normalized by bootstrap).
    const invoiceRows = await tx
      .select({
        id: extractedInvoices.id,
        total: extractedInvoices.total,
        invoiceDate: extractedInvoices.invoiceDate,
        paymentTerms: extractedInvoices.paymentTerms,
      })
      .from(extractedInvoices)
      .innerJoin(
        vendors,
        and(
          eq(vendors.id, vendorId),
          or(
            sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ${vendors.normalizedName}`,
            sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ANY(${vendors.aliases})`,
          ),
        ),
      )
      .where(
        and(
          eq(extractedInvoices.organizationId, organizationId),
          inArray(extractedInvoices.reviewStatus, ["approved", "exported"]),
        ),
      );

    if (invoiceRows.length === 0) {
      await tx
        .update(vendors)
        .set({ lastProfileUpdated: sql`now()` })
        .where(eq(vendors.id, vendorId));
      return;
    }

    // 2. Aggregate header-level stats.
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    let totalSum = 0;
    let spend30 = 0;
    let spend90 = 0;
    let latestDate: string | null = null;
    let latestTerms: string | null = null;
    // PR5 — review C5: count payment_terms occurrences so we can derive
    // the MODE rather than treating first-seen as a frozen default.
    const termsCounts = new Map<string, number>();

    for (const r of invoiceRows) {
      const amt = r.total === null ? 0 : Number(r.total);
      totalSum += amt;
      if (r.paymentTerms) {
        termsCounts.set(
          r.paymentTerms,
          (termsCounts.get(r.paymentTerms) ?? 0) + 1,
        );
      }
      if (r.invoiceDate) {
        const d = new Date(`${r.invoiceDate}T00:00:00Z`);
        if (d >= thirtyDaysAgo) spend30 += amt;
        if (d >= ninetyDaysAgo) spend90 += amt;
        if (latestDate === null || r.invoiceDate > latestDate) {
          latestDate = r.invoiceDate;
          latestTerms = r.paymentTerms;
        }
      }
    }

    const invoiceCount = invoiceRows.length;
    const avg = invoiceCount > 0 ? totalSum / invoiceCount : 0;

    // PR5 — review C5: terms_drift detection now uses the MODE of
    // payment_terms across all approved invoices, not the first-seen
    // default that was frozen at bootstrap.
    //
    // The mode also becomes the new defaultPaymentTerms, so the
    // "default" reflects what this vendor actually invoices on
    // consistently — once they've drifted to a new terms value
    // permanently, that becomes the new default and drift turns off.
    //
    // Only meaningful at invoice_count >= 3 — matches the
    // vendorWarmingUp gate the risk score uses. With fewer than 3,
    // we don't claim to know what's normal for this vendor.
    let modeTerms: string | null = null;
    let modeCount = 0;
    for (const [terms, count] of termsCounts) {
      if (count > modeCount) {
        modeTerms = terms;
        modeCount = count;
      }
    }
    const termsDrift =
      invoiceCount >= 3 &&
      Boolean(latestTerms) &&
      Boolean(modeTerms) &&
      latestTerms !== modeTerms;

    // PR5 — review C4: duplicate_submission_count semantics.
    //
    // The original query counted active blocking findings on approved
    // invoices — but approve refuses 422 when blocking findings exist,
    // so the counter could never increment. Now: count DISTINCT invoices
    // from this vendor (any review_status, including rejected and
    // superseded) that EVER carried a duplicate_invoice finding. This
    // matches the spec's "duplicate pattern: count and date of prior
    // duplicate SUBMISSION attempts."
    //
    // First we need the full set of this vendor's invoices, not just
    // approved+exported — a rejected duplicate counts toward the pattern.
    const allVendorInvoiceIds = (
      await tx
        .select({ id: extractedInvoices.id })
        .from(extractedInvoices)
        .innerJoin(
          vendors,
          and(
            eq(vendors.id, vendorId),
            or(
              sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ${vendors.normalizedName}`,
              sql`normalize_vendor_text(${extractedInvoices.vendorName}) = ANY(${vendors.aliases})`,
            ),
          ),
        )
        .where(eq(extractedInvoices.organizationId, organizationId))
    ).map((r) => r.id);

    const dupCount =
      allVendorInvoiceIds.length === 0
        ? 0
        : (
            await tx
              .select({
                count: sql<number>`count(distinct ${validationResults.entityId})::int`,
              })
              .from(validationResults)
              .where(
                and(
                  eq(validationResults.organizationId, organizationId),
                  eq(validationResults.entityType, "extracted_invoice"),
                  inArray(validationResults.entityId, allVendorInvoiceIds),
                  sql`${validationResults.errorsJson} @> '[{"code":"duplicate_invoice"}]'::jsonb`,
                ),
              )
          )[0].count;

    await tx
      .update(vendors)
      .set({
        invoiceCount,
        lastInvoiceDate: latestDate,
        spend30d: spend30.toFixed(2),
        spend90d: spend90.toFixed(2),
        avgInvoiceAmount: avg.toFixed(2),
        duplicateSubmissionCount: dupCount,
        termsDriftDetected: termsDrift,
        // PR5 — review C5: defaultPaymentTerms tracks the MODE across
        // approved invoices, not the first-seen value. When a vendor's
        // terms permanently change, the next recompute moves the default
        // to the new mode and termsDrift turns off again. We only
        // update once we have enough samples (≥3) so a single outlier
        // doesn't flip the default.
        ...(invoiceCount >= 3 && modeTerms !== null
          ? { defaultPaymentTerms: modeTerms }
          : {}),
        lastProfileUpdated: sql`now()`,
      })
      .where(eq(vendors.id, vendorId));

    // 5. Pricing history. Aggregate line items by normalized keyword.
    const lineRows = await tx
      .select({
        description: extractedInvoiceLines.description,
        unitPrice: extractedInvoiceLines.unitPrice,
        invoiceDate: extractedInvoices.invoiceDate,
      })
      .from(extractedInvoiceLines)
      .innerJoin(
        extractedInvoices,
        eq(extractedInvoices.id, extractedInvoiceLines.extractedInvoiceId),
      )
      .where(
        and(
          eq(extractedInvoiceLines.organizationId, organizationId),
          inArray(extractedInvoiceLines.extractedInvoiceId, invoiceIds),
        ),
      );

    const grouped = new Map<
      string,
      { sum: number; count: number; latest: Date }
    >();
    for (const r of lineRows) {
      if (r.unitPrice === null) continue;
      const keyword = itemKeyword(r.description);
      if (!keyword) continue;
      const price = Number(r.unitPrice);
      if (!Number.isFinite(price)) continue;

      const date = r.invoiceDate
        ? new Date(`${r.invoiceDate}T00:00:00Z`)
        : now;
      const existing = grouped.get(keyword);
      if (existing) {
        existing.sum += price;
        existing.count += 1;
        if (date > existing.latest) existing.latest = date;
      } else {
        grouped.set(keyword, { sum: price, count: 1, latest: date });
      }
    }

    for (const [keyword, agg] of grouped) {
      const samples = Math.min(agg.count, PRICING_SAMPLE_CAP);
      const avgPrice = agg.sum / agg.count;
      await tx
        .insert(vendorPricingHistory)
        .values({
          organizationId,
          vendorId,
          itemKeyword: keyword,
          avgUnitPrice: avgPrice.toFixed(4),
          samples,
          lastSeenAt: agg.latest,
        })
        .onConflictDoUpdate({
          target: [vendorPricingHistory.vendorId, vendorPricingHistory.itemKeyword],
          set: {
            avgUnitPrice: avgPrice.toFixed(4),
            samples,
            lastSeenAt: agg.latest,
          },
        });
    }

    await tx.insert(auditEvents).values({
      organizationId,
      actorType: "worker",
      action: "vendor.profile_recomputed",
      entityType: "vendor",
      entityId: vendorId,
      metadataJson: {
        invoiceCount,
        spend30d: spend30,
        spend90d: spend90,
        termsDriftDetected: termsDrift,
        duplicateSubmissionCount: dupCount,
        pricingKeywords: grouped.size,
      },
    });
  });
}

/**
 * Reduce a line description to a stable grouping key. Lowercase, strip
 * non-alphanumeric, drop stop words, take first 3 meaningful tokens.
 * Cheap; deterministic; collisions across loosely-related items are
 * acceptable for a Phase 7 first cut.
 */
export function itemKeyword(description: string | null): string | null {
  if (!description) return null;
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return null;
  return tokens.slice(0, 3).join(" ");
}
