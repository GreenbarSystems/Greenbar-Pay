/**
 * QuickBooks Online API client.
 *
 * Handles token refresh, vendor lookup/create, and Bill creation.
 * All API calls go through fetchQbo() which injects the Bearer token
 * and auto-refreshes on 401.
 */
import { decryptToken, encryptToken } from "@/lib/integrations/tokens";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { and, eq } from "drizzle-orm";

const QBO_BASE = process.env.QBO_SANDBOX === "true"
  ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
  : "https://quickbooks.api.intuit.com/v3/company";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export const QBO_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_SCOPES = "com.intuit.quickbooks.accounting";

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshQboTokens(
  organizationId: string,
  connectionId: string,
  encryptedRefreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const clientId = process.env.QBO_CLIENT_ID!;
  const clientSecret = process.env.QBO_CLIENT_SECRET!;
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
    throw new Error(`QBO token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  // Persist updated tokens.
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

async function fetchQbo(
  realmId: string,
  path: string,
  init: RequestInit,
  accessToken: string,
): Promise<Response> {
  return fetch(`${QBO_BASE}/${realmId}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

// ── Vendor (Supplier) lookup / create ────────────────────────────────────────

export async function findOrCreateVendor(
  realmId: string,
  accessToken: string,
  vendorName: string,
): Promise<string> {
  // QBO query API — find by DisplayName exact match.
  const escaped = vendorName.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `SELECT * FROM Vendor WHERE DisplayName = '${escaped}' MAXRESULTS 1`,
  );
  const queryRes = await fetchQbo(
    realmId,
    `/query?query=${query}&minorversion=65`,
    { method: "GET" },
    accessToken,
  );

  if (queryRes.ok) {
    const body = await queryRes.json() as {
      QueryResponse?: { Vendor?: Array<{ Id: string }> };
    };
    const existing = body.QueryResponse?.Vendor?.[0];
    if (existing?.Id) return existing.Id;
  }

  // Create the vendor.
  const createRes = await fetchQbo(
    realmId,
    "/vendor?minorversion=65",
    {
      method: "POST",
      body: JSON.stringify({ DisplayName: vendorName }),
    },
    accessToken,
  );

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`QBO vendor create failed (${createRes.status}): ${err.slice(0, 200)}`);
  }

  const created = await createRes.json() as { Vendor: { Id: string } };
  return created.Vendor.Id;
}

// ── Bill creation ─────────────────────────────────────────────────────────────

export interface QboBillInput {
  vendorName: string;
  total: number;
  invoiceDate: string | null;   // YYYY-MM-DD
  dueDate: string | null;
  invoiceNumber: string | null;
  currency: string;
  /** QBO expense account ID from org settings. If absent, line has no AccountRef. */
  defaultExpenseAccountId?: string | null;
  lineItems: Array<{
    description: string | null;
    amount: number;
  }>;
}

export interface QboBillResult {
  billId: string;
  docNumber: string;
}

export async function createQboBill(
  realmId: string,
  accessToken: string,
  input: QboBillInput,
): Promise<QboBillResult> {
  const vendorId = await findOrCreateVendor(realmId, accessToken, input.vendorName ?? "Unknown Vendor");

  const lines = input.lineItems.length > 0
    ? input.lineItems.map((li) => ({
        Amount: li.amount,
        DetailType: "AccountBasedExpenseLineDetail",
        Description: li.description ?? "",
        AccountBasedExpenseLineDetail: {
          ...(input.defaultExpenseAccountId
            ? { AccountRef: { value: input.defaultExpenseAccountId } }
            : {}),
          BillableStatus: "NotBillable",
        },
      }))
    : [
        {
          Amount: input.total,
          DetailType: "AccountBasedExpenseLineDetail",
          Description: input.invoiceNumber
            ? `Invoice ${input.invoiceNumber}`
            : "Invoice",
          AccountBasedExpenseLineDetail: {
            ...(input.defaultExpenseAccountId
              ? { AccountRef: { value: input.defaultExpenseAccountId } }
              : {}),
            BillableStatus: "NotBillable",
          },
        },
      ];

  const bill: Record<string, unknown> = {
    VendorRef: { value: vendorId },
    Line: lines,
    PrivateNote: `Synced from Greenbar AP Assurance${input.invoiceNumber ? ` · Invoice ${input.invoiceNumber}` : ""}`,
  };

  if (input.invoiceDate) bill["TxnDate"] = input.invoiceDate;
  if (input.dueDate) bill["DueDate"] = input.dueDate;
  if (input.currency && input.currency !== "USD") {
    bill["CurrencyRef"] = { value: input.currency };
  }
  if (input.invoiceNumber) bill["DocNumber"] = input.invoiceNumber;

  const res = await fetchQbo(
    realmId,
    "/bill?minorversion=65",
    { method: "POST", body: JSON.stringify(bill) },
    accessToken,
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`QBO bill create failed (${res.status}): ${err.slice(0, 300)}`);
  }

  const data = await res.json() as { Bill: { Id: string; DocNumber: string } };
  return { billId: data.Bill.Id, docNumber: data.Bill.DocNumber ?? "" };
}

// ── OAuth token exchange ──────────────────────────────────────────────────────

export async function exchangeQboCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  realmId: string;
}> {
  const clientId = process.env.QBO_CLIENT_ID!;
  const clientSecret = process.env.QBO_CLIENT_SECRET!;
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
    throw new Error(`QBO code exchange failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    realmId?: string;
    x_refresh_token_expires_in?: number;
  };

  // realmId also comes in the callback URL as a query param; caller merges.
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    realmId: data.realmId ?? "",
  };
}

// ── Company info (used for display name in settings) ─────────────────────────

export async function getQboCompanyName(
  realmId: string,
  accessToken: string,
): Promise<string> {
  const res = await fetchQbo(
    realmId,
    `/companyinfo/${realmId}?minorversion=65`,
    { method: "GET" },
    accessToken,
  );
  if (!res.ok) return "QuickBooks Company";
  const data = await res.json() as { CompanyInfo?: { CompanyName?: string } };
  return data.CompanyInfo?.CompanyName ?? "QuickBooks Company";
}
