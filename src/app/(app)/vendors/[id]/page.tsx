/**
 * Vendor profile detail view (Phase 7 — D1).
 *
 * Read-only in MVP per the spec. Surfaces the full longitudinal profile:
 * aliases, derived stats, pricing history, terms-drift flag, duplicate
 * count, recent recompute events.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { withOrg } from "@/db/client";
import ContractsSection from "./ContractsSection";
import { requireUuid } from "@/lib/route-helpers";
import { getVendorDetail, isVendorProfileReady, vendorsModule } from "@/modules/vendors";

export default async function VendorDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const bad = requireUuid(params.id);
  if (bad) notFound();

  const session = await auth();
  if (!session?.user) return null;
  const { organizationId, role, id: userId } = session.user;

  // PR21 H1 — rate-card unit_price + notes are negotiated commercial
  // terms. Gate the activeContractLines fetch behind the same
  // invoice.override permission that admits Upload + Activate in the
  // UI. Computing this up here so the gating decision is uniform
  // across data load + UI affordances.
  const canManageContracts = can(role, "invoice.override");

  const data = await withOrg(organizationId, (tx) =>
    getVendorDetail(tx, vendorsModule, {
      organizationId,
      userId,
      orgRole: role,
      vendorId: params.id,
      canManageContracts,
    }),
  );

  if (!data) notFound();
  const {
    vendor,
    pricing,
    recentApprovedInvoices,
    profileEvents,
    contracts,
    activeContractLines,
  } = data;
  const ready = isVendorProfileReady(vendor.invoiceCount);

  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="mb-5 flex items-center gap-2 text-sm text-gray-500"
      >
        <Link href="/vendors" className="hover:text-gray-900">
          Vendors
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-gray-900">{vendor.name}</span>
      </nav>
      <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{vendor.name}</h1>
        {vendor.aliases.length > 0 && (
          <p className="mt-1 text-sm text-gray-500">
            Also seen as: {vendor.aliases.join(" · ")}
          </p>
        )}
      </div>

      {!ready && (
        <div className="rounded-md border border-gray-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Profile becomes meaningful at 3+ approved invoices — currently at{" "}
          {vendor.invoiceCount}.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Invoice count" value={vendor.invoiceCount} />
        <Card
          label="Last invoice"
          value={vendor.lastInvoiceDate ?? "—"}
        />
        <Card
          label="Default terms"
          value={vendor.defaultPaymentTerms ?? "—"}
          hint={vendor.termsDriftDetected ? "drift detected" : undefined}
        />
        <Card
          label="Duplicates flagged"
          value={vendor.duplicateSubmissionCount}
        />
        <Card label="30-day spend" value={ready ? vendor.spend30d : "—"} />
        <Card label="90-day spend" value={ready ? vendor.spend90d : "—"} />
        <Card label="Avg amount" value={ready ? vendor.avgInvoiceAmount : "—"} />
        <Card
          label="Profile updated"
          value={
            vendor.lastProfileUpdated
              ? vendor.lastProfileUpdated.toISOString().slice(0, 16).replace("T", " ")
              : "—"
          }
        />
      </div>

      {/* PR20 — pricing baselines gated on invoice.approve. Per-vendor
          avg/stddev figures are vendor-attributable financial signal;
          showing them to viewer-only roles widened the internal info-
          disclosure surface beyond what PR11 H7 / PR16 M3 narrowed for
          the confidence reason + coaching panel. Same gate pattern. */}
      {can(role, "invoice.approve") && (
      <Section title="Pricing history">
        {pricing.length === 0 ? (
          <p className="text-xs text-gray-500">
            No line-item history yet. Approves contribute to this on every recompute.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Item keyword</th>
                <th className="px-3 py-2 text-right">Avg unit price</th>
                <th className="px-3 py-2 text-right">Samples</th>
                <th className="px-3 py-2 text-left">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pricing.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-1.5 font-mono text-gray-900">{p.itemKeyword}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-900">{p.avgUnitPrice}</td>
                  <td className="px-3 py-1.5 text-right text-gray-700">{p.samples}</td>
                  <td className="px-3 py-1.5 text-gray-600">
                    {p.lastSeenAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      )}

      {/* Phase 9.5 PR4 — D3 second-half UI. Surfaces the vendor's
          contracts (active + extracted + superseded) with an
          expanded rate card for the active one. Upload + activate
          actions are gated by invoice.override so only admin/owner
          can mutate the contract surface (matches the activate
          endpoint's gate). */}
      <ContractsSection
        vendorId={vendor.id}
        clientId={vendor.clientId}
        contracts={contracts.map((c) => ({
          id: c.id,
          status: c.status,
          contractNumber: c.contractNumber,
          effectiveDate: c.effectiveDate,
          expiryDate: c.expiryDate,
          paymentTerms: c.paymentTerms,
          currency: c.currency,
          confidence: c.confidence,
          earlyPaymentDiscountPct: c.earlyPaymentDiscountPct,
          earlyPaymentDiscountDays: c.earlyPaymentDiscountDays,
          documentId: c.documentId,
          createdAt: c.createdAt.toISOString(),
          supersededAt: c.supersededAt?.toISOString() ?? null,
        }))}
        activeLines={activeContractLines.map((l) => ({
          id: l.id,
          description: l.description,
          itemKeyword: l.itemKeyword,
          unitPrice: l.unitPrice,
          currency: l.currency,
          priceBasis: l.priceBasis,
          minQuantity: l.minQuantity,
          maxQuantity: l.maxQuantity,
          notes: l.notes,
        }))}
        canManage={canManageContracts}
      />

      <Section title="Recent approved invoices">
        {recentApprovedInvoices.length === 0 ? (
          <p className="text-xs text-gray-500">None yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Invoice #</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recentApprovedInvoices.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-1.5 font-mono text-gray-900">{r.invoiceNumber ?? "—"}</td>
                  <td className="px-3 py-1.5 text-gray-700">{r.invoiceDate ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-900">{r.total ?? "—"}</td>
                  <td className="px-3 py-1.5 text-gray-700">{r.reviewStatus}</td>
                  <td className="px-3 py-1.5 text-right">
                    <a
                      href={`/review/${r.id}`}
                      aria-label={`Open invoice${r.invoiceNumber ? ` ${r.invoiceNumber}` : ""} from ${vendor.name}`}
                      className="text-xs underline text-gray-700 hover:text-gray-900"
                    >
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <details className="rounded-md border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          Profile event log ({profileEvents.length})
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-gray-700">
          {profileEvents.map((e) => (
            <li key={e.id} className="flex justify-between">
              <span className="font-mono">{e.action}</span>
              <span className="text-gray-500">
                {e.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-gray-700">{title}</h2>
      {children}
    </div>
  );
}

function Card({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-gray-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-amber-700">{hint}</p>}
    </div>
  );
}
