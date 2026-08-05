/**
 * Drift check: assert the manifest-hash contract in
 * src/lib/evidence/assemble.ts is byte-identical to the two open-source
 * gbverify implementations (Node and Python).
 *
 * Why this exists
 * ---------------
 * The Greenbar Pay evidence packet's cryptographic seal is a SHA-256 over
 * canonical JSON of the manifest. The canonicalisation rules —
 * recursively-sorted keys, no incidental whitespace, ensure_ascii=False
 * semantics on the JS side (unicode written as-is, not \uXXXX-escaped),
 * amounts represented as strings so language-specific float formatting
 * doesn't matter — are implemented by `canonicalJsonStringify` inside
 * assemble.ts.
 *
 * The `gbverify` OSS CLI (github.com/GreenbarSystems/gbverify) is what
 * auditors run to verify a sealed packet without any Greenbar software.
 * If assemble.ts's canonicalisation ever drifts from gbverify's (someone
 * "cleans up" the sortReplacer, changes `separators`, forgets that
 * ensure_ascii must stay off, etc.), *every* previously-sealed evidence
 * packet becomes unverifiable. That is a category of bug we cannot let
 * ship — it silently destroys the audit trail's cryptographic value.
 *
 * How this check works (kept narrow on purpose)
 * ---------------------------------------------
 * 1. Load a fixture manifest that exercises every canonicalisation-
 *    sensitive property: nested objects, unicode, arrays, string-typed
 *    money, mixed-type primitives, and deliberately shuffled top-level
 *    keys.
 * 2. Compute its hash via `canonicalSha256` from the real, imported
 *    assemble.ts. NO database, no ORM, no fixture seeding — just the
 *    pure canonical-JSON function under test.
 * 3. Write that fixture to a temp file wrapped in the gbEvidencePacket
 *    envelope, using the hash we just computed as manifestHash.
 * 4. Run both `gbverify` CLIs (Node and Python) against it. Fail if
 *    either disagrees.
 * 5. Snapshot compare: if the hash the fixture produces changes at all,
 *    fail with a clear "you changed the canonicalisation contract" error
 *    directing the reader to bump schemaVersion.
 *
 * The snapshot step is the load-bearing one. It means a PR that changes
 * the canonicalisation MUST either be a no-op semantically (unusual) or
 * be accompanied by a schemaVersion bump AND a matching gbverify
 * release. The check will not silently accept "the hash moved but both
 * sides still agree" — that is exactly the failure mode that would
 * break every already-sealed packet in production.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalSha256 } from "../src/lib/evidence/assemble";

// This repo is "type": "module" so __dirname is unavailable. Reconstruct it
// from import.meta.url so the script stays runnable via tsx and (later) any
// bundler that emits ESM.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const FIXTURE_PATH = join(REPO_ROOT, "fixtures/evidence-manifest.canonical.json");

// Pinned snapshot of what canonicalSha256 must return for the fixture.
// If this value changes, the canonicalisation contract changed. See the
// header comment for what to do about that.
const EXPECTED_HASH = "6928b5a4b21c9cd40be73a3b3106245be4ffec7c19d88ad14c14d79f880ec1fb";

// Which schemaVersion(s) the currently-shipping gbverify accepts.
// Bump BOTH gbverify's SUPPORTED_SCHEMAS and this constant in the same
// PR when you introduce a new canonicalisation.
const SUPPORTED_SCHEMA_VERSIONS = new Set(["evidence.v2"]);

interface CliResult {
  name: string;
  ok: boolean;
  computed?: string;
  recorded?: string;
  raw: string;
  exitCode: number | null;
}

function runCli(command: string, args: string[], input: string): CliResult {
  const r = spawnSync(command, args, {
    input,
    encoding: "utf-8",
    // Fail fast if a CLI hangs — 15s is generous for a hash check.
    timeout: 15_000,
  });
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  let parsed: { manifest?: { ok: boolean; computedManifestHash?: string; recordedManifestHash?: string } } = {};
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Fall through — we'll report the raw output.
  }
  return {
    name: `${command} ${args.join(" ")}`,
    ok: r.status === 0 && parsed.manifest?.ok === true,
    computed: parsed.manifest?.computedManifestHash,
    recorded: parsed.manifest?.recordedManifestHash,
    raw: (stdout + stderr).trim(),
    exitCode: r.status,
  };
}

function die(msg: string): never {
  // Prefix with ::error:: so GitHub Actions surfaces it inline on the PR.
  console.error(`::error::${msg}`);
  process.exit(1);
}

function main(): void {
  const manifest = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Record<string, unknown>;

  if (!SUPPORTED_SCHEMA_VERSIONS.has(manifest.schemaVersion as string)) {
    die(
      `Fixture schemaVersion "${manifest.schemaVersion}" is not in SUPPORTED_SCHEMA_VERSIONS. ` +
        `Update the fixture and/or bump gbverify to match the new contract.`,
    );
  }

  const hashFromAssembleTs = canonicalSha256(manifest);
  console.log(`assemble.ts canonicalSha256:      ${hashFromAssembleTs}`);

  // ── Snapshot gate ──────────────────────────────────────────────────
  // On first run, EXPECTED_HASH is a placeholder — the script will print
  // the value to paste in. On every subsequent run, a mismatch means the
  // canonicalisation moved and this PR must own that decision explicitly.
  if (EXPECTED_HASH === "__EXPECTED_HASH_TO_BE_FILLED_ON_FIRST_RUN__") {
    console.log(
      `\n[first-run bootstrap] Paste this into EXPECTED_HASH at the top of this file:\n  ${hashFromAssembleTs}\n`,
    );
  } else if (hashFromAssembleTs !== EXPECTED_HASH) {
    die(
      `Canonical-JSON contract changed.\n` +
        `  fixture hash was: ${EXPECTED_HASH}\n` +
        `  fixture hash now: ${hashFromAssembleTs}\n\n` +
        `This means canonicalJsonStringify in src/lib/evidence/assemble.ts now produces a\n` +
        `different byte sequence for the same input. Every evidence packet sealed before\n` +
        `this change will fail to verify with the new build.\n\n` +
        `If this change is intentional you MUST:\n` +
        `  1. Bump schemaVersion in src/lib/evidence/assemble.ts (e.g. evidence.v2 -> evidence.v3).\n` +
        `  2. Add the new schemaVersion to SUPPORTED_SCHEMA_VERSIONS above and to gbverify.\n` +
        `  3. Cut a matching gbverify release so auditors can verify both old and new packets.\n` +
        `  4. Update EXPECTED_HASH in this file to the new value shown above.\n` +
        `  5. Add a migration note in CHANGELOG describing why the contract moved.`,
    );
  }

  // ── Cross-implementation agreement ────────────────────────────────
  // Wrap the fixture in the envelope gbverify expects, using the just-
  // computed hash. If either CLI disagrees, they are canonicalising
  // differently from assemble.ts — which is the failure mode this
  // whole check exists to prevent.
  const envelope = {
    gbEvidencePacket: {
      packetId: "7fd81c6a-drift-check-ci-fixture",
      schemaVersion: manifest.schemaVersion,
      sealedAt: "2026-07-25T14:22:07.000Z",
      sealedByUserId: "u0000000-0000-4000-8000-0000000000a1",
      organizationId: "org_drift_check",
      manifestHash: hashFromAssembleTs,
      sourceDocumentHash: (manifest.originalDocument as Record<string, string>).contentHash,
      manifest,
    },
  };

  const tmp = mkdtempSync(join(tmpdir(), "gbverify-drift-"));
  const packetPath = join(tmp, "packet.json");
  writeFileSync(packetPath, JSON.stringify(envelope));

  try {
    // gbverify sources live in this repo's vendored copy so CI does not
    // depend on npm/pip registry availability. If you move them, update
    // both paths here.
    const nodeCli = join(REPO_ROOT, "vendor/gbverify/cli-node/bin/gbverify.js");
    const pyCli = join(REPO_ROOT, "vendor/gbverify/cli-python/gbverify.py");

    const results: CliResult[] = [
      runCli("node", [nodeCli, "--json", packetPath], ""),
      runCli("python3", [pyCli, "--json", packetPath], ""),
    ];

    let anyFailed = false;
    for (const r of results) {
      const status = r.ok ? "OK " : "FAIL";
      console.log(`  ${status}  ${r.name}`);
      console.log(`         computed: ${r.computed ?? "(none)"}`);
      console.log(`         recorded: ${r.recorded ?? "(none)"}`);
      if (!r.ok) {
        anyFailed = true;
        console.error(`\n--- ${r.name} raw output ---\n${r.raw}\n`);
      }
    }

    if (anyFailed) {
      die(
        `One or more gbverify implementations disagree with assemble.ts.\n` +
          `This is the drift the check exists to prevent — DO NOT MERGE.\n` +
          `Fix: reconcile canonicalJsonStringify in assemble.ts and gbverify so\n` +
          `both languages produce byte-identical serialisations of the fixture.`,
      );
    }

    // Additionally verify: computed == recorded == assemble.ts's hash on both.
    for (const r of results) {
      if (r.computed !== hashFromAssembleTs || r.recorded !== hashFromAssembleTs) {
        die(
          `${r.name} produced a different hash than assemble.ts:\n` +
            `  assemble.ts: ${hashFromAssembleTs}\n` +
            `  cli computed: ${r.computed}\n` +
            `  cli recorded: ${r.recorded}`,
        );
      }
    }

    console.log(`\n✓ canonicalisation contract stable across assemble.ts, Node gbverify, and Python gbverify.`);
  } finally {
    try {
      unlinkSync(packetPath);
      rmdirSync(tmp);
    } catch {
      // Non-fatal cleanup issue; CI runners are ephemeral anyway.
    }
  }
}

main();
