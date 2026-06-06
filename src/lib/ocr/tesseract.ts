/**
 * Tesseract OCR. Handles image inputs directly (PNG/JPEG/TIFF). For PDFs
 * whose native text scored low, this extractor returns null in Phase 2 —
 * rasterizing PDFs in Node needs poppler-utils or canvas bindings, which
 * we add in a Phase 2.1 deploy step. Real image uploads work today.
 */
import { createWorker } from "tesseract.js";
import type { ExtractionResult, TextExtractor } from ".";
import { scoreText } from "./text-quality";

let workerPromise: ReturnType<typeof createWorker> | null = null;

async function getWorker() {
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
        // Keep the metadata bounded — full word list would blow up the row.
        words: Array.isArray(data.words) ? data.words.length : 0,
        lines: Array.isArray(data.lines) ? data.lines.length : 0,
      },
    } satisfies ExtractionResult;
  },
};
