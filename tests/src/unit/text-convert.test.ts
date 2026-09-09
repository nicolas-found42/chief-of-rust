import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  SourceError,
  convertToText,
  normalizeTextLf,
  sentencesToText,
} from "../../../apps/server/src/text/convert";

describe("sentencesToText", () => {
  it("renders speaker lines in index order regardless of array order", () => {
    const input = [
      { index: 2, speaker_name: "Priya", text: "second", start_time: 40 },
      { index: 0, speaker_name: "Dana", text: "first", start_time: 0 },
      { index: 1, speaker_name: "Sam", text: "middle", start_time: 20 },
    ];
    expect(sentencesToText(input)).toBe("Dana: first\nSam: middle\nPriya: second");
  });

  it("falls back to start_time ordering when index is absent", () => {
    const input = [
      { speaker_name: "B", text: "later", start_time: 9_000 },
      { speaker_name: "A", text: "earlier", start_time: 1_000 },
    ];
    expect(sentencesToText(input)).toBe("A: earlier\nB: later");
  });

  it("accepts startTime as the alias for start_time", () => {
    const input = [{ speaker_name: "A", text: "hi", startTime: 5 }];
    expect(sentencesToText(input)).toBe("A: hi");
  });

  it("accepts sentence as the alias for text", () => {
    const input = [{ speaker_name: "A", sentence: "hello", start_time: 1 }];
    expect(sentencesToText(input)).toBe("A: hello");
  });

  it("throws SOURCE_INVALID for a non-Fireflies JSON object", () => {
    expect(() => sentencesToText({ foo: "bar" })).toThrowError(SourceError);
    try {
      sentencesToText({ foo: "bar" });
    } catch (error) {
      expect((error as SourceError).code).toBe("SOURCE_INVALID");
    }
  });

  it("throws SOURCE_INVALID for an array of non-sentence entries", () => {
    expect(() => sentencesToText([1, 2, 3])).toThrowError(SourceError);
    expect(() => sentencesToText([{ text: "no speaker" }])).toThrowError(SourceError);
  });
});

describe("convertToText", () => {
  it("decodes .txt/.md as UTF-8 with normalized LF endings", async () => {
    const bytes = Buffer.from("line one\r\nline two\rline three\n", "utf8");
    expect(await convertToText("notes.md", bytes)).toBe("line one\nline two\nline three\n");
  });

  it("round-trips a Fireflies sentences JSON export", async () => {
    const sentences = [
      { index: 1, speaker_name: "Dana", text: "hello", start_time: 1 },
      { index: 0, speaker_name: "Sam", text: "hi", start_time: 0 },
    ];
    const text = await convertToText("fireflies.json", Buffer.from(JSON.stringify(sentences)));
    expect(text).toBe("Sam: hi\nDana: hello");
  });

  it("extracts text from a structurally valid DOCX", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" /></Types>',
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml" /></Relationships>',
    );
    zip.file(
      "word/document.xml",
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Private meeting text</w:t></w:r></w:p></w:body></w:document>',
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    expect(await convertToText("meeting.docx", bytes)).toBe("Private meeting text\n\n");
  });

  it("throws SOURCE_INVALID for JSON that is not a sentences array", async () => {
    await expect(
      convertToText("data.json", Buffer.from('{"kind": "report"}')),
    ).rejects.toThrowError(SourceError);
  });

  it("classifies an unsupported format at detection without retaining document text", async () => {
    const privateText = "PRIVATE TRANSCRIPT MARKER";

    try {
      await convertToText("sheet.xlsx", Buffer.from(privateText));
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceError);
      expect(error).toMatchObject({
        code: "SOURCE_UNSUPPORTED",
        diagnostic: {
          classification: "unsupported_format",
          format: "xlsx",
          bytes: Buffer.byteLength(privateText),
          step: "detect_format",
        },
      });
      expect(JSON.stringify(error)).not.toContain(privateText);
      expect((error as Error).message).not.toContain(privateText);
    }
  });

  it("classifies a ZIP-backed spreadsheet as unsupported rather than corrupt", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("xl/workbook.xml", "<workbook />");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    try {
      await convertToText("sheet.xlsx", bytes);
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SOURCE_UNSUPPORTED",
        diagnostic: {
          classification: "unsupported_format",
          format: "zip",
          bytes: bytes.byteLength,
          step: "detect_format",
        },
      });
    }
  });

  it("classifies malformed JSON at parsing without retaining the parser excerpt", async () => {
    const privateText = '{"PRIVATE TRANSCRIPT MARKER"';

    try {
      await convertToText("meeting.json", Buffer.from(privateText));
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SOURCE_INVALID",
        diagnostic: {
          classification: "invalid_file",
          format: "json",
          bytes: Buffer.byteLength(privateText),
          step: "parse_json",
        },
      });
      expect(JSON.stringify(error)).not.toContain("PRIVATE TRANSCRIPT MARKER");
      expect((error as Error).message).not.toContain("PRIVATE TRANSCRIPT MARKER");
    }
  });

  it("classifies an empty supported document separately from a corrupt one", async () => {
    try {
      await convertToText("meeting.pdf", Buffer.alloc(0));
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SOURCE_INVALID",
        diagnostic: {
          classification: "empty_file",
          format: "pdf",
          bytes: 0,
          step: "validate_text",
        },
      });
    }
  });

  it("names the extraction step for a truncated supported document", async () => {
    const truncated = Buffer.from("%PDF-1.7\nPRIVATE TRANSCRIPT MARKER");

    try {
      await convertToText("meeting.pdf", truncated);
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SOURCE_INVALID",
        diagnostic: {
          classification: "invalid_file",
          format: "pdf",
          bytes: truncated.byteLength,
          step: "extract_pdf",
        },
      });
      expect(JSON.stringify(error)).not.toContain("PRIVATE TRANSCRIPT MARKER");
      expect((error as Error).message).not.toContain("PRIVATE TRANSCRIPT MARKER");
    }
  });

  it("detects a strong document signature instead of trusting the extension", async () => {
    const docxBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("[Content_Types].xml word/document.xml"),
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    ]);

    try {
      await convertToText("renamed.pdf", docxBytes);
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SOURCE_INVALID",
        diagnostic: {
          classification: "invalid_file",
          format: "docx",
          bytes: docxBytes.byteLength,
          step: "detect_format",
        },
      });
    }
  });

  it("reports an unknown format when binary contents do not match the claimed type", async () => {
    const bytes = Buffer.from("not a PDF document");

    try {
      await convertToText("renamed.pdf", bytes);
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SOURCE_INVALID",
        diagnostic: {
          classification: "invalid_file",
          format: "unknown",
          bytes: bytes.byteLength,
          step: "detect_format",
        },
      });
    }
  });

  it("classifies a truncated DOCX as a file fault before extraction", async () => {
    const truncated = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("word/document.xml"),
    ]);

    try {
      await convertToText("meeting.docx", truncated);
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SOURCE_INVALID",
        diagnostic: {
          classification: "invalid_file",
          format: "docx",
          bytes: truncated.byteLength,
          step: "extract_docx",
        },
      });
    }
  });

  it("classifies invalid DOCX internals as a file fault", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document><not-a-body /></w:document>");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    try {
      await convertToText("meeting.docx", bytes);
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SOURCE_INVALID",
        diagnostic: {
          classification: "invalid_file",
          format: "docx",
          bytes: bytes.byteLength,
          step: "extract_docx",
        },
      });
    }
  });
});

describe("normalizeTextLf", () => {
  it("normalizes CR and CRLF to LF", () => {
    expect(normalizeTextLf("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});
