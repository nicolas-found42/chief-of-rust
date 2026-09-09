import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { SOURCE_ELIGIBILITY } from "../../../apps/server/src/source-adapters/eligibility.js";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  archivedCaptureDate,
  classifySourceFamily,
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";

/**
 * Common Crawl capture retrieval, or a recorded exclusion (issue #254).
 *
 * The eligibility record's `commoncrawl` route probes only the CDX index
 * catalogue (`collinfo.json`): the catalogue answering proves reachability and
 * says nothing about whether a capture's bytes can be retrieved, which is the
 * only thing that could contribute evidence to a Profile. The terms assessment
 * (ADR-0072) concludes the capture route is excluded — ToU §2(l) prohibits
 * collecting personal information for use separately from the Crawled Content,
 * and the ToU provides no citation exception — so these tests pin the
 * exclusion: index discovery stays distinct from capture retention in both the
 * code path and the source accounting, and no Common Crawl answer presents
 * itself as dated capture evidence.
 */

const ports = (
  recorder: ResearchAttemptRecorder,
  fetch: ReaderPorts["fetch"],
  fetchBytes?: ReaderPorts["fetchBytes"],
): ReaderPorts =>
  fromPartial({
    fetch,
    fetchBytes:
      fetchBytes ??
      (async (url: string) => {
        throw new Error(`fetchBytes unexpected on ${url}`);
      }),
    recorder,
    timeoutMs: 1000,
  });

const INDEX_QUERY =
  "https://index.commoncrawl.org/CC-MAIN-2025-30-index?url=example.com%2F*&output=json";
const CAPTURE_BYTES =
  "https://data.commoncrawl.org/crawl-data/CC-MAIN-2025-30/segments/1751483438516.90/warc/CC-MAIN-20250702035953-20250702065953-00000.warc.gz";

test("the eligibility record establishes only catalogue reachability for Common Crawl", () => {
  const index = SOURCE_ELIGIBILITY.find((entry) => entry.route === "commoncrawl")!;
  expect(index).toBeDefined();
  /* The probe answers whether the catalogue is reachable: a collection list,
     not a capture. */
  expect(index.probe).toBe("https://index.commoncrawl.org/collinfo.json");
  expect(index.terms).toContain("CDX index");
  /* No production capture route exists. The index answering says nothing about
     whether a capture's bytes can be retrieved, so nothing may read this
     entry as capture coverage; adding capture retrieval to production without
     revisiting ADR-0072 fails here. */
  const capture = SOURCE_ELIGIBILITY.find((entry) => entry.route === "commoncrawl-capture")!;
  expect(capture).toBeDefined();
  expect(capture.status).toBe("excluded");
  expect(capture.exclusion).toContain("ADR-0072");
});

test("Common Crawl addresses enter the archive pipeline but carry no capture date", () => {
  /* Both the index and the byte store classify as historical evidence, which
     is the dispatch fact the recorded exclusion builds on. */
  expect(classifySourceFamily(INDEX_QUERY)).toBe("historical-evidence");
  expect(classifySourceFamily(CAPTURE_BYTES)).toBe("historical-evidence");
  /* The archive-dating machinery cannot date either address: neither is a
     Wayback capture, so per #253 undated archived text is refused rather than
     retained as evidence. */
  expect(archivedCaptureDate(INDEX_QUERY)).toBeNull();
  expect(archivedCaptureDate(CAPTURE_BYTES)).toBeNull();
});

test("an index catalogue answer is never dated capture evidence", async () => {
  const recorder = new ResearchAttemptRecorder("operation-cc-index");
  const indexAnswer = JSON.stringify([
    {
      url: "example.com/",
      timestamp: "20250702035953",
      filename:
        "crawl-data/CC-MAIN-2025-30/segments/1751483438516.90/warc/CC-MAIN-20250702035953-20250702065953-00000.warc.gz",
      offset: 1234,
      length: 5678,
      status: "200",
    },
  ]);
  const result = await readPersonSource(
    INDEX_QUERY,
    "",
    ports(recorder, async (url) => ({
      url,
      status: 200,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: indexAnswer,
    })),
  );

  /* Index discovery, not capture retention: the catalogue listing is retained
     as the index's own undated answer under the record route, never as dated
     capture evidence under a capture route. */
  expect(result.access).toBe("retrieved");
  expect(result.route).toBe("record-reader");
  expect(result.route).not.toContain("capture");
  expect(result.capturedAt).toBeNull();
  /* An index answer establishes no rights basis for the captures it lists —
     which is not the same as free — and is accounted as the index's answer,
     never as the publisher's captured page: what is retained are the
     capture's coordinates (file, offset, length), not its content. */
  expect(result.rights).toBeNull();
  expect(result.upstreamIndex).toBe("documents");
  expect(result.finalUrl).toBe(INDEX_QUERY);
  expect(result.text).toContain("warc/CC-MAIN-20250702035953");
});

test("a Common Crawl capture URL is explicitly refused without network retrieval", async () => {
  const recorder = new ResearchAttemptRecorder("operation-cc-bytes");
  let networkCalled = false;
  const result = await readPersonSource(
    CAPTURE_BYTES,
    "",
    ports(
      recorder,
      async () => {
        networkCalled = true;
        throw new Error("network fetch must not be called for an excluded capture route");
      },
      async () => {
        networkCalled = true;
        throw new Error("network fetchBytes must not be called for an excluded capture route");
      },
    ),
  );

  expect(networkCalled).toBe(false);
  expect(result.access).toBe("unsupported");
  expect(result.capturedAt).toBeNull();
  expect(result.text).toBe("");
  const failures = recorder.failures();
  expect(failures.length).toBeGreaterThan(0);
  expect(failures[0]).toMatchObject({
    collector: "archive-reader",
    code: "resource-unavailable",
    outcome: "failed",
  });
  expect(failures[0]?.reason).toContain("ADR-0072");
});
test("a Wayback-wrapped Common Crawl capture URL is refused and carries no capture date", async () => {
  const wrappedUrl = `https://web.archive.org/web/20250702035953/${CAPTURE_BYTES}`;
  expect(archivedCaptureDate(wrappedUrl)).toBeNull();

  const recorder = new ResearchAttemptRecorder("operation-cc-wayback-wrapped");
  let networkCalled = false;
  const result = await readPersonSource(
    wrappedUrl,
    "",
    ports(
      recorder,
      async () => {
        networkCalled = true;
        throw new Error("network fetch must not be called for a wrapped Common Crawl capture");
      },
      async () => {
        networkCalled = true;
        throw new Error("network fetchBytes must not be called for a wrapped Common Crawl capture");
      },
    ),
  );

  expect(networkCalled).toBe(false);
  expect(result.access).toBe("unsupported");
  expect(result.capturedAt).toBeNull();
  expect(result.text).toBe("");
  const failures = recorder.failures();
  expect(failures.length).toBeGreaterThan(0);
  expect(failures[0]).toMatchObject({
    collector: "archive-reader",
    code: "resource-unavailable",
    outcome: "failed",
  });
  expect(failures[0]?.reason).toContain("ADR-0072");
});
