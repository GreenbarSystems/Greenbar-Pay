/**
 * Tesseract OCR — two extractors sharing one worker:
 *
 *   tesseractExtractor    — accepts PNG / JPEG / TIFF directly.
 *   tesseractPdfExtractor — accepts PDF; rasterizes via pdftoppm first
 *                           (one image per page) and concatenates results.
 *
 * The PDF extractor is wired as a *fallback* in process-document: native
 * pdf-parse runs first; if its quality score is low, we retry with this.
 */
import { createWorker, type Worker } from "tesseract.js";
import type { ExtractionResult, TextExtractor } from ".";
import { scoreText } from "./text-quality";
import { rasterizePdf, RasterizeError } from "./pdf-rasterize";

let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) workerPromise = createWorker("eng");
  return workerPromise;
}

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/tiff"]);

export const tesseractExtractor: TextExtractor = {
  async extract({ mimeType, bytes }) {
    if (!IMAGE_MIME.has(mimeType)) return null;

    const worker = await getWorker();
    const { data } = await worker.recognize(bytes);
    const text = (data.text ?? "").trim();

    return {
      method: "tesseract_image",
      provider: "tesseract.js",
      text,
      qualityScore: scoreText(text),
      // Tesseract reports `confidence` in 0..100; normalize to 0..1.
      averageConfidence:
        typeof data.confidence === "number" ? data.confidence / 100 : null,
      metadata: {
        words: Array.isArray(data.words) ? data.words.length : 0,
        lines: Array.isArray(data.lines) ? data.lines.length : 0,
      },
    } satisfies ExtractionResult;
  },
};

export const tesseractPdfExtractor: TextExtractor = {
  async extract({ mimeType, bytes }) {
    if (mimeType !== "application/pdf") return null;

    let pages;
    try {
      pages = await rasterizePdf(bytes);
    } catch (err) {
      if (err instanceof RasterizeError) {
        // Bubble structured info into the extraction record so the review
        // queue shows a meaningful reason rather than an opaque failure.
        return {
          method: "tesseract_pdf",
          provider: "pdftoppm+tesseract.js",
          text: "",
          qualityScore: 0,
          averageConfidence: null,
          metadata: { rasterizeError: err.code, message: err.message },
        } satisfies ExtractionResult;
      }
      throw err;
    }

    if (pages.length === 0) {
      return {
        method: "tesseract_pdf",
        provider: "pdftoppm+tesseract.js",
        text: "",
        qualityScore: 0,
        averageConfidence: null,
        metadata: { reason: "no_pages_rendered" },
      } satisfies ExtractionResult;
    }

    const worker = await getWorker();
    const pageTexts: string[] = [];
    let confidenceSum = 0;
    let confidenceCount = 0;
    let wordCount = 0;
    let lineCount = 0;

    // Sequential, not parallel: tesseract.js's single worker is not
    // reentrant. A worker pool helps for >10 pages; most invoices are 1–3.
    for (const page of pages) {
      const { data } = await worker.recognize(page.png);
      const text = (data.text ?? "").trim();
      // Page markers help downstream LLM keep line-item context grouped.
      pageTexts.push(`--- page ${page.pageNumber} ---\n${text}`);
      if (typeof data.confidence === "number") {
        confidenceSum += data.confidence;
        confidenceCount += 1;
      }
      wordCount += Array.isArray(data.words) ? data.words.length : 0;
      lineCount += Array.isArray(data.lines) ? data.lines.length : 0;
    }

    const text = pageTexts.join("\n\n").trim();
    return {
      method: "tesseract_pdf",
      provider: "pdftoppm+tesseract.js",
      text,
      qualityScore: scoreText(text),
      averageConfidence:
        confidenceCount > 0 ? confidenceSum / confidenceCount / 100 : null,
      metadata: {
        pageCount: pages.length,
        words: wordCount,
        lines: lineCount,
      },
    } satisfies ExtractionResult;
  },
};
