/**
 * PDF → PNG-per-page via `pdftoppm` (poppler-utils). Used by the
 * tesseract_pdf extractor as the OCR fallback for scanned PDFs.
 *
 * Why pdftoppm:
 *   - Single small binary, available in every distro (Alpine: poppler-utils,
 *     Debian: poppler-utils, macOS: brew install poppler).
 *   - Deterministic output naming (page-001.png, page-002.png, …).
 *   - No Node native bindings → image is portable.
 *
 * Phase 2.6 file-safety caps: max 50 pages per PDF. We refuse to rasterize
 * more even if pdftoppm would happily oblige.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const RASTERIZE_DPI = 200; // good balance of OCR accuracy vs. file size
export const MAX_PAGES = 50;       // §2.6

export class RasterizeError extends Error {
  readonly code: "missing_binary" | "rasterize_failed" | "too_many_pages";
  constructor(code: RasterizeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface RasterizedPage {
  pageNumber: number;
  png: Buffer;
}

/**
 * Streams rasterized pages one at a time (PR4 — review #23).
 *
 * Previously buffered all PNGs in memory before returning. For a 50-page
 * scanned PDF at 200 DPI that meant 10–50 MB held simultaneously per
 * worker, on top of Tesseract's own working memory. Now: the rendered
 * files sit on disk, we readFile them lazily inside the loop, and each
 * page buffer is GC-eligible as soon as the consumer moves on.
 *
 * The page count check still fires up-front (after pdftoppm completes)
 * so the too_many_pages error is raised before any consumer work.
 *
 * pdftoppm flags:
 *   -png        emit PNG
 *   -r N        N dots per inch
 *   -l N        last page (we cap at MAX_PAGES + 1 to detect overflow)
 */
export async function* rasterizePdfPages(
  pdfBytes: Buffer,
): AsyncGenerator<RasterizedPage, void, void> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gbp-rasterize-"));
  try {
    const pdfPath = path.join(tmpDir, "in.pdf");
    await writeFile(pdfPath, pdfBytes);

    const outPrefix = path.join(tmpDir, "page");
    await runPdftoppm([
      "-png",
      "-r", String(RASTERIZE_DPI),
      "-l", String(MAX_PAGES + 1),
      pdfPath,
      outPrefix,
    ]);

    const files = (await readdir(tmpDir))
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort();

    if (files.length > MAX_PAGES) {
      throw new RasterizeError(
        "too_many_pages",
        `pdf has ${files.length} pages; max ${MAX_PAGES}`,
      );
    }

    for (const f of files) {
      const m = f.match(/page-(\d+)\.png$/);
      if (!m) continue;
      yield {
        pageNumber: Number(m[1]),
        png: await readFile(path.join(tmpDir, f)),
      };
    }
  } finally {
    // Best-effort cleanup. A leaked tmpdir is annoying, not unsafe.
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runPdftoppm(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pdftoppm", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      // ENOENT here means the binary isn't on PATH. Translate so callers can
      // give a useful message instead of a cryptic spawn error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new RasterizeError(
            "missing_binary",
            "pdftoppm not found. Install poppler-utils in the worker image.",
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new RasterizeError(
            "rasterize_failed",
            `pdftoppm exited ${code}: ${stderr.trim().slice(0, 500)}`,
          ),
        );
    });
  });
}
