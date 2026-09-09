import { extname } from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ConversionDiagnostic } from "@chief-of-staff-demo/shared";

const SUPPORTED_EXTENSIONS: Record<string, true> = {
  ".txt": true,
  ".md": true,
  ".json": true,
  ".jsonc": true,
  ".pdf": true,
  ".docx": true,
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type SourceErrorCode = "SOURCE_INVALID" | "SOURCE_UNSUPPORTED";

export class SourceError extends Error {
  constructor(
    public readonly code: SourceErrorCode,
    message: string,
    public readonly diagnostic?: ConversionDiagnostic,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

function claimedFormat(fileName: string): string {
  const extension = extname(fileName).slice(1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(extension) ? extension : "unknown";
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function contains(bytes: Buffer, value: Buffer): boolean {
  return bytes.includes(value);
}

function isPlausibleDocx(bytes: Buffer): boolean {
  return (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) &&
    contains(bytes, Buffer.from([0x50, 0x4b, 0x05, 0x06])) &&
    contains(bytes, Buffer.from("[Content_Types].xml")) &&
    contains(bytes, Buffer.from("word/document.xml"))
  );
}

function isProgrammingFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    (error instanceof Error && error.name === "AssertionError")
  );
}

function signatureFormat(bytes: Buffer): "pdf" | "docx" | "zip" | null {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (isPlausibleDocx(bytes)) return "docx";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  return null;
}

function detectedFormat(fileName: string, bytes: Buffer): string {
  const claimed = claimedFormat(fileName);
  if (bytes.byteLength === 0) return claimed;
  const signature = signatureFormat(bytes);
  if (signature === "zip" && claimed === "docx") return "docx";
  if (signature !== null) return signature;
  return claimed === "pdf" || claimed === "docx" ? "unknown" : claimed;
}

export function diagnoseConversionFailure(
  error: unknown,
  fileName: string,
  bytes: Buffer,
): ConversionDiagnostic {
  if (error instanceof SourceError && error.diagnostic) return error.diagnostic;
  return {
    classification: "converter_failure",
    format: detectedFormat(fileName, bytes),
    bytes: bytes.byteLength,
    step: "convert_file",
  };
}

function conversionError(
  code: SourceErrorCode,
  message: string,
  diagnostic: ConversionDiagnostic,
): SourceError {
  return new SourceError(code, message, diagnostic);
}

function requireText(text: string, format: string, bytes: number): string {
  const normalized = normalizeTextLf(text);
  if (normalized.trim().length === 0) {
    throw conversionError("SOURCE_INVALID", "The file contains no readable text.", {
      classification: "empty_file",
      format,
      bytes,
      step: "validate_text",
    });
  }
  return normalized;
}

async function validateDocx(bytes: Buffer, format: string): Promise<void> {
  try {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const contentTypes = zip.file("[Content_Types].xml");
    const document = zip.file("word/document.xml");
    if (!contentTypes || !document) {
      throw new Error("required DOCX parts are absent");
    }
    const xml = await document.async("string");
    if (!/<(?:[A-Za-z_][\w.-]*:)?document(?:\s|>)/.test(xml)) {
      throw new Error("required DOCX document element is absent");
    }
    if (!/<(?:[A-Za-z_][\w.-]*:)?body(?:\s|>)/.test(xml)) {
      throw new Error("required DOCX document elements are absent");
    }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw conversionError("SOURCE_INVALID", "The DOCX file could not be read.", {
      classification: isProgrammingFailure(error) ? "converter_failure" : "invalid_file",
      format,
      bytes: bytes.byteLength,
      step: "extract_docx",
    });
  }
}

export function isSupportedFileName(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS[extname(fileName).toLowerCase()] === true;
}

export function normalizeTextLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function conversionFailureHint(diagnostic: ConversionDiagnostic): string {
  switch (diagnostic.classification) {
    case "unsupported_format":
      return "This file format is not supported. Convert the file to TXT, Markdown, JSON, PDF, or DOCX, then add it again.";
    case "empty_file":
      return "This file contains no readable text. Replace it with a complete file.";
    case "invalid_file":
      return "This file is corrupt or does not match its format. Replace or repair the file.";
    case "converter_failure":
      return "The app could not convert this file. Report the conversion diagnostic.";
  }
}

interface SentenceLike {
  speaker_name: string;
  text: string;
  /** Absent and `undefined` alike mean the export carried no ordering key. */
  index?: number | undefined;
  start_time?: number | undefined;
}

function invalidSentence(position: number): SourceError {
  return new SourceError(
    "SOURCE_INVALID",
    `JSON entry ${position} is not a sentence object: expected { speaker_name, text, start_time } (Fireflies sentences export)`,
  );
}

/**
 * Convert a Fireflies-style sentences array into transcript text:
 * one `Speaker: text` line per sentence, ordered by `index`
 * (falling back to `start_time` when indexes are absent).
 */
export function sentencesToText(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0) {
    throw new SourceError(
      "SOURCE_INVALID",
      "JSON transcript must be a non-empty array of sentence objects",
    );
  }
  const sentences: SentenceLike[] = data.map((entry, position) => {
    if (typeof entry !== "object" || entry === null) {
      throw invalidSentence(position);
    }
    const obj = entry as Record<string, unknown>;
    const speaker = obj.speaker_name;
    const text = obj.text ?? obj.sentence;
    if (typeof speaker !== "string" || typeof text !== "string") {
      throw invalidSentence(position);
    }
    return {
      speaker_name: speaker,
      text,
      index: typeof obj.index === "number" ? obj.index : undefined,
      start_time:
        typeof obj.start_time === "number"
          ? obj.start_time
          : typeof obj.startTime === "number"
            ? obj.startTime
            : undefined,
    };
  });
  if (sentences.every((s) => typeof s.index === "number")) {
    sentences.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  } else {
    sentences.sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
  }
  return sentences.map((s) => `${s.speaker_name}: ${s.text}`).join("\n");
}

/** Parse a Drive file into normalized UTF-8 text with LF endings. */
export async function convertToText(fileName: string, bytes: Buffer): Promise<string> {
  const ext = extname(fileName).toLowerCase();
  const claimed = claimedFormat(fileName);
  const format = detectedFormat(fileName, bytes);
  if (!SUPPORTED_EXTENSIONS[ext]) {
    throw conversionError("SOURCE_UNSUPPORTED", `Unsupported file format: ${format}.`, {
      classification: "unsupported_format",
      format,
      bytes: bytes.byteLength,
      step: "detect_format",
    });
  }
  if (format !== claimed) {
    throw conversionError("SOURCE_INVALID", "The file contents do not match its filename format.", {
      classification: "invalid_file",
      format,
      bytes: bytes.byteLength,
      step: "detect_format",
    });
  }
  if (bytes.byteLength === 0) {
    throw conversionError("SOURCE_INVALID", "The file contains no readable text.", {
      classification: "empty_file",
      format,
      bytes: 0,
      step: "validate_text",
    });
  }
  if (ext === ".txt" || ext === ".md") {
    return requireText(bytes.toString("utf8"), format, bytes.byteLength);
  }
  if (ext === ".json" || ext === ".jsonc") {
    let raw = bytes.toString("utf8");
    if (ext === ".jsonc") {
      raw = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw conversionError("SOURCE_INVALID", "The file is not valid JSON.", {
        classification: "invalid_file",
        format,
        bytes: bytes.byteLength,
        step: "parse_json",
      });
    }
    try {
      return requireText(sentencesToText(parsed), format, bytes.byteLength);
    } catch (error) {
      if (!(error instanceof SourceError) || error.diagnostic) throw error;
      throw conversionError(error.code, error.message, {
        classification: "invalid_file",
        format,
        bytes: bytes.byteLength,
        step: "validate_transcript",
      });
    }
  }
  if (ext === ".pdf") {
    try {
      const data = new Uint8Array(bytes);
      const doc = await getDocument({ data }).promise;
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(
          content.items
            .map((item) => {
              if (typeof item === "object" && "str" in item && typeof item.str === "string") {
                return item.str;
              }
              return "";
            })
            .join(" "),
        );
      }
      return requireText(pages.join("\n"), format, bytes.byteLength);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      const fileCaused = !isProgrammingFailure(error);
      throw conversionError(
        "SOURCE_INVALID",
        fileCaused ? "The PDF could not be read." : "The PDF converter failed.",
        {
          classification: fileCaused ? "invalid_file" : "converter_failure",
          format,
          bytes: bytes.byteLength,
          step: "extract_pdf",
        },
      );
    }
  }
  // .docx
  if (!isPlausibleDocx(bytes)) {
    throw conversionError("SOURCE_INVALID", "The DOCX file could not be read.", {
      classification: "invalid_file",
      format,
      bytes: bytes.byteLength,
      step: "extract_docx",
    });
  }
  await validateDocx(bytes, format);
  try {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return requireText(result.value, format, bytes.byteLength);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const fileCaused = !isProgrammingFailure(error);
    throw conversionError(
      "SOURCE_INVALID",
      fileCaused ? "The DOCX file could not be read." : "The DOCX converter failed.",
      {
        classification: fileCaused ? "invalid_file" : "converter_failure",
        format,
        bytes: bytes.byteLength,
        step: "extract_docx",
      },
    );
  }
}
