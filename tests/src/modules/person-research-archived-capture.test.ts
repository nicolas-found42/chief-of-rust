import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, expect, test } from "vitest";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  WAYBACK_CAPTURE_ROUTE,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

/**
 * Archived captures as dated historical evidence (issue #253).
 *
 * The failure these guard is specific: a Profile that presents a past position
 * as current is worse than one that omits it, because a reader preparing for a
 * meeting acts on it. So the capture date has to survive retrieval, reach every
 * claim the capture grounds, and stop a captured "current" role from being
 * written onto the Profile as current — and an archive service answering with
 * its own error page must never be retained as evidence at all.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The authored historical reference fact this evidence has to ground (#242). */
function historicalReference() {
  const corpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const person = corpus.people.find((entry) => entry.slug === "minouche-shafik")!;
  const fact = person.facts.find((entry) => entry.id === "boe-tenure-archive")!;
  const support = fact.support[0];
  const document = person.documents.find((entry) => entry.id === support.documentId)!;
  return { fact, quote: support.quote, document };
}

/** The capture excerpt as the archive serves it: one paragraph per line. */
const archivedPage = (title: string, excerpt: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article>${excerpt
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `<p>${line}</p>`)
    .join("")}</article></body></html>`;

const ports = (recorder: ResearchAttemptRecorder, fetch: ReaderPorts["fetch"]): ReaderPorts =>
  fromPartial({ fetch, recorder, timeoutMs: 1000 });

test("an archived capture grounds an authored historical reference fact and dates every claim it supports", async () => {
  const { fact, quote, document } = historicalReference();
  const root = mkdtempSync(join(tmpdir(), "research-capture-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Nemat (Minouche) Shafik" });
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [{ url: document.url, title: document.title, snippet: "" }],
    fetch: async (url) => ({
      url,
      status: url.includes("id_/") ? 200 : 404,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url.includes("id_/") ? archivedPage(document.title, document.excerpt) : "",
    }),
    complete: async () => ({
      fullName: null,
      employer: null,
      sourceClass: "self-report",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "boe-tenure",
          section: "career",
          statement: fact.statement,
          /* The model reports the page's own wording: a role, open-ended,
             exactly the shape that would read as current without its date. */
          fact: { field: "role", value: "Deputy Governor, Markets and Banking" },
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: fact.effectiveFrom,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });

  await research.run(person, researchAllowance({ maxModelCalls: 4, maxMilliseconds: 20_000 }));

  const dossier = dossiers.get(person.id)!;
  const claim = dossier.claims.find((entry) => entry.statement === fact.statement)!;
  expect(claim.citations[0].quote).toBe(quote);
  const source = dossiers.source(person.id, claim.citations[0].sourceId)!;
  /* Retained content, not a capture listing: the archived text is what the
     claim is grounded in. */
  expect(source.text).toContain(quote);
  expect(source.capturedAt).toBe("2024-05-23T20:03:41.000Z");
  expect(claim.citations[0].capturedAt).toBe(source.capturedAt);
  /* A former role stays former: the capture bounds it, and nothing writes it
     onto the Profile as the person's current role. */
  expect(claim.effectiveTo).toBe("2024-05-23");
  expect(claim.status).toBe("stale");
  expect(people.get(person.id)?.role).toBeNull();
});

test("a capture the archive does not hold retains nothing and records its observed cause", async () => {
  const recorder = new ResearchAttemptRecorder("operation-missing");
  const result = await readPersonSource(
    /* Written without the captured address's scheme, as the archive also
       writes it; that is still one capture address, not a live URL. */
    "https://web.archive.org/web/20240523200341/example.com/gone",
    "",
    ports(recorder, async (url) => ({
      url,
      status: 404,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: "<html><title>Wayback Machine</title><body>not archived</body></html>",
    })),
  );

  expect(result.access).not.toBe("retrieved");
  expect(result.capturedAt).toBeNull();
  expect(
    recorder
      .failures()
      .map((attempt) => [attempt.collector, attempt.code, attempt.cause, attempt.outcome]),
  ).toContainEqual(["archive-reader", "resource-unavailable", "observed", "failed"]);
});

test("an archive error page answered with HTTP 200 is never retained as successful evidence", async () => {
  const recorder = new ResearchAttemptRecorder("operation-error-page");
  const body =
    "<!doctype html><html><head><title>Wayback Machine</title></head><body>" +
    "<h1>Hrm.</h1><p>The Wayback Machine has not archived that URL.</p>" +
    "<p>This page is having technical difficulties; please try again later.</p></body></html>";
  const result = await readPersonSource(
    "https://web.archive.org/web/20240523200341/https://example.com/team",
    "",
    ports(recorder, async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    })),
  );

  expect(result.access).not.toBe("retrieved");
  expect(result.text).toBe("");
  const failure = recorder.failures().find((attempt) => attempt.code === "archive-error-page")!;
  expect([failure.collector, failure.cause, failure.outcome]).toEqual([
    "archive-reader",
    "observed",
    "failed",
  ]);
  /* Shape only: the diagnostic records what was seen, never the page's text. */
  expect(failure.observed?.excerpt).toBeUndefined();
  expect(failure.observed?.status).toBe(200);
  expect(failure.observed?.bytes).toBe(body.length);
});

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

test("an archived document is fetched once, by the reader whose bytes are retained", async () => {
  const recorder = new ResearchAttemptRecorder("operation-document");
  const requested: { route: "text" | "bytes"; url: string }[] = [];
  const result = await readPersonSource(
    "https://web.archive.org/web/20240523200341/https://bank.example/reports/annual.pdf",
    "",
    fromPartial<ReaderPorts>({
      fetch: async (url: string) => {
        requested.push({ route: "text", url });
        throw new Error("The capture must not be asked for as text as well.");
      },
      fetchBytes: async (url: string) => {
        requested.push({ route: "bytes", url });
        return {
          url,
          status: 200,
          contentType: "application/pdf",
          retryAfter: null,
          bytes: minimalPdf("Captured annual report text"),
        };
      },
      recorder,
      timeoutMs: 1000,
    }),
  );

  /* One request, and it is the one whose bytes were parsed: a second fetch
     leaves the archive free to answer differently from the response that was
     checked for an error page and dated. */
  expect(requested).toEqual([
    {
      route: "bytes",
      url: "https://web.archive.org/web/20240523200341id_/https://bank.example/reports/annual.pdf",
    },
  ]);
  expect(result.access).toBe("retrieved");
  expect(result.route).toBe(WAYBACK_CAPTURE_ROUTE);
  expect(result.text).toContain("Captured annual report text");
  expect(result.capturedAt).toBe("2024-05-23T20:03:41.000Z");
  expect(result.upstreamIndex).toBe("bank.example");
});

/* A document address is no guarantee the archive answers with a document. When
   it answers with its own error page instead, the converter would call the file
   broken; the fault is the archive's and the capture was never read. */
test("an archived document answered by the archive's error page retains nothing", async () => {
  const recorder = new ResearchAttemptRecorder("operation-error-page");
  const result = await readPersonSource(
    "https://web.archive.org/web/20240523200341/https://bank.example/reports/annual.pdf",
    "Search snippet naming the person",
    fromPartial<ReaderPorts>({
      fetch: async () => {
        throw new Error("The capture must not be asked for as text as well.");
      },
      fetchBytes: async (url: string) => ({
        url,
        status: 200,
        contentType: "text/html; charset=utf-8",
        retryAfter: null,
        bytes: Buffer.from(
          "<html><body><h1>Internet Archive</h1><p>We are having technical difficulties.</p></body></html>",
          "utf8",
        ),
      }),
      recorder,
      timeoutMs: 1000,
    }),
  );

  /* The archive's fault, named as such rather than as a broken document. */
  expect(result.access).not.toBe("retrieved");
  const codes = recorder.failures().map((attempt) => attempt.code);
  expect(codes).toContain("archive-error-page");
  expect(codes).not.toContain("parser-failed");
  /* Nothing retained — not the archive's page, and not the snippet the caller
     brought, which is search text about the person and no evidence at all. */
  expect(result.text).toBe("");
});

test("an archived document that could not be retrieved retains no snippet", async () => {
  const recorder = new ResearchAttemptRecorder("operation-missing");
  const result = await readPersonSource(
    "https://web.archive.org/web/20240523200341/https://bank.example/reports/annual.pdf",
    "Search snippet naming the person",
    fromPartial<ReaderPorts>({
      fetch: async () => {
        throw new Error("The capture must not be asked for as text as well.");
      },
      fetchBytes: async (url: string) => ({
        url,
        status: 404,
        contentType: "text/html",
        retryAfter: null,
        bytes: Buffer.from("not found", "utf8"),
      }),
      recorder,
      timeoutMs: 1000,
    }),
  );

  expect(result.access).not.toBe("retrieved");
  expect(result.text).toBe("");
  expect(result.route).toBe(WAYBACK_CAPTURE_ROUTE);
});
