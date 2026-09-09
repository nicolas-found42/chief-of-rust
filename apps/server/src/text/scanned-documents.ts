import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeTextLf, SourceError } from "./convert.js";

/**
 * Scanned PDFs as grounded evidence (issue #247).
 *
 * The text-layer extractor in convert.ts reads a scanned (image-only) PDF as
 * empty: there are no text operators to extract, so the document either fails
 * as an empty file or never reaches a claim at all. This module sits beside
 * that extractor and answers the two questions it cannot: which pages carry a
 * text layer and which need OCR, and — when no OCR engine is available — what
 * exactly is missing. Without the per-page shape below, a claim built on an
 * OCR'd document could not cite the page it rests on, which is the same as
 * having no citation a reader can check.
 */

/** One PDF page's extracted text and where that text came from. */
export interface PdfPageSegment {
  /** 1-based page number, so a claim can cite the page it rests on. */
  page: number;
  text: string;
  /** Whether this page was read from the PDF text layer or via OCR. */
  origin: "text-layer" | "ocr";
}

export interface ScannedPdfExtraction {
  segments: PdfPageSegment[];
  /** True when any segment came from the OCR engine rather than the text layer. */
  ocrApplied: boolean;
}

/**
 * The OCR port. Production resolves one via detectSystemTesseract (system
 * pdftoppm + tesseract binaries, both detected at runtime); tests inject a
 * fake, so CI stays deterministic and needs no binary. The engine reads
 * whole-PDF bytes and answers one string per page, in page order: the PDF is
 * rasterised to per-page images with pdftoppm and each image is OCR'd by
 * tesseract — system binaries only, no npm dependency.
 */
export interface OcrEngine {
  readonly name: string;
  recognizePdf(pdfBytes: Buffer): Promise<string[]>;
}

/* convert.ts keeps this private; the scanned path needs the same
   file-versus-converter distinction so an unparseable document keeps its
   parser location instead of reading as a programming failure (#247). */
function isProgrammingFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    (error instanceof Error && error.name === "AssertionError")
  );
}

function pdfTextItems(content: { items: unknown[] }): string {
  return content.items
    .map((item) => {
      if (
        typeof item === "object" &&
        item !== null &&
        "str" in item &&
        typeof item.str === "string"
      ) {
        return item.str;
      }
      return "";
    })
    .join(" ");
}

/**
 * The honest gap for a scanned PDF no available engine can read: it names the
 * unsupported format and carries a reproduction pointer, reusing the
 * ConversionDiagnostic conventions, so the failure is never
 * Thrown when no engine was passed — an engine that was passed but fails
 * operationally preserves its own diagnostic classification instead.
 */
export function scannedPdfGapError(fileName: string, bytes: Buffer): SourceError {
  return new SourceError(
    "SOURCE_UNSUPPORTED",
    `The PDF '${fileName}' is a scanned (image-only) document with no text layer ` +
      `(format pdf) and no OCR engine is available. ` +
      `Reproduce with: save the document bytes to /tmp/scanned.pdf and run ` +
      `extractPdfSegments with a system tesseract OCR engine.`,
    {
      classification: "unsupported_format",
      format: "pdf",
      bytes: bytes.byteLength,
      step: "extract_pdf",
    },
  );
}

/**
 * Extract one PDF's text as per-page segments. Pages with a text layer keep
 * it; pages without one are read through the OCR engine when given. A fully
 * scanned PDF with no engine fails with scannedPdfGapError rather than with
 * an empty-file diagnostic that never names what is missing.
 */
export async function extractPdfSegments(
  fileName: string,
  bytes: Buffer,
  ocr?: OcrEngine | null,
): Promise<ScannedPdfExtraction> {
  if (extname(fileName).toLowerCase() !== ".pdf") {
    const format = extname(fileName).slice(1).toLowerCase() || "unknown";
    throw new SourceError("SOURCE_UNSUPPORTED", `Unsupported file format: ${format}.`, {
      classification: "unsupported_format",
      format,
      bytes: bytes.byteLength,
      step: "detect_format",
    });
  }
  let layer: string[];
  try {
    const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(normalizeTextLf(pdfTextItems(content)).trim());
    }
    layer = pages;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const fileCaused = !isProgrammingFailure(error);
    throw new SourceError(
      "SOURCE_INVALID",
      fileCaused ? "The PDF could not be read." : "The PDF converter failed.",
      {
        classification: fileCaused ? "invalid_file" : "converter_failure",
        format: "pdf",
        bytes: bytes.byteLength,
        step: "extract_pdf",
      },
    );
  }
  const blank = layer.map((text) => text.length === 0);
  if (blank.every(Boolean)) {
    if (!ocr) throw scannedPdfGapError(fileName, bytes);
    const segments = ocrSegments(layer.length, await recognizePdf(ocr, bytes, layer.length));
    requireOcrText(segments, bytes);
    return { segments, ocrApplied: true };
  }
  if (blank.some(Boolean) && ocr) {
    const recognized = await recognizePdf(ocr, bytes, layer.length);
    return {
      segments: layer.map((text, index) => ({
        page: index + 1,
        text: text.length > 0 ? text : normalizeTextLf(recognized[index] ?? "").trim(),
        origin: text.length > 0 ? ("text-layer" as const) : ("ocr" as const),
      })),
      ocrApplied: true,
    };
  }
  return {
    segments: layer.map((text, index) => ({
      page: index + 1,
      text,
      origin: "text-layer" as const,
    })),
    ocrApplied: false,
  };
}

async function recognizePdf(ocr: OcrEngine, bytes: Buffer, pageCount: number): Promise<string[]> {
  let recognized: string[];
  try {
    recognized = await ocr.recognizePdf(bytes);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(
      "SOURCE_INVALID",
      `The OCR engine failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      {
        classification: "converter_failure",
        format: "pdf",
        bytes: bytes.byteLength,
        step: "extract_pdf",
      },
    );
  }
  if (recognized.length !== pageCount) {
    throw new SourceError(
      "SOURCE_INVALID",
      `The OCR engine answered ${recognized.length} pages for a ${pageCount}-page PDF; page attribution would drift.`,
      {
        classification: "converter_failure",
        format: "pdf",
        bytes: bytes.byteLength,
        step: "extract_pdf",
      },
    );
  }
  return recognized;
}

function ocrSegments(pageCount: number, recognized: string[]): PdfPageSegment[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    page: index + 1,
    text: normalizeTextLf(recognized[index] ?? "").trim(),
    origin: "ocr" as const,
  }));
}

function requireOcrText(segments: PdfPageSegment[], bytes: Buffer): void {
  if (segments.every((segment) => segment.text.length === 0)) {
    throw new SourceError("SOURCE_INVALID", "The file contains no readable text.", {
      classification: "empty_file",
      format: "pdf",
      bytes: bytes.byteLength,
      step: "validate_text",
    });
  }
}

/**
 * Render segments into retained text whose page markers the document reader's
 * existing pageAnchors pass (`\n[page N]\n`) already recognises, so a claim
 * built on OCR text cites the page it rests on. The integration owner wires
 * this into readDocument (see the PR body): render here, keep anchors there.
 */
export function renderPdfSegments(segments: PdfPageSegment[]): string {
  return segments.map((segment) => `\n[page ${segment.page}]\n${segment.text}`).join("");
}

const runFile = promisify(execFile);

/**
 * Detect the production OCR adapter at runtime: system `pdftoppm` (poppler)
 * and `tesseract` binaries on PATH, used only when both are present. Resolves
 * to null where the binaries are absent (notably CI) or unreadable — callers
 * treat null as "no engine" and take the scannedPdfGapError path, so detection
 * never throws and never needs an install. No cloud OCR, no new dependency.
 */
export async function detectSystemTesseract(): Promise<OcrEngine | null> {
  try {
    await runFile("tesseract", ["--version"], { timeout: 10_000 });
    await runFile("pdftoppm", ["-v"], { timeout: 10_000 });
  } catch {
    return null;
  }
  return {
    name: "tesseract",
    recognizePdf: (pdfBytes: Buffer) => rasterizeAndRecognize(pdfBytes, runFile),
  };
}

/** The process seam the production engine runs through (promisified execFile). */
type ProcessRunner = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer }>;

/**
 * Rasterise one PDF to per-page images and OCR each in page order, answering
 * one string per page. Tesseract does not rasterise PDF input, so the pages
 * are rendered by poppler's pdftoppm first; the images are listed from the
 * rasteriser's own output directory and ordered by page number, never by
 * name alone.
 */
export async function rasterizeAndRecognize(
  pdfBytes: Buffer,
  run: ProcessRunner,
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "scanned-pdf-ocr-"));
  try {
    const source = join(dir, "source.pdf");
    writeFileSync(source, pdfBytes);
    const prefix = join(dir, "page");
    await run("pdftoppm", ["-r", "150", "-png", source, prefix], { timeout: 240_000 });
    const images = readdirSync(dir)
      .map((entry: string) => ({ entry, page: /page-(\d+)\.png$/.exec(entry)?.[1] }))
      .filter((image): image is { entry: string; page: string } => image.page !== undefined)
      .sort((a, b) => Number(a.page) - Number(b.page))
      .map((image) => join(dir, image.entry));
    if (images.length === 0) {
      throw new SourceError("SOURCE_INVALID", "The PDF rasteriser produced no page images.", {
        classification: "converter_failure",
        format: "pdf",
        bytes: pdfBytes.byteLength,
        step: "extract_pdf",
      });
    }
    const pages: string[] = [];
    for (const image of images) {
      const { stdout } = await run("tesseract", [image, "stdout", "-l", "eng"], {
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      pages.push(normalizeTextLf(String(stdout)).trim());
    }
    return pages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
