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
import { rasterizePdfPages, RasterizeError } from "./pdf-rasterize";

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

    const worker = await getWorker();
    const pageTexts: string[] = [];
    let pageCount = 0;
    let confidenceSum = 0;
    let confidenceCount = 0;
    let wordCount = 0;
    let lineCount = 0;

    // PR4 — review #23: stream pages one at a time. Each page buffer is
    // GC-eligible as soon as worker.recognize returns; peak memory is
    // ~1 page in flight regardless of doc length.
    //
    // Sequential (not parallel) because tesseract.js's single worker
    // is not reentrant. A worker pool helps for >10-page docs; most
    // invoices are 1–3 pages — revisit when we see real throughput data.
    try {
      for await (const page of rasterizePdfPages(bytes)) {
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
        pageCount += 1;
      }
    } catch (err) {
      if (err instanceof RasterizeError) {
        // Surface structured info to the extraction record so the
        // review queue shows a meaningful reason. May have already
        // processed a few pages before the error — keep what we have
        // and tag the failure.
        return {
          method: "tesseract_pdf",
          provider: "pdftoppm+tesseract.js",
          text: pageTexts.join("\n\n").trim(),
          qualityScore: 0,
          averageConfidence: null,
          metadata: {
            rasterizeError: err.code,
            message: err.message,
            partialPageCount: pageCount,
          },
        } satisfies ExtractionResult;
      }
      throw err;
    }

    if (pageCount === 0) {
      return {
        method: "tesseract_pdf",
        provider: "pdftoppm+tesseract.js",
        text: "",
        qualityScore: 0,
        averageConfidence: null,
        metadata: { reason: "no_pages_rendered" },
      } satisfies ExtractionResult;
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
        pageCount,
        words: wordCount,
        lines: lineCount,
      },
    } satisfies ExtractionResult;
  },
};
