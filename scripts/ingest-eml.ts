/**
 * Local-dev CLI: simulate the SES → S3 → SQS path without AWS.
 *
 *   pnpm ingest:eml ./fixtures/example.eml [--mailbox ap+acme--bigco@in.invoice-ai.com]
 *
 * Uploads the file under inbound/<sha>.eml, then invokes the same
 * ingestEmlMessage() the SQS worker would call. Lets us validate
 * end-to-end parsing + routing + idempotency on a laptop.
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { storage } from "@/lib/storage";
import { ingestEmlMessage } from "@/lib/inbox/ingest";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      flags[a.slice(2)] = args[++i] ?? "";
    } else positional.push(a);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv);
  const [emlPath] = positional;

  if (!emlPath || !existsSync(emlPath)) {
    console.error("Usage: pnpm ingest:eml <path/to/file.eml> [--mailbox <addr>]");
    process.exit(1);
  }

  const emlBytes = readFileSync(path.resolve(emlPath));
  const sha = createHash("sha256").update(emlBytes).digest("hex").slice(0, 16);
  const key = `inbound/local/${sha}.eml`;

  console.log(`[ingest-eml] uploading to ${key} (${emlBytes.length} bytes)`);
  await storage.putObject({
    key,
    body: emlBytes,
    contentType: "message/rfc822",
  });

  const mailbox = flags.mailbox ?? "(local-cli)";
  const result = await ingestEmlMessage({
    rawMessageStorageKey: key,
    mailbox,
  });
  console.log("[ingest-eml] result:", result);
  process.exit(result.kind === "ingested" && result.status === "failed" ? 1 : 0);
}

main().catch((err) => {
  console.error("[ingest-eml] fatal", err);
  process.exit(1);
});
