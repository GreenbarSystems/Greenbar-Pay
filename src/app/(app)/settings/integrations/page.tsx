/**
 * Settings > Integrations — QBO and Xero connection management.
 *
 * Server component: reads connection status and renders connect/disconnect
 * buttons. OAuth flows are redirect-based; disconnect is a client-side
 * DELETE fetch (see DisconnectButton.tsx).
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { DisconnectButton } from "./DisconnectButton";

interface PageProps {
  searchParams: { connected?: string; error?: string };
}

export default async function IntegrationsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const { organizationId } = session.user;

  const connections = await withOrg(organizationId, (tx) =>
    tx
      .select({
        provider: accountingConnections.provider,
        settings: accountingConnections.settings,
      })
      .from(accountingConnections)
      .where(
        and(
          eq(accountingConnections.organizationId, organizationId),
          eq(accountingConnections.isActive, true),
        ),
      ),
  );

  const qboConn = connections.find((c) => c.provider === "qbo");
  const xeroConn = connections.find((c) => c.provider === "xero");
  const netsuiteConn = connections.find((c) => c.provider === "netsuite");
  const intacctConn = connections.find((c) => c.provider === "intacct");

  const qboSettings = (qboConn?.settings ?? {}) as { companyName?: string };
  const xeroSettings = (xeroConn?.settings ?? {}) as { tenantName?: string };
  const netsuiteSettings = (netsuiteConn?.settings ?? {}) as { companyName?: string };
  const intacctSettings = (intacctConn?.settings ?? {}) as { companyName?: string };

  const successMsg =
    searchParams.connected === "qbo"
      ? "QuickBooks Online connected successfully."
      : searchParams.connected === "xero"
        ? "Xero connected successfully."
        : searchParams.connected === "netsuite"
          ? "NetSuite connected successfully."
          : searchParams.connected === "intacct"
            ? "Sage Intacct connected successfully."
            : null;

  const errorMsg = searchParams.error ? errorLabel(searchParams.error) : null;

  return (
    <div>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Integrations</h2>
      <p className="mb-6 text-sm text-gray-500">
        Connect your accounting software to sync approved invoices directly as bills.
      </p>

      {successMsg && (
        <div className="mb-6 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMsg}
        </div>
      )}

      <div className="space-y-3">
        <IntegrationCard
          name="QuickBooks Online"
          description="Sync approved invoices as Bills in your QBO company."
          logo={<QboLogo />}
          isConnected={!!qboConn}
          connectedLabel={qboSettings.companyName ?? "Connected"}
          connectHref="/api/integrations/qbo/connect"
          disconnectAction="/api/integrations/qbo/disconnect"
        />

        <IntegrationCard
          name="Xero"
          description="Sync approved invoices as Accounts Payable bills in Xero."
          logo={<XeroLogo />}
          isConnected={!!xeroConn}
          connectedLabel={xeroSettings.tenantName ?? "Connected"}
          connectHref="/api/integrations/xero/connect"
          disconnectAction="/api/integrations/xero/disconnect"
        />

        <IntegrationCard
          name="NetSuite"
          description="Sync approved invoices as Vendor Bills in Oracle NetSuite."
          logo={<NetsuiteLogo />}
          isConnected={!!netsuiteConn}
          connectedLabel={netsuiteSettings.companyName ?? "Connected"}
          connectHref="/api/integrations/netsuite/connect"
          disconnectAction="/api/integrations/netsuite/disconnect"
        />

        <IntegrationCard
          name="Sage Intacct"
          description="Sync approved invoices as AP Bills in Sage Intacct."
          logo={<IntacctLogo />}
          isConnected={!!intacctConn}
          connectedLabel={intacctSettings.companyName ?? "Connected"}
          connectHref="/settings/integrations/intacct"
          disconnectAction="/api/integrations/intacct/disconnect"
        />
      </div>
    </div>
  );
}

function IntegrationCard({
  name,
  description,
  logo,
  isConnected,
  connectedLabel,
  connectHref,
  disconnectAction,
}: {
  name: string;
  description: string;
  logo: React.ReactNode;
  isConnected: boolean;
  connectedLabel: string;
  connectHref: string;
  disconnectAction: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md border border-gray-100 bg-gray-50">
          {logo}
        </div>
        <div>
          <p className="font-medium text-gray-900">{name}</p>
          <p className="text-sm text-gray-500">{description}</p>
          {isConnected && (
            <p className="mt-0.5 text-xs text-green-700">
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green-500 align-middle" />
              {connectedLabel}
            </p>
          )}
        </div>
      </div>
      <div className="ml-4 shrink-0">
        {isConnected ? (
          <DisconnectButton action={disconnectAction} label={name} />
        ) : (
          <Link
            href={connectHref}
            className="rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800"
          >
            Connect
          </Link>
        )}
      </div>
    </div>
  );
}

function QboLogo() {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#2CA01C" />
      <text x="16" y="22" fontSize="14" fontWeight="bold" fill="white" textAnchor="middle">Q</text>
    </svg>
  );
}

function XeroLogo() {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#13B5EA" />
      <text x="16" y="22" fontSize="14" fontWeight="bold" fill="white" textAnchor="middle">X</text>
    </svg>
  );
}

function NetsuiteLogo() {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#CC0000" />
      <text x="16" y="22" fontSize="14" fontWeight="bold" fill="white" textAnchor="middle">N</text>
    </svg>
  );
}

function IntacctLogo() {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#00A86B" />
      <text x="16" y="22" fontSize="14" fontWeight="bold" fill="white" textAnchor="middle">SI</text>
    </svg>
  );
}

function errorLabel(code: string): string {
  const labels: Record<string, string> = {
    missing_params: "Authorization was incomplete. Please try again.",
    state_expired: "The connection request timed out. Please try again.",
    state_invalid: "The connection request was invalid. Please try again.",
    state_mismatch: "The connection request was tampered with. Please try again.",
    token_exchange_failed: "Could not exchange the authorization code. Please try again.",
    tenant_lookup_failed: "Could not retrieve the Xero organization. Please try again.",
    access_denied: "Authorization was denied. Please try again and allow access when prompted.",
  };
  return labels[code] ?? "An error occurred during the connection. Please try again.";
}
