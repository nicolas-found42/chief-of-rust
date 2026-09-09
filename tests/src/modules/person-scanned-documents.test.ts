import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { diagnoseConversionFailure, SourceError } from "../../../apps/server/src/text/convert.js";
import {
  detectSystemTesseract,
  extractPdfSegments,
  rasterizeAndRecognize,
  renderPdfSegments,
  scannedPdfGapError,
  type OcrEngine,
} from "../../../apps/server/src/text/scanned-documents.js";

/**
 * Scanned PDFs and OCR contribute grounded claims (issue #247).
 *
 * The failure these guard is specific: a scanned (image-only) PDF has no text
 * layer, so the text-layer extractor reads it as empty and the document either
 * contributes nothing or — worse — fails with a diagnostic that never names
 * what is actually missing. Page anchors matter for the same reason a claim
 * needs a citation: without the page a passage came from, the claim is not
 * grounded in anything a reader can check.
 */

/** Escape the PDF string-literal metacharacters in a text-layer line. */
function pdfString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Assemble a minimal valid PDF in memory: one content stream per page, either
 * a single text-showing line or an image-painting operation with no text
 * operators at all. Offsets are computed so pdfjs parses without repairs.
 */
function buildPdf(pages: ({ text: string } | { imageOnly: true })[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets: number[] = [];
  let nextObject = 1;
  const catalog = nextObject++;
  const pageTree = nextObject++;
  const font = nextObject++;
  const image = nextObject++;
  const pageObjects: number[] = [];
  const contentObjects: number[] = [];
  for (let index = 0; index < pages.length; index++) {
    pageObjects.push(nextObject++);
    contentObjects.push(nextObject++);
  }
  const totalObjects = nextObject - 1;
  const emit = (body: string | Buffer) => {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(typeof body === "string" ? Buffer.from(body, "ascii") : body);
  };
  const kids = pageObjects.map((id) => `${id} 0 R`).join(" ");
  emit(`${catalog} 0 obj\n<< /Type /Catalog /Pages ${pageTree} 0 R >>\nendobj\n`);
  emit(`${pageTree} 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  emit(`${font} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  const pixel = Buffer.from([0x80]);
  const imageHead =
    `${image} 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ` +
    `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n`;
  const imageBody = Buffer.concat([
    Buffer.from(imageHead, "ascii"),
    pixel,
    Buffer.from("\nendstream\nendobj\n", "ascii"),
  ]);
  offsets.push(Buffer.concat(chunks).length);
  chunks.push(imageBody);
  pages.forEach((page, index) => {
    const resources =
      "text" in page
        ? `/Font << /F1 ${font} 0 R >>`
        : `/XObject << /Im1 ${image} 0 R >> /Font << /F1 ${font} 0 R >>`;
    emit(
      `${pageObjects[index]} 0 obj\n<< /Type /Page /Parent ${pageTree} 0 R ` +
        `/MediaBox [0 0 612 792] /Resources << ${resources} >> ` +
        `/Contents ${contentObjects[index]} 0 R >>\nendobj\n`,
    );
    const ops =
      "text" in page
        ? `BT /F1 24 Tf 72 720 Td (${pdfString(page.text)}) Tj ET`
        : `q 100 0 0 100 50 500 cm /Im1 Do Q`;
    const stream = Buffer.from(ops, "ascii");
    emit(`${contentObjects[index]} 0 obj\n<< /Length ${stream.length} >>\nstream\n`);
    chunks.push(stream);
    chunks.push(Buffer.from("\nendstream\nendobj\n", "ascii"));
  });
  const xrefAt = Buffer.concat(chunks).length;
  const xref: string[] = [`xref\n0 ${totalObjects + 1}\n`, "0000000000 65535 f \n"];
  for (let id = 1; id <= totalObjects; id++) {
    xref.push(`${String(offsets[id - 1]).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(Buffer.from(xref.join(""), "ascii"));
  chunks.push(
    Buffer.from(
      `trailer\n<< /Size ${totalObjects + 1} /Root ${catalog} 0 R >>\n` +
        `startxref\n${xrefAt}\n%%EOF`,
      "ascii",
    ),
  );
  return Buffer.concat(chunks);
}

const fakeOcr = (pages: string[]): OcrEngine => ({
  name: "fake-ocr",
  recognizePdf: async () => pages,
});

test("a text-layer PDF yields per-page segments without OCR", async () => {
  const bytes = buildPdf([{ text: "alpha bravo" }, { text: "charlie delta" }]);
  const result = await extractPdfSegments("report.pdf", bytes);
  expect(result.ocrApplied).toBe(false);
  expect(result.segments.map((segment) => segment.page)).toEqual([1, 2]);
  expect(result.segments.every((segment) => segment.origin === "text-layer")).toBe(true);
  expect(result.segments[0].text).toContain("alpha bravo");
  expect(result.segments[1].text).toContain("charlie delta");
});

test("a scanned PDF yields OCR text on the page it rests on", async () => {
  const bytes = buildPdf([{ imageOnly: true }]);
  const result = await extractPdfSegments("scan.pdf", bytes, fakeOcr(["scanned hello"]));
  expect(result.ocrApplied).toBe(true);
  expect(result.segments).toHaveLength(1);
  expect(result.segments[0]).toMatchObject({ page: 1, origin: "ocr" });
  expect(result.segments[0].text).toContain("scanned hello");
});

test("a scanned PDF with no OCR engine fails naming the format with a reproduction pointer", async () => {
  const bytes = buildPdf([{ imageOnly: true }]);
  const failure = await extractPdfSegments("scan.pdf", bytes).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SourceError);
  const sourceError = failure as SourceError;
  expect(sourceError.code).toBe("SOURCE_UNSUPPORTED");
  expect(sourceError.message).toContain("pdf");
  expect(sourceError.message).toContain("Reproduce with:");
  expect(sourceError.diagnostic?.classification).toBe("unsupported_format");
  expect(sourceError.diagnostic).toEqual(scannedPdfGapError("scan.pdf", bytes).diagnostic);
});

test("an engine that fails operationally fails as a converter fault, not as a missing-OCR gap", async () => {
  const bytes = buildPdf([{ imageOnly: true }]);
  const brokenEngine: OcrEngine = {
    name: "broken",
    recognizePdf: async () => {
      throw new Error("tesseract timed out after 120000ms");
    },
  };
  const failure = await extractPdfSegments("scan.pdf", bytes, brokenEngine).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SourceError);
  const sourceError = failure as SourceError;
  expect(sourceError.code).toBe("SOURCE_INVALID");
  expect(sourceError.message).toContain("tesseract timed out");
  expect(sourceError.diagnostic?.classification).toBe("converter_failure");
});

test("an engine answering the wrong page count fails instead of shifting OCR text across pages", async () => {
  const bytes = buildPdf([{ imageOnly: true }, { imageOnly: true }]);
  const mismatchEngine: OcrEngine = {
    name: "short",
    recognizePdf: async () => ["only one page"],
  };
  const failure = await extractPdfSegments("scan.pdf", bytes, mismatchEngine).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SourceError);
  const sourceError = failure as SourceError;
  expect(sourceError.code).toBe("SOURCE_INVALID");
  expect(sourceError.message).toMatch(/1 pages? for a 2-page PDF/i);
  expect(sourceError.diagnostic?.classification).toBe("converter_failure");
});

test("an unparseable document keeps its parser location through diagnoseConversionFailure", async () => {
  const bytes = Buffer.from("this is not a PDF at all", "utf8");
  const failure = await extractPdfSegments("broken.pdf", bytes).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SourceError);
  const diagnostic = diagnoseConversionFailure(failure, "broken.pdf", bytes);
  expect(diagnostic.step).toBe("extract_pdf");
  expect(diagnostic.format).toBe("pdf");
});

test("rendered segments carry page anchors a claim can cite", async () => {
  const bytes = buildPdf([{ text: "alpha bravo" }, { text: "charlie delta" }]);
  const result = await extractPdfSegments("report.pdf", bytes);
  const rendered = renderPdfSegments(result.segments);
  expect(rendered).toMatch(/\n\[page 1\]\n/);
  expect(rendered).toMatch(/\n\[page 2\]\n/);
  expect(rendered).toContain("alpha bravo");
});

test("no system tesseract here means detection resolves to no engine", async () => {
  await expect(detectSystemTesseract()).resolves.toBeNull();
});

test("the system engine rasterizes pages first and never hands tesseract a PDF input", async () => {
  const tesseractInputs: string[] = [];
  /* Production names page images to the page-count width: twelve pages pad
     to two digits. The listing order must survive names that sort badly. The
     fake derives the prefix from the arguments exactly as poppler does, so it
     writes into the same directory the engine lists. */
  const pages = await rasterizeAndRecognize(Buffer.from("%PDF-1.4 raster"), async (file, args) => {
    if (file === "pdftoppm") {
      const prefix = String(args[args.length - 1]);
      for (const number of [12, 2, 1, 10, 11, 3, 9, 4, 8, 5, 7, 6]) {
        writeFileSync(`${prefix}-${String(number).padStart(2, "0")}.png`, Buffer.from("png"));
      }
      return { stdout: "" };
    }
    tesseractInputs.push(String(args[0]));
    const match = /page-(\d+)\.png$/.exec(String(args[0]));
    if (!match) throw new Error(`tesseract was handed a non-image input: ${String(args[0])}`);
    return { stdout: `page ${String(Number(match[1]))} text\f` };
  });
  expect(tesseractInputs.every((input) => input.endsWith(".png"))).toBe(true);
  expect(pages).toEqual(Array.from({ length: 12 }, (_, index) => `page ${index + 1} text`));
});
