/**
 * Text extraction abstraction. Native PDF first (cheap, accurate when the
 * PDF is digital); Tesseract fallback for image inputs and for PDFs whose
 * native text scores poorly.
 *
 * Phase 2 ships native-pdf + tesseract impls. Cloud providers (Textract,
 * Document AI, Claude vision) slot in here later without touching the job.
 */
export type ExtractionMethod =
  | "native_pdf"
  | "tesseract_image"
  | "tesseract_pdf"
  | "empty";

export interface ExtractionResult {
  method: ExtractionMethod;
  provider: string | null;
  text: string;
  /** 0..1, see scoreText() */
  qualityScore: number;
  /** 0..1 if the provider reports it (Tesseract does); null otherwise. */
  averageConfidence: number | null;
  metadata: Record<string, unknown>;
}

export interface TextExtractor {
  /** Returns null if this extractor doesn't handle the given MIME type. */
  extract(input: { mimeType: string; bytes: Buffer }): Promise<ExtractionResult | null>;
}

export { nativePdfExtractor } from "./native-pdf";
export { tesseractExtractor, tesseractPdfExtractor } from "./tesseract";
export { scoreText } from "./text-quality";
