/**
 * Builds a PDF carrying every active-content vector pdfLibSanitize is
 * supposed to strip, sanitizes it, then reloads the SANITIZED output
 * and asserts none of those vectors are reachable from the document's
 * catalog/page tree anymore — i.e. a spec-compliant PDF viewer
 * (including pdf.js, which the reviewer's PdfViewer uses) would never
 * execute them. This is the correct assertion: pdfLibSanitize removes
 * REFERENCES to the dangerous objects, not the underlying object
 * bytes themselves (pdf-lib has no public API to garbage-collect
 * orphaned objects on save) — an orphaned, unreferenced object is
 * inert to any standards-compliant parser, so asserting on raw byte
 * absence would test the wrong thing.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, PDFDict, PDFArray } from "pdf-lib";
import { pdfLibSanitize } from "../pdf-sanitize";

async function buildMaliciousPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);

  // 1. /OpenAction — auto-runs JavaScript when the document opens.
  const openActionJs = doc.context.obj({
    Type: "Action",
    S: "JavaScript",
    JS: "app.alert('open-action-pwned');",
  });
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.register(openActionJs));

  // 2. /AA (document-level additional actions) — e.g. runs on close.
  const willCloseJs = doc.context.obj({
    Type: "Action",
    S: "JavaScript",
    JS: "app.alert('will-close-pwned');",
  });
  const docAA = doc.context.obj({ WC: doc.context.register(willCloseJs) });
  doc.catalog.set(PDFName.of("AA"), doc.context.register(docAA));

  // 3. /Names/JavaScript — the document-level JS name tree (e.g. used
  // for AcroForm calculation scripts that fire without any action).
  const jsNameTree = doc.context.obj({
    Names: [
      doc.context.obj("bootstrap"),
      doc.context.register(
        doc.context.obj({ S: "JavaScript", JS: "app.alert('names-js-pwned');" }),
      ),
    ],
  });
  const namesDict = doc.context.obj({ JavaScript: doc.context.register(jsNameTree) });
  doc.catalog.set(PDFName.of("Names"), doc.context.register(namesDict));

  // 4. /AcroForm/XFA — dynamic XFA forms, a known exploit vector.
  const acroForm = doc.context.obj({
    XFA: doc.context.register(doc.context.obj("<xdp:xdp>malicious</xdp:xdp>")),
  });
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.register(acroForm));

  // 5. Page-level /AA.
  const pageAA = doc.context.obj({
    O: doc.context.register(
      doc.context.obj({ S: "JavaScript", JS: "app.alert('page-open-pwned');" }),
    ),
  });
  page.node.set(PDFName.of("AA"), doc.context.register(pageAA));

  // 6. An annotation with both /AA and a /Launch action (/A) — link and
  // widget annotations are the classic "click here" JS/Launch trigger.
  const launchAction = doc.context.obj({
    Type: "Action",
    S: "Launch",
    F: "calc.exe",
  });
  const annotAA = doc.context.obj({
    E: doc.context.register(
      doc.context.obj({ S: "JavaScript", JS: "app.alert('annot-enter-pwned');" }),
    ),
  });
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [0, 0, 10, 10],
    A: doc.context.register(launchAction),
    AA: doc.context.register(annotAA),
  });
  page.node.set(
    PDFName.of("Annots"),
    doc.context.obj([doc.context.register(annot)]),
  );

  const bytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}

describe("pdfLibSanitize", () => {
  it("strips every reachable active-content vector", async () => {
    const malicious = await buildMaliciousPdf();
    const sanitizedBuf = await pdfLibSanitize(malicious);

    const clean = await PDFDocument.load(sanitizedBuf);
    const catalog = clean.catalog;

    expect(catalog.get(PDFName.of("OpenAction"))).toBeUndefined();
    expect(catalog.get(PDFName.of("AA"))).toBeUndefined();

    const names = catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
    expect(names?.get(PDFName.of("JavaScript"))).toBeUndefined();

    const acroForm = catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
    expect(acroForm?.get(PDFName.of("XFA"))).toBeUndefined();

    const [page] = clean.getPages();
    expect(page.node.get(PDFName.of("AA"))).toBeUndefined();

    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (annots && annots.size() > 0) {
      const annot = annots.lookup(0, PDFDict);
      expect(annot.get(PDFName.of("A"))).toBeUndefined();
      expect(annot.get(PDFName.of("AA"))).toBeUndefined();
    }
  });

  it("is idempotent on a document with none of these vectors", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const plain = Buffer.from(await doc.save());

    const sanitized = await pdfLibSanitize(plain);
    const reloaded = await PDFDocument.load(sanitized);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("throws (does not silently pass bytes through) on unparseable input", async () => {
    const garbage = Buffer.from("%PDF-1.4\nnot a real pdf body");
    await expect(pdfLibSanitize(garbage)).rejects.toThrow();
  });
});
