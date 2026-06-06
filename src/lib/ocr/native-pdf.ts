/**
 * Native PDF text extraction via pdf-parse. Fast, deterministic, free —
 * the right first attempt for any application/pdf input.
 *
 * Returns null for non-PDF inputs so the caller can fall through to OCR.
 */
import pdfParse from "pdf-parse";
import type { ExtractionResult, TextExtractor } from ".";
import { scoreText } from "./text-quality";

export const nativePdfExtractor: TextExtractor = {
  async extract({ mimeType, bytes }) {
    if (mimeType !== "application/pdf") return null;

    let parsed;
    try {
      parsed = await pdfParse(bytes);
    } catch (err) {
      // Malformed PDF — return an empty result so the caller decides
      // whether to escalate to OCR or fail the job.
      return {
        method: "native_pdf",
        provider: "pdf-parse",
        text: "",
        qualityScore: 0,
        averageConfidence: null,
        metadata: {
          parseError: (err as Error).message,
        },
      } satisfies ExtractionResult;
    }

    const text = (parsed.text ?? "").trim();
    return {
      method: "native_pdf",
      provider: "pdf-parse",
      text,
      qualityScore: scoreText(text),
      averageConfidence: null,
      metadata: {
        pageCount: parsed.numpages,
        info: parsed.info ?? null,
      },
    } satisfies ExtractionResult;
  },
};
