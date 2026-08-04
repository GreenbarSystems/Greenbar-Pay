/**
 * Sage Intacct XML Web Services client.
 *
 * Intacct uses a proprietary XML API rather than standard OAuth 2.0.
 * Authentication: the app's sender credentials (INTACCT_SENDER_ID /
 * INTACCT_SENDER_PASSWORD) are registered with Sage as a partner, and each
 * customer provides their own Company ID + User ID + User Password.
 *
 * "Connect" flow: POST credentials to /api/integrations/intacct/connect;
 * validated via getIntacctSession. Session tokens are stored as access_token
 * and refreshed on expiry by re-authenticating with the stored user credentials
 * (kept encrypted as refresh_token JSON).
 *
 * AP Bill creation uses the APBILL create operation.
 */

const INTACCT_ENDPOINT = "https://api.intacct.com/ia/xml/xmlgw.php";

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractXmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match ? match[1].trim() : null;
}

function controlId(): string {
  return `greenbar-${Date.now()}`;
}

// ── Session management ────────────────────────────────────────────────────────

export interface IntacctCredentials {
  companyId: string;
  userId: string;
  userPassword: string;
}

export interface IntacctSession {
  sessionId: string;
  expiresAt: Date;
}

export async function getIntacctSession(
  creds: IntacctCredentials,
): Promise<IntacctSession> {
  const senderId = process.env.INTACCT_SENDER_ID;
  const senderPassword = process.env.INTACCT_SENDER_PASSWORD;
  if (!senderId || !senderPassword) {
    throw new Error("INTACCT_SENDER_ID / INTACCT_SENDER_PASSWORD are not configured");
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${senderId}</senderid>
    <password>${senderPassword}</password>
    <controlid>${controlId()}</controlid>
    <uniqueid>false</uniqueid>
    <dtdversion>3.0</dtdversion>
  </control>
  <operation>
    <authentication>
      <login>
        <userid>${creds.userId}</userid>
        <companyid>${creds.companyId}</companyid>
        <password>${creds.userPassword}</password>
      </login>
    </authentication>
    <content>
      <function controlid="getSession">
        <getAPISession/>
      </function>
    </content>
  </operation>
</request>`;

  const res = await fetch(INTACCT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body,
  });

  const xml = await res.text();
  const status = extractXmlValue(xml, "status");

  if (status !== "success") {
    const description = extractXmlValue(xml, "description") ?? extractXmlValue(xml, "errorno") ?? "unknown error";
    throw new Error(`Intacct authentication failed: ${description}`);
  }

  const sessionId = extractXmlValue(xml, "sessionid");
  if (!sessionId) throw new Error("Intacct: sessionid missing from response");

  // Sessions last 8 hours by default; store expiry conservatively at 7.5 hours.
  return { sessionId, expiresAt: new Date(Date.now() + 7.5 * 60 * 60 * 1000) };
}

// ── Session refresh (re-authenticates with stored credentials) ────────────────

export async function refreshIntacctSession(
  credsJson: string,
): Promise<IntacctSession> {
  const creds = JSON.parse(credsJson) as IntacctCredentials;
  return getIntacctSession(creds);
}

// ── Authenticated XML request ─────────────────────────────────────────────────

async function callIntacct(sessionId: string, content: string): Promise<string> {
  const senderId = process.env.INTACCT_SENDER_ID!;
  const senderPassword = process.env.INTACCT_SENDER_PASSWORD!;

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${senderId}</senderid>
    <password>${senderPassword}</password>
    <controlid>${controlId()}</controlid>
    <uniqueid>false</uniqueid>
    <dtdversion>3.0</dtdversion>
  </control>
  <operation>
    <authentication>
      <sessionid>${sessionId}</sessionid>
    </authentication>
    <content>${content}</content>
  </operation>
</request>`;

  const res = await fetch(INTACCT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body,
  });

  const xml = await res.text();
  const status = extractXmlValue(xml, "status");
  if (status !== "success") {
    const description = extractXmlValue(xml, "description") ?? extractXmlValue(xml, "errorno") ?? "unknown error";
    throw new Error(`Intacct API error: ${description}`);
  }
  return xml;
}

// ── Vendor lookup / create ────────────────────────────────────────────────────

export async function findOrCreateIntacctVendor(
  sessionId: string,
  vendorName: string,
): Promise<string> {
  // readByQuery — find vendor by name.
  const queryXml = await callIntacct(
    sessionId,
    `<function controlid="findVendor">
      <readByQuery>
        <object>VENDOR</object>
        <fields>VENDORID,NAME</fields>
        <query>NAME = '${vendorName.replace(/'/g, "&apos;")}'</query>
        <pagesize>1</pagesize>
      </readByQuery>
    </function>`,
  );

  const vendorId = extractXmlValue(queryXml, "VENDORID");
  if (vendorId) return vendorId;

  // Create vendor.
  const createXml = await callIntacct(
    sessionId,
    `<function controlid="createVendor">
      <create>
        <VENDOR>
          <NAME>${vendorName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</NAME>
          <STATUS>active</STATUS>
        </VENDOR>
      </create>
    </function>`,
  );

  const createdId = extractXmlValue(createXml, "VENDORID");
  if (!createdId) {
    throw new Error(`Intacct vendor create: could not parse VENDORID from response`);
  }
  return createdId;
}

// ── AP Bill creation ──────────────────────────────────────────────────────────

export interface IntacctBillInput {
  vendorName: string;
  total: number;
  invoiceDate: string | null;  // YYYY-MM-DD
  dueDate: string | null;
  invoiceNumber: string | null;
  currency: string;
  defaultExpenseAccountId?: string | null;
  lineItems: Array<{ description: string | null; amount: number }>;
}

export interface IntacctBillResult {
  billId: string;
}

function toIntacctDate(iso: string | null): string {
  if (!iso) return "";
  // Intacct expects MM/DD/YYYY
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

export async function createIntacctBill(
  sessionId: string,
  input: IntacctBillInput,
): Promise<IntacctBillResult> {
  const vendorId = await findOrCreateIntacctVendor(sessionId, input.vendorName || "Unknown Vendor");

  const items =
    input.lineItems.length > 0
      ? input.lineItems
      : [{ description: input.invoiceNumber ? `Invoice ${input.invoiceNumber}` : "Invoice", amount: input.total }];

  const itemsXml = items
    .map(
      (li) => `
        <APBILLITEM>
          ${input.defaultExpenseAccountId ? `<ACCOUNTNO>${input.defaultExpenseAccountId}</ACCOUNTNO>` : ""}
          <AMOUNT>${li.amount.toFixed(2)}</AMOUNT>
          <MEMO>${(li.description ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</MEMO>
        </APBILLITEM>`,
    )
    .join("\n");

  const billXml = await callIntacct(
    sessionId,
    `<function controlid="createBill">
      <create>
        <APBILL>
          <VENDORID>${vendorId}</VENDORID>
          ${input.invoiceNumber ? `<DOCNUMBER>${input.invoiceNumber}</DOCNUMBER>` : ""}
          ${input.invoiceDate ? `<WHENCREATED>${toIntacctDate(input.invoiceDate)}</WHENCREATED>` : ""}
          ${input.dueDate ? `<WHENDUE>${toIntacctDate(input.dueDate)}</WHENDUE>` : ""}
          ${input.currency && input.currency !== "USD" ? `<CURRENCY>${input.currency}</CURRENCY>` : ""}
          <DESCRIPTION>Synced from Greenbar AP Assurance${input.invoiceNumber ? ` · Invoice ${input.invoiceNumber}` : ""}</DESCRIPTION>
          <APBILLITEMS>
            ${itemsXml}
          </APBILLITEMS>
        </APBILL>
      </create>
    </function>`,
  );

  const recordNo = extractXmlValue(billXml, "RECORDNO");
  if (!recordNo) {
    throw new Error("Intacct APBILL create: could not parse RECORDNO from response");
  }

  return { billId: recordNo };
}

// ── Company name ──────────────────────────────────────────────────────────────

export async function getIntacctCompanyName(
  sessionId: string,
  companyId: string,
): Promise<string> {
  try {
    const xml = await callIntacct(
      sessionId,
      `<function controlid="getCompany">
        <get object="COMPANY" key="${companyId}">
          <fields>NAME</fields>
        </get>
      </function>`,
    );
    return extractXmlValue(xml, "NAME") ?? companyId;
  } catch {
    return companyId;
  }
}
