/**
 * Phase 11.1 — copy the pdfjs-dist worker file into /public so the
 * react-pdf component can load it at /pdf.worker.min.mjs.
 *
 * Runs automatically via the `postinstall` script in package.json,
 * so `npm install` always leaves /public in sync with the installed
 * pdfjs-dist version. No manual recopy required when bumping.
 *
 * Standalone — pure Node, no deps. Safe to run on any platform.
 *
 * Version-drift note (code-quality audit L4): because this file is
 * checked into git (it's a build artifact, not gitignored) and the
 * production Dockerfile's `COPY . .` step ships whatever is committed
 * — NOT a fresh postinstall run inside that build stage — a dev who
 * bumps pdfjs-dist/react-pdf, runs `npm install` locally, but forgets
 * to `git add public/pdf.worker.min.mjs` would ship a stale worker
 * mismatched against the new pdfjs-dist in node_modules. CI now
 * catches this: see the "Verify pdf.worker.min.mjs matches installed
 * pdfjs-dist" step in .github/workflows/ci.yml, which fails the build
 * if `npm install`'s fresh copy differs from the committed one.
 *
 * We deliberately did NOT add a Subresource Integrity (SRI) hash here
 * instead — SRI protects against a compromised THIRD-PARTY host (e.g.
 * a CDN serving different bytes than what you audited). This asset is
 * same-origin, served from our own /public directory as part of the
 * same deployment artifact as the rest of the app bundle; there's no
 * separate trust boundary for SRI to defend. The CI diff check above
 * targets the actual risk (accidental version drift), not a threat
 * model that doesn't apply here.
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
