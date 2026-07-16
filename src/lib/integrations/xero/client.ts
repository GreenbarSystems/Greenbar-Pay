/**
 * Xero API client.
 *
 * Handles token refresh, contact (vendor) lookup/create, and Bill
 * (ACCPAY Invoice) creation. Xero uses "Invoices" for both AR and AP;
 * AP bills use Type = "ACCPAY".
 */
import { decryptToken, encryptToken } from "@/lib/integrations/tokens";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { and, eq } from "drizzle-orm";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";

export const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
export const XERO_SCOPES = "accounting.transactions accounting.contacts offline_access openid profile email";

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshXeroTokens(
  organizationId: string,
  connectionId: string,
  encryptedRefreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const clientId = process.env.XERO_CLIENT_ID!;
  const clientSecret = process.env.XERO_CLIENT_SECRET!;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decryptToken(encryptedRefreshToken),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Xero token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await withOrg(organizationId, async (tx) => {
    await tx
      .update(accountingConnections)
      .set({
        accessToken: encryptToken(data.access_token),
        refreshToken: encryptToken(data.refresh_token),
        tokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(accountingConnections.id, connectionId),
          eq(accountingConnections.organizationId, organizationId),
        ),
      );
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}

// ── Authenticated fetch ───────────────────────────────────────────────────────

async function fetchXero(
  tenantId: string,
  path: string,
  init: RequestInit,
  accessToken: string,
): Promise<Response> {
  return fetch(`${XERO_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

// ── Contact (vendor) lookup / create ─────────────────────────────────────────

export async function findOrCreateContact(
  tenantId: string,
  accessToken: string,
  vendorName: string,
): Promise<string> {
  // Xero contact search by name.
  const searchRes = await fetchXero(
    tenantId,
    `/Contacts?where=Name%3D%22${encodeURIComponent(vendorName)}%22&summaryOnly=true`,
    { method: "GET" },
    accessToken,
  );

  if (searchRes.ok) {
    const body = await searchRes.json() as {
      Contacts?: Array<{ ContactID: string }>;
    };
    const existing = body.Contacts?.[0];
    if (existing?.ContactID) return existing.ContactID;
  }

  // Create contact.
  const createRes = await fetchXero(
    tenantId,
    "/Contacts",
    {
      method: "POST",
      body: JSON.stringify({ Contacts: [{ Name: vendorName }] }),
    },
    accessToken,
  );

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Xero contact create failed (${createRes.status}): ${err.slice(0, 200)}`);
  }

  const created = await createRes.json() as {
    Contacts: Array<{ ContactID: string }>;
  };
  const contactId = created.Contacts[0]?.ContactID;
  if (!contactId) throw new Error("Xero contact create returned no ContactID");
  return contactId;
}

// ── Bill (ACCPAY Invoice) creation ────────────────────────────────────────────

export interface XeroBillInput {
  vendorName: string;
  total: number;
  invoiceDate: string | null;  // YYYY-MM-DD
  dueDate: string | null;
  invoiceNumber: string | null;
  currency: string;
  lineItems: Array<{
    description: string | null;
    amount: number;
  }>;
}

export interface XeroBillResult {
  invoiceId: string;
  invoiceNumber: string;
}

export async function createXeroBill(
  tenantId: string,
  accessToken: string,
  input: XeroBillInput,
): Promise<XeroBillResult> {
  const contactId = await findOrCreateContact(tenantId, accessToken, input.vendorName ?? "Unknown Vendor");

  const lineItems = input.lineItems.length > 0
    ? input.lineItems.map((li) => ({
        Description: li.description ?? "Invoice line",
        Quantity: 1,
        UnitAmount: li.amount,
      }))
    : [
        {
          Description: input.invoiceNumber
            ? `Invoice ${input.invoiceNumber}`
            : "Invoice",
          Quantity: 1,
          UnitAmount: input.total,
        },
      ];

  const bill: Record<string, unknown> = {
    Type: "ACCPAY",
    Contact: { ContactID: contactId },
    LineItems: lineItems,
    CurrencyCode: input.currency || "USD",
    Status: "DRAFT",
  };

  if (input.invoiceDate) bill["Date"] = input.invoiceDate;
  if (input.dueDate) bill["DueDate"] = input.dueDate;
  if (input.invoiceNumber) bill["Reference"] = input.invoiceNumber;

  const res = await fetchXero(
    tenantId,
    "/Invoices",
    { method: "POST", body: JSON.stringify({ Invoices: [bill] }) },
    accessToken,
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Xero bill create failed (${res.status}): ${err.slice(0, 300)}`);
  }

  const data = await res.json() as {
    Invoices: Array<{ InvoiceID: string; InvoiceNumber: string }>;
  };
  const created = data.Invoices[0];
  if (!created?.InvoiceID) throw new Error("Xero bill create returned no InvoiceID");

  return {
    invoiceId: created.InvoiceID,
    invoiceNumber: created.InvoiceNumber ?? "",
  };
}

// ── OAuth token exchange ──────────────────────────────────────────────────────

export async function exchangeXeroCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const clientId = process.env.XERO_CLIENT_ID!;
  const clientSecret = process.env.XERO_CLIENT_SECRET!;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Xero code exchange failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

// ── Tenant lookup (first connected org) ──────────────────────────────────────

export async function getXeroTenantId(accessToken: string): Promise<{
  tenantId: string;
  tenantName: string;
}> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });

  if (!res.ok) throw new Error("Failed to fetch Xero connections");

  const connections = await res.json() as Array<{
    tenantId: string;
    tenantName: string;
    tenantType: string;
  }>;

  // Use the first ORGANISATION connection.
  const org = connections.find((c) => c.tenantType === "ORGANISATION") ?? connections[0];
  if (!org) throw new Error("No Xero organisation found on this connection");

  return { tenantId: org.tenantId, tenantName: org.tenantName };
}
