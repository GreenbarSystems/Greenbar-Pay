/**
 * Phase 11.1 — copy the pdfjs-dist worker file into /public so the
 * react-pdf component can load it at /pdf.worker.min.mjs.
 *
 * Runs automatically via the `postinstall` script in package.json,
 * so `npm install` always leaves /public in sync with the installed
 * pdfjs-dist version. No manual recopy required when bumping.
 *
 * Standalone — pure Node, no deps. Safe to run on any platform.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const src = path.join(
  root,
  "node_modules",
  "pdfjs-dist",
  "build",
  "pdf.worker.min.mjs",
);
const destDir = path.join(root, "public");
const dest = path.join(destDir, "pdf.worker.min.mjs");

if (!existsSync(src)) {
  // pdfjs-dist isn't installed yet (e.g. running postinstall during a
  // partial install). Skip silently; a real `npm install` will re-run.
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("[copy-pdf-worker] copied", path.relative(root, dest));
