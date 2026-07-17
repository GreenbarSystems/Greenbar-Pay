import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { extractedInvoices, extractedInvoiceLines } from "@/db/schema";
import type { SpendQueryIntent } from "@/lib/llm/spend-query-schema";

export interface SpendQueryResult {
  columns: string[];
  rows: Record<string, string | number | null>[];
  summary: { totalSpend: string | null; invoiceCount: number };
}

function resolveTimeframe(timeframe: string): { from: string | null; to: string | null } {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const year = now.getFullYear();

  if (timeframe === "all_time") return { from: null, to: null };

  if (timeframe === "last_30_days") {
    const d = new Date(now.getTime() - 30 * 86400_000);
    return { from: d.toISOString().slice(0, 10), to: today };
  }

  if (timeframe === "ytd") return { from: `${year}-01-01`, to: today };

  if (timeframe === "last_year") {
    const y = year - 1;
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }

  if (timeframe === "last_quarter") {
    const month = now.getMonth(); // 0-11
    const q = Math.floor(month / 3);
    const pq = q === 0 ? 3 : q - 1;
    const py = q === 0 ? year - 1 : year;
    const qStart = `${py}-${String(pq * 3 + 1).padStart(2, "0")}-01`;
    const qEnd = new Date(py, pq * 3 + 3, 0).toISOString().slice(0, 10);
    return { from: qStart, to: qEnd };
  }

  // Custom range: "YYYY-MM-DD..YYYY-MM-DD"
  const [from, to] = timeframe.split("..");
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { from, to };
  }

  return { from: null, to: null };
}

/**
 * Builds and executes a spend query from an extracted LLM intent.
 * Always runs inside an existing `withOrg` transaction — org isolation
 * is guaranteed by the caller; we only add the explicit organizationId
 * filter as defence-in-depth.
 */
export async function buildSpendQuery(
  tx: Tx,
  intent: SpendQueryIntent,
  organizationId: string,
): Promise<SpendQueryResult> {
  const { from, to } = resolveTimeframe(intent.timeframe);

  // Build WHERE clause fragments as SQL strings that get embedded in the
  // raw query below. We use parameterized values via the sql`` tag.
  const whereParts: ReturnType<typeof sql>[] = [
    sql`ei.organization_id = ${organizationId}`,
    sql`ei.review_status != 'superseded'`,
  ];

  if (from) whereParts.push(sql`ei.invoice_date >= ${from}::date`);
  if (to) whereParts.push(sql`ei.invoice_date <= ${to}::date`);

  if (intent.vendors.length > 0) {
    const vendorOrs = intent.vendors.map((v) => sql`ei.vendor_name ILIKE ${"%" + v + "%"}`);
    whereParts.push(sql`(${sql.join(vendorOrs, sql` OR `)})`);
  }

  if (intent.amountMin != null) {
    whereParts.push(sql`ei.total >= ${String(intent.amountMin)}`);
  }
  if (intent.amountMax != null) {
    whereParts.push(sql`ei.total <= ${String(intent.amountMax)}`);
  }

  if (intent.statuses.length > 0) {
    const statusList = sql.join(
      intent.statuses.map((s) => sql`${s}`),
      sql`, `,
    );
    whereParts.push(sql`ei.review_status IN (${statusList})`);
  }

  if (intent.lineKeywords.length > 0) {
    const kwOrs = intent.lineKeywords.map(
      (k) =>
        sql`EXISTS (SELECT 1 FROM ${extractedInvoiceLines} eil WHERE eil.extracted_invoice_id = ei.id AND eil.description ILIKE ${"%" + k + "%"})`,
    );
    whereParts.push(sql`(${sql.join(kwOrs, sql` OR `)})`);
  }

  const whereClause = sql.join(whereParts, sql` AND `);

  if (intent.metric === "list") {
    return runListQuery(tx, whereClause);
  }

  if (intent.groupBy) {
    return runGroupedQuery(tx, whereClause, intent.metric, intent.groupBy);
  }

  return runAggregateQuery(tx, whereClause, intent.metric);
}

async function runListQuery(
  tx: Tx,
  where: ReturnType<typeof sql>,
): Promise<SpendQueryResult> {
  const result = await tx.execute<{
    id: string;
    invoice_number: string | null;
    vendor_name: string | null;
    invoice_date: string | null;
    total: string | null;
    review_status: string;
  }>(sql`
    SELECT
      ei.id,
      ei.invoice_number,
      ei.vendor_name,
      ei.invoice_date::text,
      ei.total::text,
      ei.review_status
    FROM ${extractedInvoices} ei
    WHERE ${where}
    ORDER BY ei.invoice_date DESC NULLS LAST, ei.created_at DESC
    LIMIT 200
  `);

  const rows = result.rows.map((r) => ({
    id: r.id,
    vendor: r.vendor_name,
    date: r.invoice_date,
    number: r.invoice_number,
    total: r.total,
    status: r.review_status,
  }));

  const totalSpend = rows
    .reduce((sum, r) => sum + (r.total ? parseFloat(r.total) : 0), 0)
    .toFixed(2);

  return {
    columns: ["vendor", "date", "number", "total", "status"],
    rows,
    summary: { totalSpend, invoiceCount: rows.length },
  };
}

async function runAggregateQuery(
  tx: Tx,
  where: ReturnType<typeof sql>,
  metric: SpendQueryIntent["metric"],
): Promise<SpendQueryResult> {
  const metricExpr =
    metric === "total_spend"
      ? sql`SUM(ei.total)::numeric`
      : metric === "invoice_count"
        ? sql`COUNT(*)::int`
        : sql`AVG(ei.total)::numeric`; // avg_invoice

  const metricLabel =
    metric === "total_spend" ? "total_spend" : metric === "invoice_count" ? "count" : "avg_spend";

  const result = await tx.execute<{ value: string | null; count: string }>(sql`
    SELECT
      ${metricExpr} AS value,
      COUNT(*)::int AS count
    FROM ${extractedInvoices} ei
    WHERE ${where}
  `);

  const row = result.rows[0];
  return {
    columns: [metricLabel, "invoice_count"],
    rows: [{ [metricLabel]: row?.value ?? null, invoice_count: row?.count ? Number(row.count) : 0 }],
    summary: {
      totalSpend: metric === "total_spend" ? (row?.value ?? null) : null,
      invoiceCount: row?.count ? Number(row.count) : 0,
    },
  };
}

async function runGroupedQuery(
  tx: Tx,
  where: ReturnType<typeof sql>,
  metric: SpendQueryIntent["metric"],
  groupBy: NonNullable<SpendQueryIntent["groupBy"]>,
): Promise<SpendQueryResult> {
  const groupExpr =
    groupBy === "vendor"
      ? sql`COALESCE(ei.vendor_name, '(unknown)')`
      : groupBy === "month"
        ? sql`DATE_TRUNC('month', ei.invoice_date)::date::text`
        : groupBy === "week"
          ? sql`DATE_TRUNC('week', ei.invoice_date)::date::text`
          : sql`ei.review_status`; // status

  const groupLabel =
    groupBy === "vendor" ? "vendor" : groupBy === "status" ? "status" : "period";

  const metricExpr =
    metric === "total_spend"
      ? sql`SUM(ei.total)::numeric`
      : metric === "invoice_count"
        ? sql`COUNT(*)::int`
        : sql`AVG(ei.total)::numeric`;

  const metricLabel =
    metric === "total_spend" ? "total_spend" : metric === "invoice_count" ? "count" : "avg_spend";

  const result = await tx.execute<{
    group_key: string | null;
    metric_value: string | null;
    row_count: string;
  }>(sql`
    SELECT
      ${groupExpr} AS group_key,
      ${metricExpr} AS metric_value,
      COUNT(*)::int AS row_count
    FROM ${extractedInvoices} ei
    WHERE ${where}
    GROUP BY ${groupExpr}
    ORDER BY ${metricExpr} DESC NULLS LAST
    LIMIT 50
  `);

  const rows = result.rows.map((r) => ({
    [groupLabel]: r.group_key,
    [metricLabel]: r.metric_value,
    invoice_count: r.row_count ? Number(r.row_count) : 0,
  }));

  const totalSpend =
    metric === "total_spend"
      ? rows.reduce((s, r) => s + parseFloat(String(r[metricLabel] ?? "0")), 0).toFixed(2)
      : null;

  return {
    columns: [groupLabel, metricLabel, "invoice_count"],
    rows,
    summary: {
      totalSpend,
      invoiceCount: rows.reduce((s, r) => s + r.invoice_count, 0),
    },
  };
}
