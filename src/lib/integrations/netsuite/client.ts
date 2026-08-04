/**
 * NetSuite REST API client.
 *
 * OAuth 2.0 + PKCE flow (identical PKCE helpers as QBO/Xero). After the
 * token exchange, calls the NetSuite userinfo endpoint to discover the
 * account ID — no env var required per-org; the account ID is stored in
 * accounting_connections.realm_id and used to construct per-org API URLs.
 *
 * REST API base: https://{accountId}.suitetalk.api.netsuite.com/services/rest
 * Vendor lookup: SuiteQL POST /query/v1/suiteql
 * Vendor Bill:   POST /record/v1/vendorBill
 */
import { decryptToken, encryptToken } from "@/lib/integrations/tokens";
import { withOrg } from "@/db/client";
import { accountingConnections } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const NETSUITE_AUTH_URL =
  "https://system.netsuite.com/app/login/oauth2/authorize.nl";
const NETSUITE_TOKEN_URL =
  "https://system.netsuite.com/app/login/oauth2/token.nl";
const NETSUITE_USERINFO_URL =
  "https://system.netsuite.com/app/login/oauth2/userinfo.nl";

export const NETSUITE_SCOPES = "rest_webservices";

// ── Account ID helpers ────────────────────────────────────────────────────────

/**
 * NetSuite REST API URLs use the account ID as a subdomain with underscores
 * replaced by dashes and the whole string lowercased.
 * e.g. "TSTDRV1234567_SB1" → "tstdrv1234567-sb1"
 */
function formatAccountId(accountId: string): string {
  return accountId.toLowerCase().replace(/_/g, "-");
}

function netsuiteApiBase(accountId: string): string {
  return `https://${formatAccountId(accountId)}.suitetalk.api.netsuite.com/services/rest`;
}

// ── Authenticated fetch ───────────────────────────────────────────────────────

async function fetchNetsuite(
  accountId: string,
  path: string,
  init: RequestInit,
  accessToken: string,
): Promise<Response> {
  return fetch(`${netsuiteApiBase(accountId)}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
}

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshNetsuiteTokens(
  organizationId: string,
  connectionId: string,
  encryptedRefreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const clientId = process.env.NETSUITE_CLIENT_ID!;
  const clientSecret = process.env.NETSUITE_CLIENT_SECRET!;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(NETSUITE_TOKEN_URL, {
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
    throw new Error(
      `NetSuite token refresh failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as {
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

// ── Vendor lookup / create ─────────────────────────────────────────────────────

export async function findOrCreateNetsuiteVendor(
  accountId: string,
  accessToken: string,
  vendorName: string,
): Promise<string> {
  // SuiteQL lookup — case-insensitive name match.
  const suiteqlRes = await fetchNetsuite(
    accountId,
    "/query/v1/suiteql",
    {
      method: "POST",
      headers: { prefer: "transient" },
      body: JSON.stringify({
        q: `SELECT id, entityid FROM vendor WHERE LOWER(entityid) = LOWER('${vendorName.replace(/'/g, "''")}') LIMIT 1`,
      }),
    },
    accessToken,
  );

  if (suiteqlRes.ok) {
    const body = (await suiteqlRes.json()) as {
      items?: Array<{ id: string }>;
    };
    const found = body.items?.[0];
    if (found?.id) return found.id;
  }

  // Create vendor.
  const createRes = await fetchNetsuite(
    accountId,
    "/record/v1/vendor",
    {
      method: "POST",
      body: JSON.stringify({ entityid: vendorName, isperson: false }),
    },
    accessToken,
  );

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(
      `NetSuite vendor create failed (${createRes.status}): ${err.slice(0, 200)}`,
    );
  }

  // NetSuite REST returns 204 with a Location header for create operations.
  const location = createRes.headers.get("location") ?? "";
  const idMatch = location.match(/\/vendor\/(\d+)/);
  if (!idMatch) {
    throw new Error(`NetSuite vendor create: could not parse ID from Location: ${location}`);
  }
  return idMatch[1];
}

// ── Vendor Bill creation ───────────────────────────────────────────────────────

export interface NetsuiteBillInput {
  vendorName: string;
  total: number;
  invoiceDate: string | null;  // YYYY-MM-DD
  dueDate: string | null;
  invoiceNumber: string | null;
  currency: string;
  defaultExpenseAccountId?: string | null;
  lineItems: Array<{ description: string | null; amount: number }>;
}

export interface NetsuiteBillResult {
  billId: string;
}

export async function createNetsuiteBill(
  accountId: string,
  accessToken: string,
  input: NetsuiteBillInput,
): Promise<NetsuiteBillResult> {
  const vendorId = await findOrCreateNetsuiteVendor(
    accountId,
    accessToken,
    input.vendorName || "Unknown Vendor",
  );

  const expenses =
    input.lineItems.length > 0
      ? input.lineItems.map((li) => ({
          ...(input.defaultExpenseAccountId
            ? { account: { id: input.defaultExpenseAccountId } }
            : {}),
          amount: li.amount,
          memo: li.description ?? "",
        }))
      : [
          {
            ...(input.defaultExpenseAccountId
              ? { account: { id: input.defaultExpenseAccountId } }
              : {}),
            amount: input.total,
            memo: input.invoiceNumber
              ? `Invoice ${input.invoiceNumber}`
              : "Invoice",
          },
        ];

  const bill: Record<string, unknown> = {
    entity: { id: vendorId },
    memo: `Synced from Greenbar AP Assurance${input.invoiceNumber ? ` · Invoice ${input.invoiceNumber}` : ""}`,
    expenselist: { expense: expenses },
  };

  if (input.invoiceDate) bill["trandate"] = input.invoiceDate;
  if (input.dueDate) bill["duedate"] = input.dueDate;
  if (input.currency && input.currency !== "USD") {
    bill["currency"] = { refName: input.currency };
  }

  const res = await fetchNetsuite(
    accountId,
    "/record/v1/vendorBill",
    { method: "POST", body: JSON.stringify(bill) },
    accessToken,
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `NetSuite vendorBill create failed (${res.status}): ${err.slice(0, 300)}`,
    );
  }

  const location = res.headers.get("location") ?? "";
  const idMatch = location.match(/\/vendorBill\/(\d+)/);
  if (!idMatch) {
    throw new Error(
      `NetSuite vendorBill create: could not parse ID from Location: ${location}`,
    );
  }

  return { billId: idMatch[1] };
}

// ── OAuth token exchange ──────────────────────────────────────────────────────

export async function exchangeNetsuiteCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  accountId: string;
}> {
  const clientId = process.env.NETSUITE_CLIENT_ID!;
  const clientSecret = process.env.NETSUITE_CLIENT_SECRET!;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(NETSUITE_TOKEN_URL, {
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
    throw new Error(
      `NetSuite code exchange failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Discover the account ID from the userinfo endpoint.
  const accountId = await getNetsuiteAccountId(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    accountId,
  };
}

// ── Account / company discovery ───────────────────────────────────────────────

/**
 * NetSuite userinfo returns { sub: "userId@accountId", ... }.
 * The account ID is the part after the @.
 */
async function getNetsuiteAccountId(accessToken: string): Promise<string> {
  const res = await fetch(NETSUITE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`NetSuite userinfo failed (${res.status})`);
  const data = (await res.json()) as { sub?: string };
  const accountId = data.sub?.split("@")[1];
  if (!accountId) throw new Error("NetSuite userinfo: could not parse account ID from sub");
  return accountId;
}

export async function getNetsuiteCompanyName(
  accountId: string,
  accessToken: string,
): Promise<string> {
  const res = await fetchNetsuite(
    accountId,
    "/query/v1/suiteql",
    {
      method: "POST",
      headers: { prefer: "transient" },
      body: JSON.stringify({
        q: "SELECT companyname FROM companyinformation LIMIT 1",
      }),
    },
    accessToken,
  );
  if (!res.ok) return "NetSuite";
  const data = (await res.json()) as {
    items?: Array<{ companyname?: string }>;
  };
  return data.items?.[0]?.companyname ?? "NetSuite";
}
