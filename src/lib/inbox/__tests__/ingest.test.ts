/**
 * Integration test for AP inbox ingest (addendum §3.3):
 *   - parses a real RFC 822 fixture;
 *   - resolves the recipient address to (org, client);
 *   - writes email_messages + email_attachments + documents;
 *   - running it twice with the same S3 key produces ONE set of rows.
 *
 * Requires the local Postgres + MinIO stack (`docker compose up -d`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import {
  organizations,
  clients,
  emailMessages,
  emailAttachments,
  documents,
} from "@/db/schema";
import { storage } from "@/lib/storage";
import { ingestEmlMessage } from "@/lib/inbox/ingest";

const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;

let pool: Pool;
let db: ReturnType<typeof drizzle>;
let orgId: string;
let clientId: string;
let storageKey: string;

const ORG_SLUG = `acme-${Date.now()}`;
const CLIENT_SLUG = `bigco-${Date.now()}`;

beforeAll(async () => {
  if (!ADMIN_URL) throw new Error("DATABASE_URL_ADMIN must be set");
  pool = new Pool({ connectionString: ADMIN_URL });
  db = drizzle(pool);

  const [org] = await db
    .insert(organizations)
    .values({ name: "ACME (inbox test)", slug: ORG_SLUG })
    .returning({ id: organizations.id });
  orgId = org.id;

  const [c] = await db
    .insert(clients)
    .values({ organizationId: orgId, name: "BigCo", slug: CLIENT_SLUG })
    .returning({ id: clients.id });
  clientId = c.id;

  // Load fixture, but patch the recipient to match this test's slug pair
  // (the fixture's static slugs would collide across runs).
  const fixtureBytes = readFileSync(
    path.resolve(__dirname, "fixtures/sample.eml"),
  );
  const patched = Buffer.from(
    fixtureBytes
      .toString("utf8")
      .replace(
        "ap+acme--bigco@in.invoice-ai.com",
        `ap+${ORG_SLUG}--${CLIENT_SLUG}@in.invoice-ai.com`,
      ),
    "utf8",
  );
  storageKey = `inbound/test/${createHash("sha256").update(patched).digest("hex").slice(0, 16)}.eml`;
  await storage.putObject({
    key: storageKey,
    body: patched,
    contentType: "message/rfc822",
  });
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pool.end();
});

// Issue #3 — the inbox ingest test exercises the storage subsystem
// (putObject + getObject against S3 / MinIO). CI doesn't bring up
// MinIO, so the test cannot run there. Skip when no S3 creds are
// configured; run locally / in a future CI workflow that provisions
// MinIO. The skipIf gate at the suite level avoids hitting beforeAll's
// putObject when there's no storage to write to.
describe.skipIf(!process.env.S3_ACCESS_KEY_ID)("AP inbox ingest", () => {
  it("ingests a routed message and writes one document", async () => {
    const result = await ingestEmlMessage({
      rawMessageStorageKey: storageKey,
      mailbox: `ap+${ORG_SLUG}--${CLIENT_SLUG}@in.invoice-ai.com`,
    });
    expect(result.kind).toBe("ingested");
    if (result.kind !== "ingested") throw new Error("expected ingested");
    expect(result.status).toBe("processed");
    expect(result.acceptedDocumentIds).toHaveLength(1);

    const msgRows = await db
      .select({ id: emailMessages.id, status: emailMessages.status })
      .from(emailMessages)
      .where(eq(emailMessages.organizationId, orgId));
    expect(msgRows).toHaveLength(1);
    expect(msgRows[0].status).toBe("processed");

    const attRows = await db
      .select({ id: emailAttachments.id, status: emailAttachments.status })
      .from(emailAttachments)
      .where(eq(emailAttachments.organizationId, orgId));
    expect(attRows.filter((a) => a.status === "accepted")).toHaveLength(1);

    const docRows = await db
      .select({ id: documents.id, source: documents.source })
      .from(documents)
      .where(eq(documents.organizationId, orgId));
    expect(docRows).toHaveLength(1);
    expect(docRows[0].source).toBe("email");
  });

  it("re-ingesting the same key is a no-op", async () => {
    const second = await ingestEmlMessage({
      rawMessageStorageKey: storageKey,
      mailbox: `ap+${ORG_SLUG}--${CLIENT_SLUG}@in.invoice-ai.com`,
    });
    expect(second.kind).toBe("duplicate");

    // Counts unchanged.
    const msgRows = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.organizationId, orgId));
    expect(msgRows).toHaveLength(1);

    const docRows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.organizationId, orgId));
    expect(docRows).toHaveLength(1);
  });

  it("unknown recipient slugs land as 'unrouted' under no org", async () => {
    // Patch the fixture again with a non-existent client slug.
    const fixtureBytes = readFileSync(
      path.resolve(__dirname, "fixtures/sample.eml"),
    );
    const patched = Buffer.from(
      fixtureBytes
        .toString("utf8")
        .replace(
          "ap+acme--bigco@in.invoice-ai.com",
          `ap+${ORG_SLUG}--does-not-exist@in.invoice-ai.com`,
        )
        .replace("test-message-001@example.com", "test-message-unrouted@example.com"),
      "utf8",
    );
    const key = `inbound/test/unrouted-${Date.now()}.eml`;
    await storage.putObject({
      key,
      body: patched,
      contentType: "message/rfc822",
    });

    const result = await ingestEmlMessage({
      rawMessageStorageKey: key,
      mailbox: `ap+${ORG_SLUG}--does-not-exist@in.invoice-ai.com`,
    });
    expect(result.kind).toBe("ingested");
    if (result.kind !== "ingested") throw new Error("expected ingested");
    expect(result.status).toBe("unrouted");

    const unrouted = await db
      .select({ id: emailMessages.id, status: emailMessages.status })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.status, "unrouted"),
          eq(emailMessages.rawMessageStorageKey, key),
        ),
      );
    expect(unrouted).toHaveLength(1);
  });

  // 2026-07-13 audit F11 — a message that fails sender authentication
  // must be rejected even when it routes to a real, valid org/client
  // (the exact scenario an attacker who has guessed a valid inbox
  // address is trying to exploit) — no attachment or document ever
  // gets created for it.
  it("a message that fails SPF+DKIM is rejected before any attachment is processed, even when correctly routed", async () => {
    const fixtureBytes = readFileSync(
      path.resolve(__dirname, "fixtures/sample.eml"),
    );
    const patched = Buffer.from(
      fixtureBytes
        .toString("utf8")
        .replace(
          "ap+acme--bigco@in.invoice-ai.com",
          `ap+${ORG_SLUG}--${CLIENT_SLUG}@in.invoice-ai.com`,
        )
        .replace("test-message-001@example.com", "test-message-spoofed@example.com"),
      "utf8",
    );
    const key = `inbound/test/spoofed-${Date.now()}.eml`;
    await storage.putObject({
      key,
      body: patched,
      contentType: "message/rfc822",
    });

    const result = await ingestEmlMessage({
      rawMessageStorageKey: key,
      mailbox: `ap+${ORG_SLUG}--${CLIENT_SLUG}@in.invoice-ai.com`,
      authentication: { spfVerdict: "FAIL", dkimVerdict: "FAIL" },
    });
    expect(result.kind).toBe("ingested");
    if (result.kind !== "ingested") throw new Error("expected ingested");
    expect(result.status).toBe("failed");
    expect(result.acceptedDocumentIds).toHaveLength(0);

    const failedRow = await db
      .select({ status: emailMessages.status, statusReason: emailMessages.statusReason })
      .from(emailMessages)
      .where(eq(emailMessages.rawMessageStorageKey, key));
    expect(failedRow).toHaveLength(1);
    expect(failedRow[0].status).toBe("failed");
    expect(failedRow[0].statusReason).toContain("SPF and DKIM both failed");
    // Routing WOULD have succeeded (valid org/client) — confirms the
    // rejection is about authentication, not routing.
    expect(failedRow[0].statusReason).not.toContain("no org/client matches");

    // Only the one attachment/document from the first ("ingests a
    // routed message") test — the spoofed message contributed nothing
    // to either table, for this org.
    const attRows = await db
      .select({ id: emailAttachments.id })
      .from(emailAttachments)
      .where(eq(emailAttachments.organizationId, orgId));
    expect(attRows).toHaveLength(1);

    const docRows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.organizationId, orgId));
    expect(docRows).toHaveLength(1);
  });
});
