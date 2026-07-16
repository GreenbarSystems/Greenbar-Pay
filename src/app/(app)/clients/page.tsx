import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { clients, extractedInvoices } from "@/db/schema";
import { and, count, eq, sql } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { isMultiClientEnabled } from "@/lib/featureFlags";

export default async function ClientsPage() {
  if (!isMultiClientEnabled()) redirect("/dashboard");

  const session = await auth();
  if (!session?.user) return null;
  const { organizationId, role } = session.user;

  if (!can(role, "clients.manage")) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 bg-white p-12 text-center text-gray-500">
        You do not have permission to manage clients.
      </div>
    );
  }

  const rows = await withOrg(organizationId, async (tx) =>
    tx
      .select({
        id: clients.id,
        name: clients.name,
        slug: clients.slug,
        externalAccountingSystem: clients.externalAccountingSystem,
        createdAt: clients.createdAt,
        invoiceCount: count(extractedInvoices.id),
        pendingCount: sql<number>`count(${extractedInvoices.id}) filter (where ${extractedInvoices.reviewStatus} in ('pending', 'needs_review', 'pending_final_approval'))`,
        approvedCount: sql<number>`count(${extractedInvoices.id}) filter (where ${extractedInvoices.reviewStatus} in ('approved', 'exported'))`,
      })
      .from(clients)
      .leftJoin(
        extractedInvoices,
        and(
          eq(extractedInvoices.clientId, clients.id),
          eq(extractedInvoices.organizationId, organizationId),
        ),
      )
      .where(eq(clients.organizationId, organizationId))
      .groupBy(clients.id)
      .orderBy(clients.name),
  );

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Clients</h1>
        <Link
          href="/clients/new"
          className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800"
        >
          + New client
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-12 text-center text-gray-500">
          No clients yet.{" "}
          <Link href="/clients/new" className="text-green-700 underline">
            Add your first client.
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Slug</th>
                <th className="px-4 py-3 text-left">Accounting system</th>
                <th className="px-4 py-3 text-right">Invoices</th>
                <th className="px-4 py-3 text-right">Pending</th>
                <th className="px-4 py-3 text-right">Approved</th>
                <th className="px-4 py-3 text-left">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{r.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.slug}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {r.externalAccountingSystem ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                    {Number(r.invoiceCount)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={Number(r.pendingCount) > 0 ? "font-medium text-amber-700" : "text-gray-400"}>
                      {Number(r.pendingCount)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-green-700">
                    {Number(r.approvedCount)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {r.createdAt.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
