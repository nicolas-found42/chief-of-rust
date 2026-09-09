import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";

/**
 * Scanned PDFs at the document-reader seam (issue #247).
 *
 * The seam contract: a PDF retrieved as bytes goes through per-page
 * segmentation (so retained text carries the `[page N]` markers the anchor
 * pass cites), and a scanned PDF with no OCR engine fails with an
 * unsupported-format record naming exactly what is missing — never as a
 * parser failure that reads as a broken file.
 */

/** The smallest PDF carrying one line of extractable text. */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(startxref)}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** The same document shape with no text operators: every page reads blank. */
function minimalImageOnlyPdf(): Buffer {
  const stream = "0 0 0 RG 1 w 72 720 m 200 720 l S";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(startxref)}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function ports(recorder: ResearchAttemptRecorder, bytes: Buffer): ReaderPorts {
  return fromPartial<ReaderPorts>({
    fetch: async () => {
      throw new Error("The document is fetched as bytes, not text.");
    },
    fetchBytes: async (url: string) => ({
      url,
      status: 200,
      contentType: "application/pdf",
      retryAfter: null,
      bytes,
    }),
    recorder,
    timeoutMs: 1000,
    /* CI has no OCR binary and these tests must not depend on one: the seam
       resolves to no engine, which is exactly the production CI path. */
    systemOcr: async () => null,
  });
}

test("a text-layer PDF routes through page segmentation and keeps its page anchors", async () => {
  const recorder = new ResearchAttemptRecorder("operation-scanned-reader");
  const result = await readPersonSource(
    "https://bank.example/reports/annual.pdf",
    "",
    ports(recorder, minimalPdf("Captured annual report text")),
  );

  expect(result.access).toBe("retrieved");
  expect(result.route).toBe("document-reader");
  expect(result.text).toContain("\n[page 1]\nCaptured annual report text");
  expect(result.anchors.length).toBeGreaterThan(0);
});

test("a scanned PDF with no engine retains nothing and names the missing OCR", async () => {
  const recorder = new ResearchAttemptRecorder("operation-scanned-gap");
  const result = await readPersonSource(
    "https://bank.example/reports/scanned.pdf",
    "",
    ports(recorder, minimalImageOnlyPdf()),
  );

  expect(result.access).not.toBe("retrieved");
  const [failure] = recorder.failures();
  expect([failure.collector, failure.code, failure.cause, failure.outcome]).toEqual([
    "document-reader",
    "unsupported-format",
    "observed",
    "failed",
  ]);
  expect(failure.reason).toContain("Reproduce with:");
});
