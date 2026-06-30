#!/usr/bin/env node
/**
 * Points git at the repo-tracked .githooks/ directory and makes the
 * hooks executable.
 *
 * Invoked from the `postinstall` script so `npm install` automatically
 * activates the hooks on every clone. Idempotent — safe to run any
 * number of times.
 *
 * Skipped silently in non-git environments (CI sometimes installs deps
 * outside a working tree) so it never blocks a deploy.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const HOOKS_DIR = ".githooks";

function inGitRepo() {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!inGitRepo()) {
    console.log("[setup-hooks] not a git repo; skipping");
    return;
  }
  if (!existsSync(HOOKS_DIR)) {
    console.log(`[setup-hooks] ${HOOKS_DIR} not found; skipping`);
    return;
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", HOOKS_DIR], {
      stdio: "ignore",
    });
  } catch (e) {
    console.warn("[setup-hooks] git config failed:", (e instanceof Error ? e.message : String(e)));
    return;
  }

  // chmod +x every file in .githooks. No-op on Windows but harmless.
  for (const name of readdirSync(HOOKS_DIR)) {
    const p = join(HOOKS_DIR, name);
    try {
      if (statSync(p).isFile()) chmodSync(p, 0o755);
    } catch {
      // Permission errors are non-fatal — git on Windows ignores the
      // mode bit entirely.
    }
  }

  console.log(`[setup-hooks] core.hooksPath -> ${HOOKS_DIR}`);
}

main();
