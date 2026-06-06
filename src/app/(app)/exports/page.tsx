import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { exports as exportsTable, users } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export default async function ExportsPage() {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId } = session.user;

  const rows = await withOrg(organizationId, async (tx) => {
    return tx
      .select({
        id: exportsTable.id,
        format: exportsTable.format,
        status: exportsTable.status,
        itemCount: exportsTable.itemCount,
        fileSizeBytes: exportsTable.fileSizeBytes,
        createdAt: exportsTable.createdAt,
        completedAt: exportsTable.completedAt,
        createdByEmail: users.email,
        errorMessage: exportsTable.errorMessage,
      })
      .from(exportsTable)
      .leftJoin(users, eq(users.id, exportsTable.createdBy))
      .where(eq(exportsTable.organizationId, organizationId))
      .orderBy(desc(exportsTable.createdAt))
      .limit(100);
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Exports</h1>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 bg-white p-12 text-center text-gray-500">
          No exports yet. Approve some invoices and export them from the{" "}
          <a className="underline" href="/review?status=approved">
            review queue
          </a>
          .
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-left">By</th>
                <th className="px-4 py-2 text-left">Format</th>
                <th className="px-4 py-2 text-right">Items</th>
                <th className="px-4 py-2 text-right">Size</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 text-gray-700">
                    {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{r.createdByEmail ?? "—"}</td>
                  <td className="px-4 py-2 font-mono uppercase text-gray-700">{r.format}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-900">{r.itemCount}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-600">
                    {formatBytes(r.fileSizeBytes)}
                  </td>
                  <td className="px-4 py-2">
                    <ExportStatusBadge status={r.status} error={r.errorMessage} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {r.status === "completed" ? (
                      <a
                        href={`/api/ap/exports/${r.id}/download`}
                        className="text-sm font-medium text-gray-900 underline hover:text-gray-700"
                      >
                        Download
                      </a>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
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

function ExportStatusBadge({ status, error }: { status: string; error: string | null }) {
  const color =
    status === "completed"
      ? "bg-green-100 text-green-800"
      : status === "failed"
        ? "bg-red-100 text-red-800"
        : status === "running"
          ? "bg-blue-100 text-blue-800"
          : "bg-gray-100 text-gray-700";
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}
      title={error ?? undefined}
    >
      {status}
    </span>
  );
}

function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
