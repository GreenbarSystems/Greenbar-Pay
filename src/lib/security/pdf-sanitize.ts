/**
 * PDF sanitization — fixes "F3: AV scan + PDF sanitizer are no-op
 * stubs" from the 2026-07-13 security audit.
 *
 * Strips PDF-native active content that could execute when the file is
 * opened in a real PDF viewer (the reviewer's PdfViewer component, or
 * any other downstream tool a document might end up in):
 *   - /OpenAction and /AA (additional actions) — auto-run on open/close/print
 *   - /Names/JavaScript — the document-level JS name tree
 *   - /Names/EmbeddedFiles — arbitrary attached files (could be executables)
 *   - /AcroForm/XFA — dynamic XFA forms, a well-known exploit vector
 *   - per-page /AA, and per-annotation /AA + /A (link/widget actions)
 *
 * This does not attempt to repair structural corruption or fully
 * rebuild the file — it removes the specific entry points a PDF
 * viewer uses to run embedded script/actions. pdf-parse and the OCR
 * pipeline never execute PDF actions regardless (they only read
 * text/image content); this control exists for anything that opens
 * the file as a real interactive PDF.
 *
 * A malformed or adversarially-crafted PDF that pdf-lib cannot parse
 * throws here. inspectUpload() (file-safety.ts) already wraps the
 * sanitizer call in try/catch and converts any throw into a rejected
 * upload (FileSafetyError "sanitization_failed") — the original bytes
 * are never passed through unsanitized on failure.
 */
import { PDFDocument, PDFName, PDFDict, PDFArray } from "pdf-lib";
import type { PdfSanitizer } from "../file-safety";

export const pdfLibSanitize: PdfSanitizer = async (buf) => {
  const doc = await PDFDocument.load(buf, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });

  const catalog = doc.catalog;
  catalog.delete(PDFName.of("OpenAction"));
  catalog.delete(PDFName.of("AA"));

  const names = catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  names?.delete(PDFName.of("JavaScript"));
  names?.delete(PDFName.of("EmbeddedFiles"));

  const acroForm = catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  acroForm?.delete(PDFName.of("XFA"));

  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("AA"));

    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, PDFDict);
      annot?.delete(PDFName.of("AA"));
      annot?.delete(PDFName.of("A"));
    }
  }

  const saved = await doc.save({ useObjectStreams: false });
  return Buffer.from(saved);
};
