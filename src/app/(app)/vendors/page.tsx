/**
 * Vendor master list (Phase 7 — D1).
 *
 * Listing surface for the Vendor Memory Layer. Each row links to a
 * vendor detail view that shows the full profile.
 *
 * Profile fields become "meaningful after three or more invoices" per
 * the spec — we still display the row, but the derived columns render
 * "—" when invoice_count < 3 so reviewers don't read into noise.
 */
import Link from "next/link";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { vendors } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

const PROFILE_READY_THRESHOLD = 3;

export default async function VendorsListPage() {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId } = session.user;

  const rows = await withOrg(organizationId, async (tx) => {
    return tx
      .select({
        id: vendors.id,
        name: vendors.name,
        aliases: vendors.aliases,
        invoiceCount: vendors.invoiceCount,
        lastInvoiceDate: vendors.lastInvoiceDate,
        spend30d: vendors.spend30d,
        spend90d: vendors.spend90d,
        avgInvoiceAmount: vendors.avgInvoiceAmount,
        termsDriftDetected: vendors.termsDriftDetected,
        duplicateSubmissionCount: vendors.duplicateSubmissionCount,
      })
      .from(vendors)
      .where(eq(vendors.organizationId, organizationId))
      .orderBy(desc(vendors.invoiceCount), desc(vendors.lastInvoiceDate))
      .limit(200);
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Vendors</h1>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 bg-white p-12 text-center text-gray-500">
          No vendors yet — they bootstrap automatically as you approve invoices.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Vendor</th>
                <th className="px-4 py-2 text-right">Invoices</th>
                <th className="px-4 py-2 text-right">30-day spend</th>
                <th className="px-4 py-2 text-right">90-day spend</th>
                <th className="px-4 py-2 text-right">Avg amount</th>
                <th className="px-4 py-2 text-left">Last invoice</th>
                <th className="px-4 py-2 text-left">Flags</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const ready = r.invoiceCount >= PROFILE_READY_THRESHOLD;
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-900">{r.name}</div>
                      {r.aliases.length > 0 && (
                        <div className="text-xs text-gray-500">
                          aka {r.aliases.slice(0, 2).join(" · ")}
                          {r.aliases.length > 2 ? ` (+${r.aliases.length - 2})` : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900">
                      {r.invoiceCount}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900">
                      {ready ? r.spend30d : <em className="text-gray-400">—</em>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900">
                      {ready ? r.spend90d : <em className="text-gray-400">—</em>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-900">
                      {ready ? r.avgInvoiceAmount : <em className="text-gray-400">—</em>}
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {r.lastInvoiceDate ?? <em className="text-gray-400">—</em>}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <FlagPills
                        termsDrift={r.termsDriftDetected}
                        duplicates={r.duplicateSubmissionCount}
                        notReady={!ready}
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/vendors/${r.id}`}
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

function FlagPills({
  termsDrift,
  duplicates,
  notReady,
}: {
  termsDrift: boolean;
  duplicates: number;
  notReady: boolean;
}) {
  const pills: React.ReactNode[] = [];
  if (notReady) {
    pills.push(
      <span
        key="warming"
        className="rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-700"
      >
        warming up
      </span>,
    );
  }
  if (termsDrift) {
    pills.push(
      <span
        key="drift"
        className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800"
      >
        terms drift
      </span>,
    );
  }
  if (duplicates > 0) {
    pills.push(
      <span
        key="dup"
        className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800"
      >
        {duplicates} dup
      </span>,
    );
  }
  if (pills.length === 0) return <span className="text-gray-400">—</span>;
  return <div className="flex flex-wrap gap-1">{pills}</div>;
}
