import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { documents } from "@/db/schema";
import { desc, eq, and } from "drizzle-orm";

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "received", label: "Received" },
  { key: "processing", label: "Processing" },
  { key: "review_required", label: "Needs Review" },
  { key: "approved", label: "Approved" },
  { key: "exported", label: "Exported" },
  { key: "rejected", label: "Rejected" },
] as const;

type Status = (typeof STATUS_TABS)[number]["key"];

export default async function InboxPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const session = await auth();
  if (!session?.user) return null;
  const { organizationId } = session.user;

  const active: Status =
    (STATUS_TABS.find((t) => t.key === searchParams.status)?.key as Status) ?? "all";

  const rows = await withOrg(organizationId, async (tx) => {
    return tx
      .select({
        id: documents.id,
        filename: documents.originalFilename,
        status: documents.status,
        source: documents.source,
        receivedAt: documents.receivedAt,
      })
      .from(documents)
      .where(
        active === "all"
          ? eq(documents.organizationId, organizationId)
          : and(
              eq(documents.organizationId, organizationId),
              eq(documents.status, active),
            ),
      )
      .orderBy(desc(documents.receivedAt))
      .limit(100);
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">AP Inbox</h1>
        <a
          href="/upload"
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
        >
          Upload invoice
        </a>
      </div>

      <nav className="mb-4 flex gap-1 border-b border-gray-200 text-sm">
        {STATUS_TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <a
              key={t.key}
              href={`/inbox?status=${t.key}`}
              className={
                isActive
                  ? "border-b-2 border-gray-900 px-3 py-2 font-medium text-gray-900"
                  : "border-b-2 border-transparent px-3 py-2 text-gray-600 hover:text-gray-900"
              }
            >
              {t.label}
            </a>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 bg-white p-12 text-center text-gray-500">
          No documents yet. <a href="/upload" className="text-gray-900 underline">Upload an invoice</a> to get started.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">File</th>
                <th className="px-4 py-2 text-left">Source</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 font-medium text-gray-900">{r.filename}</td>
                  <td className="px-4 py-2 text-gray-600">{r.source}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {r.receivedAt.toISOString().slice(0, 16).replace("T", " ")}
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

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "approved" || status === "exported"
      ? "bg-green-100 text-green-800"
      : status === "rejected" || status === "failed"
        ? "bg-red-100 text-red-800"
        : status === "review_required" || status === "validation_failed"
          ? "bg-amber-100 text-amber-800"
          : "bg-gray-100 text-gray-700";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  );
}
