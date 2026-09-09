import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { PersonSourceFamily, PersonSourceRights } from "@chief-of-staff-demo/shared";
import { convertToText, SourceError } from "../text/convert.js";
import {
  detectSystemTesseract,
  extractPdfSegments,
  renderPdfSegments,
  type OcrEngine,
} from "../text/scanned-documents.js";
import {
  retryAfterMilliseconds,
  type PublicHttpBytesFetch,
  type PublicHttpFetch,
  type PublicHttpResponse,
  type PublicHttpBytesResponse,
} from "../source-adapters/http.js";
import type { BrowserRenderer } from "../source-adapters/browser.js";
import {
  classifyHttpStatus,
  classifyTransportError,
  detectChallenge,
  type CollectorName,
  type ResearchAttemptRecorder,
} from "./research-diagnostics.js";
import { renderPublicationRecord } from "./publication-records.js";
import { renderIdentityAnchor } from "./identity-anchors.js";
import { registryNonRecordBody, renderInstitutionalRecord } from "./institutional-records.js";
import { creativeNonRecordBody, renderCreativeRecord } from "./creative-records.js";

/** Text kept per source. Matches the dossier store's own retention ceiling. */
const MAX_TEXT = 500_000;

/**
 * A citation anchor suited to the format: a PDF page, a caption timestamp, or
 * a document section. Stored beside the text so a claim can point at where in
 * a 90-minute talk or a 40-page filing its passage came from.
 */
interface SourceAnchor {
  kind: "page" | "timestamp" | "section";
  value: string;
  /** Character offset into the retained text where this anchor begins. */
  offset: number;
}

export interface SourceReadResult {
  text: string;
  /**
   * When a web archive captured this text, ISO-8601, or null for live web
   * material. A capture is evidence about its capture date and nothing after
   * it, so this travels with the text from here to the citation (issue #253).
   */
  capturedAt: string | null;
  completeness: "full" | "partial" | "snippet" | "unavailable";
  access: "retrieved" | "blocked" | "failed" | "unsupported";
  outboundUrls: string[];
  family: PersonSourceFamily;
  /** Which reader produced the text; part of the source's acquisition record. */
  route: string;
  /**
   * The upstream index or publisher this content ultimately came from. Two
   * wrappers over one index share it, so independence can be counted rather
   * than assumed from distinct hostnames.
   */
  upstreamIndex: string | null;
  publishedAt: string | null;
  author: string | null;
  anchors: SourceAnchor[];
  /**
   * Format provenance a claim must not lose: publisher captions versus
   * automatic speech recognition, a caption timestamp versus a named speaker.
   */
  provenanceNote: string | null;
  /**
   * The upstream's own version of what was read, where the source states one.
   * A retained version is dated by when it was read; this says which version
   * of the upstream record that reading saw (#249).
   */
  sourceVersion: string | null;
  /**
   * What each material in this read may be used for. Null where the route
   * established no rights basis at all — which is not the same as free.
   */
  rights: PersonSourceRights | null;
  finalUrl: string;
  /**
   * Individuals a professional or institutional record names, by name, with
   * only their own affiliation strings — never a record-level sponsor or
   * responsible organization. Undefined for every other route. Identity
   * resolution reads this instead of searching the whole rendered text for a
   * known employer, so a trial sponsored by the Profile's employer cannot
   * corroborate a same-name investigator whose own affiliation conflicts
   * (review finding on issue #250, PR #295).
   *
   * An entry's `affiliations` is `null`, distinct from `[]`, when the
   * record's own shape cannot state an affiliation for that person at all —
   * an NPPES specialty or an organisation's own name is never a stand-in.
   * Identity resolution reads `null` as "cannot corroborate or refute" and
   * holds a same-name match ambiguous rather than confirming or rejecting it
   * (review finding on issue #250, PR #295).
   */
  namedIndividuals?: { name: string; affiliations: string[] | null }[];
}

export interface ReaderPorts {
  fetch: PublicHttpFetch;
  fetchBytes: PublicHttpBytesFetch;
  /** Bounded anonymous rendering. Absent means the route is unavailable. */
  render?: BrowserRenderer;
  recorder: ResearchAttemptRecorder;
  timeoutMs: number;
  profileRevision?: number;
  systemOcr?: () => Promise<OcrEngine | null>;
}

interface ReadContext extends ReaderPorts {
  attemptOf: string;
  snippet: string;
}

const unavailable = (
  family: PersonSourceFamily,
  route: string,
  access: SourceReadResult["access"],
  snippet: string,
  finalUrl: string,
): SourceReadResult => ({
  text: snippet,
  capturedAt: null,
  completeness: snippet ? "snippet" : "unavailable",
  access,
  outboundUrls: [],
  family,
  route,
  upstreamIndex: null,
  publishedAt: null,
  author: null,
  anchors: [],
  provenanceNote: null,
  sourceVersion: null,
  rights: null,
  finalUrl,
});

/* ------------------------------------------------------------------ */
/* Routing                                                              */
/* ------------------------------------------------------------------ */

/** Which family a URL belongs to, decided before any request is made. */
export function classifySourceFamily(url: string): PersonSourceFamily {
  let host: string;
  let path: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    path = parsed.pathname.toLowerCase();
  } catch {
    return "general-discovery";
  }
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|peertube|tube\.|sepiasearch\.org)/.test(host))
    return "spoken-evidence";
  if (/podcast|\.rss$|\/feed|anchor\.fm|libsyn|buzzsprout|megaphone\.fm/.test(host + path))
    return "spoken-evidence";
  if (
    /(^|\.)(bsky\.app|bsky\.social|mastodon\.|fosstodon\.org|hachyderm\.io|linkedin\.com|instagram\.com|threads\.net|x\.com|twitter\.com)/.test(
      host,
    )
  )
    return "public-social";
  if (
    /(^|\.)(crossref\.org|datacite\.org|doi\.org|openalex\.org|europepmc\.org|arxiv\.org|ncbi\.nlm\.nih\.gov)/.test(
      host,
    )
  )
    return "published-work";
  if (
    /(^|\.)(clinicaltrials\.gov|npiregistry\.cms\.hhs\.gov|sec\.gov|projects\.propublica\.org|nppes)/.test(
      host,
    )
  )
    return "professional-records";
  if (/(^|\.)(tvmaze\.com|loc\.gov|artic\.edu|imdb\.com|discogs\.com|openlibrary\.org)/.test(host))
    return "creative-records";
  if (/(^|\.)(wikidata\.org|ror\.org|orcid\.org|isni\.org|viaf\.org)/.test(host))
    return "identity-affiliation";
  if (/(^|\.)(web\.archive\.org|archive\.org|commoncrawl\.org)/.test(host))
    return "historical-evidence";
  return "documents-publishers";
}

/**
 * Read one public source anonymously.
 *
 * The reader is chosen from the URL first and from the response second, so a
 * PDF served from a `.aspx` route is still read as a document, and a video
 * page still reaches the caption route rather than being reduced to its HTML
 * description. Every failure records an attempt with an observed code; nothing
 * here converts "we could not read it" into "the person has no evidence".
 */
export async function readPersonSource(
  url: string,
  snippet: string,
  ports: ReaderPorts,
): Promise<SourceReadResult> {
  const context: ReadContext = { ...ports, attemptOf: ports.recorder.correlate(url), snippet };
  const family = classifySourceFamily(url);
  try {
    const capture = waybackCapture(url);
    if (capture) {
      if (commonCrawlCapture(capture.original))
        return refuseCommonCrawlCapture(url, family, context);
      return await readArchivedCapture(url, capture, context);
    }
    if (commonCrawlCapture(url)) return refuseCommonCrawlCapture(url, family, context);
    if (family === "spoken-evidence" && isVideoPage(url)) return await readSpoken(url, context);
    if (family === "public-social") return await readSocial(url, context);
    const records = recordRoute(url);
    if (records.length) return await readRecord(url, records, family, context);
    return await readWeb(url, family, context);
  } catch (error) {
    const { code, reason } = classifyTransportError(error);
    ports.recorder.record({
      stage: "transport",
      code,
      outcome: "failed",
      recovery: "stopped",
      cause: code === "transport-failed" ? "unknown" : "observed",
      target: url,
      targetKind: "url",
      collector: "html-reader",
      reason,
      attemptOf: context.attemptOf,
      impact: "No source material was retained from this URL.",
      remediation: `Retry the URL directly: curl -sS -D- -o/dev/null '${url}'`,
      ...(ports.profileRevision !== undefined ? { profileRevision: ports.profileRevision } : {}),
    });
    return unavailable(family, "reader", "failed", snippet, url);
  }
}

/* ------------------------------------------------------------------ */
/* Archived captures                                                    */
/* ------------------------------------------------------------------ */

/**
 * The eligibility record's name for reading a Wayback capture's *content*.
 *
 * Deliberately not the `wayback` entry, which covers the availability API and
 * answers only whether a capture exists: retrieving the capture's bytes is a
 * second endpoint and a second acquisition, and #228 requires each route to
 * declare what it costs before production can reach it.
 */
export const WAYBACK_CAPTURE_ROUTE = "wayback-capture";

interface WaybackCapture {
  /** The capture instant read from the address, or null for a lookup. */
  capturedAt: string | null;
  /** The URL that was captured; the publisher this evidence came from. */
  original: string;
  /** The captured bytes, without the archive's own navigation chrome. */
  contentUrl: string;
}

/**
 * Phrases the Internet Archive serves in place of a capture.
 *
 * The archive answers some of these with HTTP 200, so status alone cannot tell
 * a capture from a service fault, and a technical-difficulty page retained as
 * evidence would read as a publisher's own words. Matching is bounded to the
 * head of the body: a genuine capture that discusses an outage further down
 * its page is still a capture. A capture whose *opening* text says one of
 * these is dropped and recorded as a failure — costing a source rather than
 * inventing a fact, which is the trade this ticket asks for (#253).
 */
const ARCHIVE_FAILURE_PHRASES: readonly { marker: string; phrase: string }[] = [
  { marker: "not-archived", phrase: "wayback machine has not archived that url" },
  { marker: "excluded", phrase: "has been excluded from the wayback machine" },
  { marker: "offline", phrase: "internet archive services are temporarily offline" },
  { marker: "technical-difficulties", phrase: "technical difficulties" },
];
const ARCHIVE_FAILURE_HEAD = 4000;

/** Which archive failure this body announces, by marker name, or null. */
function archiveFailurePage(body: string): string | null {
  const head = body.slice(0, ARCHIVE_FAILURE_HEAD).toLowerCase();
  return ARCHIVE_FAILURE_PHRASES.find((entry) => head.includes(entry.phrase))?.marker ?? null;
}

/** The capture instant a 14-digit Wayback timestamp names, or null. */
function captureInstant(timestamp: string): string | null {
  if (!/^\d{14}$/.test(timestamp)) return null;
  const [year, month, day, hour, minute, second] = [0, 4, 6, 8, 10, 12].map((at, index) =>
    Number(timestamp.slice(at, at + (index === 0 ? 4 : 2))),
  ) as [number, number, number, number, number, number];
  const at = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(at)) return null;
  const iso = new Date(at).toISOString();
  /* A timestamp that does not round-trip was never a real instant: `20241340…`
     would otherwise become a confident date in the following month. */
  return iso.slice(0, 19).replace(/[-:T]/g, "") === timestamp ? iso : null;
}

/**
 * Whether this URL addresses one Wayback capture, and what to fetch for it.
 *
 * `/web/<timestamp>/<url>` serves the capture inside the archive's own banner
 * with its links rewritten back into the archive; the `id_` modifier serves the
 * captured bytes as the publisher sent them. Reading the wrapper would retain
 * the archive's navigation as though the publisher had written it, and would
 * turn the page's outbound links into archive addresses.
 */
function waybackCapture(url: string): WaybackCapture | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase().replace(/^www\./, "") !== "web.archive.org") return null;
  const path = `${parsed.pathname}${parsed.search}`;
  const match = /^\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(.+)$/i.exec(path);
  if (!match) return null;
  const [, timestamp, captured] = match as unknown as [string, string, string];
  /* The archive writes the captured address with or without its scheme, and
     accepts either back. The scheme is filled in only to name the publisher;
     the request repeats the address exactly as the archive gave it. */
  const original = /^https?:\/\//i.test(captured) ? captured : `https://${captured}`;
  if (!hostOf(original)) return null;
  return {
    capturedAt: captureInstant(timestamp),
    original,
    contentUrl: `https://web.archive.org/web/${timestamp}id_/${captured}`,
  };
}

/**
 * The instant a web-archive address names, or null for live material.
 *
 * Exported for the paths that hand the pipeline text they retrieved elsewhere
 * — the benchmark's fixed-document mode replays retained excerpts at their real
 * URLs — so an archived document is dated the same way whoever fetched it.
 */
export function archivedCaptureDate(url: string): string | null {
  const capture = waybackCapture(url);
  if (!capture || commonCrawlCapture(capture.original)) return null;
  return capture.capturedAt;
}

/**
 * Read one archived capture as dated historical evidence.
 *
 * Two things separate this from reading the same page live. The capture date
 * travels with the text, because a capture is evidence of what the page said
 * on that date and of nothing after it — a former role read here must never
 * reach a Profile as a current one. And the archive's own error pages are
 * refused rather than retained: an archive answering "we are having technical
 * difficulties" has told us nothing about the person, and recording it as a
 * read source would turn a service fault into an absence of evidence.
 */
async function readArchivedCapture(
  url: string,
  capture: WaybackCapture,
  context: ReadContext,
): Promise<SourceReadResult> {
  const family: PersonSourceFamily = "historical-evidence";
  const failed = (access: SourceReadResult["access"], finalUrl: string): SourceReadResult =>
    /* Deliberately no snippet: the only text in hand is the archive's, and a
       failed capture must contribute nothing that could be read as evidence. */
    unavailable(family, WAYBACK_CAPTURE_ROUTE, access, "", finalUrl);

  /* A capture whose address names a document goes straight to the byte reader.
     Asking for it as text first would fetch the same capture twice and leave
     the archive free to answer the second request differently from the one
     just validated and dated, so the bytes retained would not be the bytes
     checked. Its own reader records the transport and status failures. */
  if (looksLikeBinaryDocument(capture.original))
    return finishCapture(
      await readDocument(capture.contentUrl, family, context, (response) =>
        screenArchiveBytes(response, capture, context),
      ),
      capture,
      context,
    );

  const response = await request(capture.contentUrl, context, "archive-reader");
  if (!response) return failed("failed", url);
  if (response.status >= 400) {
    const missing = response.status === 404 || response.status === 410;
    const classified = classifyHttpStatus(response.status, response.body, response.contentType);
    context.recorder.record({
      stage: "access",
      code: missing ? "resource-unavailable" : classified.code,
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: capture.contentUrl,
      targetKind: "url",
      collector: "archive-reader",
      reason: missing
        ? `The archive holds no capture for this address: HTTP ${response.status}.`
        : classified.reason,
      attemptOf: context.attemptOf,
      observed: {
        status: response.status,
        finalUrl: response.url,
        contentType: response.contentType,
        bytes: response.body.length,
        bodyHash: hash(response.body),
      },
      impact: "No archived text was retained, and no claim rests on this capture.",
      remediation: `Reproduce with: curl -sS -D- -o/dev/null '${capture.contentUrl}'`,
      ...(context.profileRevision !== undefined
        ? { profileRevision: context.profileRevision }
        : {}),
    });
    return failed(response.status === 403 || response.status === 401 ? "blocked" : "failed", url);
  }

  const marker = archiveFailurePage(response.body);
  if (marker) {
    context.recorder.record({
      stage: "access",
      code: "archive-error-page",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: capture.contentUrl,
      targetKind: "url",
      collector: "archive-reader",
      reason: `The archive answered with its own ${marker} page instead of the capture.`,
      attemptOf: context.attemptOf,
      /* Shape only: status, size, hash and which phrase matched. The page's
         own text is exactly what must not be retained. */
      observed: {
        status: response.status,
        finalUrl: response.url,
        contentType: response.contentType,
        bytes: response.body.length,
        bodyHash: hash(response.body),
        parserLocation: marker,
      },
      impact: "No archived text was retained, and no claim rests on this capture.",
      remediation: `Retry later, then reproduce with: curl -sS '${capture.contentUrl}'`,
      ...(context.profileRevision !== undefined
        ? { profileRevision: context.profileRevision }
        : {}),
    });
    return failed("failed", response.url);
  }

  return finishCapture(
    await readRetrieved(capture.contentUrl, response, family, context),
    capture,
    context,
  );
}

/**
 * Refuse an archive error page that arrived where a captured document was
 * expected, before anything tries to parse it as one.
 *
 * The archive serves its own pages as HTML whatever the captured address
 * looked like, so without this the bytes would reach the PDF converter and be
 * recorded as `parser-failed`. That is an observed cause but the wrong one:
 * the parser did not fail, the archive never served the document, and only the
 * second reading tells a developer this is worth retrying (#253). The refusal
 * is made here rather than passed on as a retrieved result, so the archive's
 * page is never a value anything downstream could decide to keep.
 */
function screenArchiveBytes(
  response: PublicHttpBytesResponse,
  capture: WaybackCapture,
  context: ReadContext,
): SourceReadResult | null {
  const type = response.contentType?.toLowerCase() ?? "";
  if (!type.includes("html") && !type.includes("xml")) return null;
  const marker = archiveFailurePage(
    new TextDecoder().decode(response.bytes.subarray(0, ARCHIVE_FAILURE_HEAD)),
  );
  if (!marker) return null;
  context.recorder.record({
    stage: "access",
    code: "archive-error-page",
    outcome: "failed",
    recovery: "stopped",
    cause: "observed",
    target: capture.contentUrl,
    targetKind: "document",
    collector: "archive-reader",
    reason: `The archive answered with its own ${marker} page instead of the captured document.`,
    attemptOf: context.attemptOf,
    /* Shape only: status, size, hash and which phrase matched. The page's own
       text is exactly what must not be retained. */
    observed: {
      status: response.status,
      finalUrl: response.url,
      contentType: response.contentType,
      bytes: response.bytes.length,
      bodyHash: hash(response.bytes),
      parserLocation: marker,
    },
    impact: "No archived text was retained, and no claim rests on this capture.",
    remediation: `Retry later, then reproduce with: curl -sSL -D- -o/dev/null '${capture.contentUrl}'`,
    ...(context.profileRevision !== undefined ? { profileRevision: context.profileRevision } : {}),
  });
  return unavailable("historical-evidence", WAYBACK_CAPTURE_ROUTE, "failed", "", response.url);
}
/**
 * Common Crawl capture retrieval is excluded by ADR-0072: Terms of Use §2(l)
 * prohibits collecting or harvesting personal information for use separately
 * from the crawl. Any capture URL on data.commoncrawl.org or under crawl-data
 * is refused before any network request is made.
 */
function commonCrawlCapture(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "data.commoncrawl.org" ||
      (/(^|\.)commoncrawl\.org$/.test(host) &&
        (parsed.pathname.includes("/crawl-data/") || /\.warc(\.gz)?/i.test(parsed.pathname)))
    );
  } catch {
    return false;
  }
}

function refuseCommonCrawlCapture(
  url: string,
  family: PersonSourceFamily,
  context: ReadContext,
): SourceReadResult {
  context.recorder.record({
    stage: "access",
    code: "resource-unavailable",
    outcome: "failed",
    recovery: "stopped",
    cause: "observed",
    target: url,
    targetKind: "url",
    collector: "archive-reader",
    reason:
      "Common Crawl capture retrieval is excluded by ADR-0072: Terms of Use §2(l) prohibits harvesting personal information separately from the crawl.",
    attemptOf: context.attemptOf,
    impact: "No source material was retained from this Common Crawl capture URL.",
    remediation:
      "Do not retrieve Common Crawl capture content; the route is excluded from production research.",
  });
  return unavailable(family, "archive-reader", "unsupported", context.snippet, url);
}

/**
 * Turn whatever a reader produced from a capture into dated archived evidence,
 * or refuse it.
 *
 * Deliberately reads the *retrieved text*, not the response the checks above
 * saw: a reader chosen from the response fetches the capture with its own
 * transport, so the text in hand is the only thing known to be the bytes that
 * would be retained. Both refusals are the ticket's rule (#253) — an archive's
 * error page is not evidence, and undated archived text is not safe to use,
 * because it is the date that makes a former role read as former.
 */
function finishCapture(
  read: SourceReadResult,
  capture: WaybackCapture,
  context: ReadContext,
): SourceReadResult {
  const family: PersonSourceFamily = "historical-evidence";
  const routed = { ...read, family, route: WAYBACK_CAPTURE_ROUTE };
  /* A reader that failed still hands back the caller's snippet, which is search
     text about the person rather than anything the archive said. On this route
     that snippet would be retained as archived evidence of a capture that was
     never read, so a failure here keeps its access and its diagnostics and
     gives up its text. */
  if (read.access !== "retrieved")
    return unavailable(family, WAYBACK_CAPTURE_ROUTE, read.access, "", read.finalUrl);
  const refuse = (
    code: "archive-error-page" | "resource-unavailable",
    reason: string,
    marker?: string,
  ): SourceReadResult => {
    context.recorder.record({
      stage: "access",
      code,
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: capture.contentUrl,
      targetKind: "url",
      collector: "archive-reader",
      reason,
      attemptOf: context.attemptOf,
      /* Shape only: size, hash, the answered address and which phrase matched.
         The page's own text is exactly what must not be retained. */
      observed: {
        finalUrl: read.finalUrl,
        bytes: read.text.length,
        bodyHash: hash(read.text),
        ...(marker ? { parserLocation: marker } : {}),
      },
      impact: "No archived text was retained, and no claim rests on this capture.",
      remediation: `Retry later, then reproduce with: curl -sSL '${capture.contentUrl}'`,
      ...(context.profileRevision !== undefined
        ? { profileRevision: context.profileRevision }
        : {}),
    });
    return unavailable(family, WAYBACK_CAPTURE_ROUTE, "failed", "", read.finalUrl);
  };

  const marker = archiveFailurePage(read.text);
  if (marker)
    return refuse(
      "archive-error-page",
      `The archive's own ${marker} page reached extraction instead of the capture.`,
      marker,
    );

  /* The archive resolves a partial timestamp to the closest capture, so the
     answered address is what dates the evidence. */
  const capturedAt = waybackCapture(read.finalUrl)?.capturedAt ?? capture.capturedAt;
  if (!capturedAt)
    return refuse(
      "resource-unavailable",
      "The archive answered without resolving this lookup to a dated capture.",
    );

  return {
    ...routed,
    capturedAt,
    /* The publisher, not the archive: a live read and an archived read of one
       page are one publisher's account, and counting them as two independent
       indexes would manufacture corroboration. */
    upstreamIndex: hostOf(capture.original),
    provenanceNote: `Web archive capture of ${capture.original}, captured ${capturedAt}. It states what that page said on its capture date, not what is true now.`,
  };
}

/* ------------------------------------------------------------------ */
/* Web: HTML, text, feeds, documents                                    */
/* ------------------------------------------------------------------ */

async function readWeb(
  url: string,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  if (looksLikeBinaryDocument(url)) return readDocument(url, family, context);
  const response = await request(url, context, "html-reader");
  if (!response) return unavailable(family, "html-reader", "failed", context.snippet, url);
  if (response.status >= 400) {
    const classified = classifyHttpStatus(response.status, response.body, response.contentType);
    context.recorder.record({
      stage: "access",
      code: classified.code,
      outcome: "failed",
      recovery: context.render ? "alternative-route" : "stopped",
      cause: "observed",
      target: url,
      targetKind: "url",
      collector: "html-reader",
      reason: classified.reason,
      attemptOf: context.attemptOf,
      observed: {
        status: response.status,
        finalUrl: response.url,
        contentType: response.contentType,
        bytes: response.body.length,
        bodyHash: hash(response.body),
        excerpt: response.body.slice(0, 400),
      },
      impact: "This page contributed no text to the dossier.",
      remediation: `Reproduce with: curl -sS -D- -o/dev/null '${url}'`,
      ...(context.render ? {} : { recoveryStopped: "No anonymous rendering route is configured." }),
      ...(context.profileRevision !== undefined
        ? { profileRevision: context.profileRevision }
        : {}),
    });
    const rendered = await tryRender(url, family, context);
    if (rendered) return rendered;
    return unavailable(
      family,
      "html-reader",
      response.status === 403 || response.status === 401 ? "blocked" : "failed",
      context.snippet,
      response.url,
    );
  }
  return readRetrieved(url, response, family, context);
}

/**
 * Pick the reader for a response already in hand.
 *
 * Separate from `readWeb` because the archived-capture route arrives here with
 * its own request already made: a capture may be HTML, a PDF, a feed or plain
 * text exactly as the live page was, and duplicating this dispatch is how the
 * two would drift into reading the same publisher's page differently depending
 * on whether it was read live or out of an archive.
 */
async function readRetrieved(
  url: string,
  response: PublicHttpResponse,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  const type = response.contentType?.toLowerCase() ?? "";
  if (type.includes("pdf")) return readDocument(url, family, context);
  if (isFeed(type, response.body)) return readFeed(url, response, family, context);
  if (type.includes("json")) return renderJson(url, response, family, context, "documents");
  if (type.includes("html") || type.includes("xml") || type === "")
    return readHtml(url, response, family, context);
  if (type.startsWith("text/"))
    return {
      ...unavailable(family, "text-reader", "retrieved", "", response.url),
      text: response.body.slice(0, MAX_TEXT),
      completeness: response.body.length > MAX_TEXT ? "partial" : "full",
      upstreamIndex: hostOf(response.url),
    };
  context.recorder.record({
    stage: "document-parsing",
    code: "unsupported-format",
    outcome: "failed",
    recovery: "stopped",
    cause: "observed",
    target: url,
    targetKind: "document",
    collector: "document-reader",
    reason: `Content type ${type || "(absent)"} has no supported reader.`,
    attemptOf: context.attemptOf,
    observed: { contentType: response.contentType, bytes: response.body.length },
    impact: "The document's text did not reach extraction.",
    remediation: "Add a reader for this media type, or record it as an eligible gap.",
  });
  return unavailable(family, "document-reader", "unsupported", context.snippet, response.url);
}

async function readHtml(
  url: string,
  response: PublicHttpResponse,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  const challenge = detectChallenge(response.body, response.contentType);
  const dom = new JSDOM(response.body, { url: response.url });
  try {
    const document = dom.window.document;
    const outboundUrls = [
      ...new Set(
        [...document.querySelectorAll("a[href]")].flatMap((link) => {
          try {
            const parsed = new URL(link.getAttribute("href")!, response.url);
            return ["https:", "http:"].includes(parsed.protocol) ? [parsed.toString()] : [];
          } catch {
            return [];
          }
        }),
      ),
    ].slice(0, 200);
    const meta = (name: string) =>
      document
        .querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`)
        ?.getAttribute("content") ?? null;
    const article = new Readability(document).parse();
    const text = article?.textContent?.trim() ?? "";
    if (!text || challenge) {
      context.recorder.record({
        stage: challenge ? "access" : "rendering",
        code: challenge ?? "document-empty",
        outcome: "failed",
        recovery: context.render ? "alternative-route" : "stopped",
        cause: "observed",
        target: url,
        targetKind: "url",
        collector: "html-reader",
        reason: challenge
          ? `A ${challenge === "login-required" ? "sign-in" : "bot-challenge"} page was served instead of the article.`
          : "The page parsed but carried no article text.",
        attemptOf: context.attemptOf,
        observed: {
          status: response.status,
          finalUrl: response.url,
          contentType: response.contentType,
          bytes: response.body.length,
          bodyHash: hash(response.body),
        },
        impact: "No readable text reached extraction from this page.",
        remediation: challenge
          ? "This route is not anonymously readable; record it as a source gap."
          : "Check whether the article is client-rendered and needs the browser route.",
      });
      const rendered = await tryRender(url, family, context);
      if (rendered) return rendered;
      return unavailable(
        family,
        "html-reader",
        challenge ? "blocked" : "failed",
        context.snippet,
        response.url,
      );
    }
    return {
      text: text.slice(0, MAX_TEXT),
      capturedAt: null,
      completeness: text.length > MAX_TEXT ? "partial" : "full",
      access: "retrieved",
      outboundUrls,
      family,
      route: "html-reader",
      upstreamIndex: hostOf(response.url),
      publishedAt:
        meta("article:published_time") ?? meta("datePublished") ?? meta("publish_date") ?? null,
      author: meta("article:author") ?? meta("author") ?? null,
      anchors: [],
      provenanceNote: null,
      sourceVersion: null,
      rights: null,
      finalUrl: response.url,
    };
  } finally {
    dom.window.close();
  }
}

async function tryRender(
  url: string,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult | null> {
  if (!context.render) return null;
  try {
    const rendered = await context.render(url);
    const dom = new JSDOM(rendered.body, { url: rendered.url });
    try {
      const article = new Readability(dom.window.document).parse();
      const text = article?.textContent?.trim() ?? "";
      if (!text) return null;
      context.recorder.record({
        stage: "rendering",
        code: "retrieval-recovered",
        outcome: "recovered",
        recovery: "recovered",
        cause: "observed",
        target: url,
        targetKind: "url",
        collector: "browser-renderer",
        reason: "The bounded anonymous browser route returned readable text.",
        attemptOf: context.attemptOf,
        observed: { status: rendered.status, finalUrl: rendered.url, bytes: rendered.body.length },
      });
      return {
        text: text.slice(0, MAX_TEXT),
        capturedAt: null,
        completeness: text.length > MAX_TEXT ? "partial" : "full",
        access: "retrieved",
        outboundUrls: [],
        family,
        route: "browser-renderer",
        upstreamIndex: hostOf(rendered.url),
        publishedAt: null,
        author: null,
        anchors: [],
        provenanceNote: "Text came from a bounded anonymous render, not the raw response.",
        sourceVersion: null,
        rights: null,
        finalUrl: rendered.url,
      };
    } finally {
      dom.window.close();
    }
  } catch (error) {
    context.recorder.record({
      stage: "rendering",
      code: "rendering-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "url",
      collector: "browser-renderer",
      reason: `The anonymous browser route failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      attemptOf: context.attemptOf,
      recoveryStopped: "No further retrieval route applies to this URL.",
      impact: "A client-rendered page contributed nothing to the dossier.",
      remediation: "Run the URL through the browser route manually to see what it renders.",
    });
    return null;
  }
}

let defaultSystemOcrPromise: Promise<OcrEngine | null> | null = null;
function defaultSystemOcr(): Promise<OcrEngine | null> {
  defaultSystemOcrPromise ??= detectSystemTesseract();
  return defaultSystemOcrPromise;
}
async function readDocument(
  url: string,
  family: PersonSourceFamily,
  context: ReadContext,
  /* Inspect the retrieved bytes before conversion. The archived-capture route
     uses it to recognise the archive's own error page: served for a document
     address it is HTML, which the converter would reject as a broken file and
     report as `parser-failed` rather than as the service fault it is. The hook
     reads the response already in hand, so the capture is still fetched once. */
  inspect?: (response: PublicHttpBytesResponse) => SourceReadResult | null,
): Promise<SourceReadResult> {
  let response;
  try {
    response = await context.fetchBytes(url, { timeoutMs: context.timeoutMs });
  } catch (error) {
    const { code, reason } = classifyTransportError(error);
    context.recorder.record({
      stage: "transport",
      code,
      outcome: "failed",
      recovery: "stopped",
      cause: code === "transport-failed" ? "unknown" : "observed",
      target: url,
      targetKind: "document",
      collector: "document-reader",
      reason,
      attemptOf: context.attemptOf,
      impact: "The document was never retrieved.",
      remediation: `Reproduce with: curl -sSL -o /tmp/source '${url}'`,
    });
    return unavailable(family, "document-reader", "failed", context.snippet, url);
  }
  if (response.status >= 400) {
    const classified = classifyHttpStatus(response.status, "", response.contentType);
    context.recorder.record({
      stage: "access",
      code: classified.code,
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "document",
      collector: "document-reader",
      reason: classified.reason,
      attemptOf: context.attemptOf,
      observed: { status: response.status, finalUrl: response.url, bytes: response.bytes.length },
      impact: "The document contributed no text.",
      remediation: `Reproduce with: curl -sSL -D- -o/dev/null '${url}'`,
    });
    return unavailable(family, "document-reader", "blocked", context.snippet, response.url);
  }
  const inspected = inspect?.(response) ?? null;
  if (inspected) return inspected;
  const name = documentFileName(response.url, response.contentType);
  try {
    let text: string;
    let ocrApplied = false;
    if (name.endsWith(".pdf")) {
      const ocr = context.systemOcr ? await context.systemOcr() : await defaultSystemOcr();
      const extracted = await extractPdfSegments(name, response.bytes, ocr);
      text = renderPdfSegments(extracted.segments);
      ocrApplied = extracted.ocrApplied;
    } else {
      text = await convertToText(name, response.bytes);
    }
    const isPdf = name.endsWith(".pdf");
    const provenanceNote = isPdf
      ? ocrApplied
        ? "Text extracted from a PDF document; pages without a text layer were read by system OCR."
        : "Text extracted from a PDF document with a text layer."
      : `Text extracted from a ${name.split(".").pop() ?? "document"} document.`;
    return {
      text: text.slice(0, MAX_TEXT),
      capturedAt: null,
      completeness: text.length > MAX_TEXT ? "partial" : "full",
      access: "retrieved",
      outboundUrls: [],
      family,
      route: "document-reader",
      upstreamIndex: hostOf(response.url),
      publishedAt: null,
      author: null,
      anchors: pageAnchors(text),
      provenanceNote,
      sourceVersion: null,
      rights: null,
      finalUrl: response.url,
    };
  } catch (error) {
    if (error instanceof SourceError && error.diagnostic?.classification === "unsupported_format") {
      context.recorder.record({
        stage: "document-parsing",
        code: "unsupported-format",
        outcome: "failed",
        recovery: "stopped",
        cause: "observed",
        target: url,
        targetKind: "document",
        collector: "document-reader",
        reason: error.message,
        attemptOf: context.attemptOf,
        observed: {
          contentType: response.contentType,
          bytes: response.bytes.length,
          bodyHash: hash(response.bytes),
          parserLocation: name,
        },
        impact: "A retrieved document contributed no text to the dossier.",
        remediation:
          "Install system pdftoppm (poppler) and tesseract on PATH, or inject an OCR engine, to read scanned PDFs.",
      });
      return unavailable(family, "document-reader", "unsupported", context.snippet, response.url);
    }
    context.recorder.record({
      stage: "document-parsing",
      code: "parser-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "document",
      collector: "document-reader",
      reason: `The document parser rejected the file: ${error instanceof Error ? error.message : "unknown error"}.`,
      attemptOf: context.attemptOf,
      observed: {
        contentType: response.contentType,
        bytes: response.bytes.length,
        bodyHash: hash(response.bytes),
        parserLocation: name,
      },
      impact: "A retrieved document contributed no text to the dossier.",
      remediation:
        "Save the bytes and run the converter locally; a scanned page needs OCR rather than a text layer.",
      hypothesis:
        "A PDF with no text layer is the usual cause, but this run did not establish that.",
    });
    return unavailable(family, "document-reader", "unsupported", context.snippet, response.url);
  }
}

async function readFeed(
  url: string,
  response: PublicHttpResponse,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  const dom = new JSDOM(response.body, { contentType: "text/xml" });
  try {
    const document = dom.window.document;
    const items = [...document.querySelectorAll("item, entry")].slice(0, 40);
    const lines: string[] = [];
    const outboundUrls: string[] = [];
    const title = document.querySelector("channel > title, feed > title")?.textContent.trim();
    if (title) lines.push(`Feed: ${title}`);
    for (const item of items) {
      const itemTitle = item.querySelector("title")?.textContent.trim() ?? "";
      const date =
        item.querySelector("pubDate, published, updated")?.textContent.trim() ?? "unknown date";
      const description =
        item.querySelector("description, summary, content")?.textContent.trim() ?? "";
      const link =
        item.querySelector("link")?.getAttribute("href") ??
        item.querySelector("link")?.textContent.trim() ??
        "";
      if (link) outboundUrls.push(link);
      /* Podcast namespaces publish a transcript URL beside the episode; it is
         the difference between a show note and the spoken evidence itself. */
      for (const transcript of item.querySelectorAll("[url]")) {
        const href = transcript.getAttribute("url");
        if (href && /transcript/i.test(transcript.nodeName)) outboundUrls.push(href);
      }
      lines.push(`${date} — ${itemTitle}\n${description}`.trim());
    }
    if (lines.length <= 1) {
      context.recorder.record({
        stage: "document-parsing",
        code: "document-empty",
        outcome: "failed",
        recovery: "stopped",
        cause: "observed",
        target: url,
        targetKind: "document",
        collector: "feed-reader",
        reason: "The feed parsed but carried no entries.",
        attemptOf: context.attemptOf,
        observed: { contentType: response.contentType, bytes: response.body.length },
        impact: "No episode or post text reached extraction.",
        remediation: "Check the feed URL directly; it may be a redirect stub.",
      });
      return unavailable(family, "feed-reader", "failed", context.snippet, response.url);
    }
    const text = lines.join("\n\n");
    return {
      text: text.slice(0, MAX_TEXT),
      capturedAt: null,
      completeness: text.length > MAX_TEXT ? "partial" : "full",
      access: "retrieved",
      outboundUrls: [...new Set(outboundUrls)].slice(0, 200),
      family,
      route: "feed-reader",
      upstreamIndex: hostOf(response.url),
      publishedAt: null,
      author: null,
      anchors: [],
      provenanceNote: "Feed entry text is publisher-written description, not a transcript.",
      sourceVersion: null,
      rights: null,
      finalUrl: response.url,
    };
  } finally {
    dom.window.close();
  }
}

/* ------------------------------------------------------------------ */
/* Spoken evidence                                                      */
/* ------------------------------------------------------------------ */

function isVideoPage(url: string): boolean {
  return /youtube\.com\/watch|youtu\.be\/|\/videos\/watch\//.test(url);
}

function youtubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("youtu.be")) return parsed.pathname.slice(1) || null;
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

/**
 * Public captions, read anonymously.
 *
 * The watch page carries the caption track list in its own player response, so
 * the track and then the timed text are two ordinary anonymous GETs — no key,
 * no sign-in, no player emulation. When a video simply has no track, that is
 * `captions-missing`, which is a fact about the video and not a failure of the
 * pipeline; the record says so.
 */
async function readSpoken(url: string, context: ReadContext): Promise<SourceReadResult> {
  const videoId = youtubeVideoId(url);
  if (!videoId) return readWeb(url, "spoken-evidence", context);
  const page = await request(url, context, "caption-reader");
  if (!page || page.status >= 400) {
    if (page)
      context.recorder.record({
        stage: "caption-acquisition",
        code: classifyHttpStatus(page.status, page.body, page.contentType).code,
        outcome: "failed",
        recovery: "stopped",
        cause: "observed",
        target: url,
        targetKind: "media",
        collector: "caption-reader",
        reason: `HTTP ${page.status} for the video page; the caption track list was never seen.`,
        attemptOf: context.attemptOf,
        observed: { status: page.status, finalUrl: page.url },
        impact: "Spoken evidence from this video is missing from the dossier.",
        remediation: `Reproduce with: curl -sS '${url}' | grep -o 'captionTracks'`,
      });
    return unavailable("spoken-evidence", "caption-reader", "failed", context.snippet, url);
  }
  const tracks = parseCaptionTracks(page.body);
  if (!tracks.length) {
    context.recorder.record({
      stage: "caption-acquisition",
      code: "captions-missing",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "media",
      collector: "caption-reader",
      reason: "The video page lists no caption tracks.",
      attemptOf: context.attemptOf,
      observed: { status: page.status, finalUrl: page.url, bytes: page.body.length },
      impact: "This video contributed no spoken evidence.",
      remediation:
        "Local transcription would be the next route; it is not wired into person research.",
      recoveryStopped: "No local transcription runtime is available to person research.",
    });
    return readVideoDescription(url, page, context);
  }
  /* Publisher captions before automatic speech recognition: an ASR track is
     usable evidence but a different kind of it, and the note travels with the
     text so a claim cannot silently upgrade a machine guess to a quotation. */
  const track = tracks.find((entry) => !entry.asr) ?? tracks[0]!;
  const captions = await request(track.baseUrl, context, "caption-reader");
  const emptyBody = !!captions && captions.status < 400 && captions.body.trim() === "";
  if (!captions || captions.status >= 400 || emptyBody) {
    context.recorder.record({
      stage: "caption-acquisition",
      /* An empty 200 is not an HTTP error and not a missing track: the video
         has captions and the anonymous route would not hand them over. The
         record says exactly that and keeps the guess separate. */
      code: emptyBody ? "captions-missing" : captions ? "http-error" : "transport-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: captions ? "observed" : "unknown",
      target: track.baseUrl,
      targetKind: "media",
      collector: "caption-reader",
      reason: emptyBody
        ? "The video lists a caption track, and the anonymous timed-text route returned HTTP 200 with an empty body."
        : captions
          ? `HTTP ${captions.status} fetching the caption track.`
          : "The caption track request did not complete.",
      attemptOf: context.attemptOf,
      ...(captions
        ? {
            observed: {
              status: captions.status,
              finalUrl: captions.url,
              bytes: captions.body.length,
            },
          }
        : {}),
      impact: "A listed caption track did not become text; the description was used instead.",
      remediation: emptyBody
        ? "Install a local transcription runtime, or keep this as a recorded spoken-evidence gap."
        : "Fetch the track URL directly to see what the source returns.",
      ...(emptyBody
        ? {
            hypothesis:
              "The platform appears to require a proof-of-origin token for timed text; this run did not establish that.",
            recoveryStopped:
              "No keyless caption route remains, and no local transcription runtime is available to person research.",
          }
        : {}),
    });
    return readVideoDescription(url, page, context);
  }
  const { text, anchors } = parseTimedText(captions.body);
  if (!text.trim()) return readVideoDescription(url, page, context);
  return {
    text: text.slice(0, MAX_TEXT),
    capturedAt: null,
    completeness: text.length > MAX_TEXT ? "partial" : "full",
    access: "retrieved",
    outboundUrls: [],
    family: "spoken-evidence",
    route: "caption-reader",
    upstreamIndex: "youtube.com",
    publishedAt: null,
    author: null,
    anchors,
    provenanceNote: track.asr
      ? "Automatic speech recognition captions. Timestamps locate speech; they do not identify the speaker."
      : "Publisher-provided captions. Timestamps locate speech; they do not identify the speaker.",
    sourceVersion: null,
    rights: null,
    finalUrl: page.url,
  };
}

async function readVideoDescription(
  url: string,
  page: PublicHttpResponse,
  context: ReadContext,
): Promise<SourceReadResult> {
  const description = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(page.body)?.[1];
  const title = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(page.body)?.[1];
  const text = [title, description]
    .filter(Boolean)
    .map((value) => unescapeJson(value!))
    .join("\n\n")
    .trim();
  if (!text)
    return unavailable("spoken-evidence", "caption-reader", "failed", context.snippet, url);
  return {
    text: text.slice(0, MAX_TEXT),
    capturedAt: null,
    completeness: "partial",
    access: "retrieved",
    outboundUrls: [],
    family: "spoken-evidence",
    route: "caption-reader",
    upstreamIndex: "youtube.com",
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote:
      "Publisher-written video description only; no caption track was available for this video.",
    sourceVersion: null,
    rights: null,
    finalUrl: page.url,
  };
}

function parseCaptionTracks(body: string): { baseUrl: string; asr: boolean }[] {
  const section = /"captionTracks":(\[.*?\])/s.exec(body)?.[1];
  if (!section) return [];
  const tracks: { baseUrl: string; asr: boolean }[] = [];
  for (const match of section.matchAll(/"baseUrl":"((?:[^"\\]|\\.)*)"/g)) {
    const raw = unescapeJson(match[1]!);
    const before = section.slice(0, match.index);
    const kind = /"kind":"asr"/.test(section.slice(match.index, match.index + 400));
    tracks.push({ baseUrl: raw, asr: kind || /"kind":"asr"/.test(before.slice(-400)) });
  }
  return tracks;
}

function parseTimedText(body: string): { text: string; anchors: SourceAnchor[] } {
  const anchors: SourceAnchor[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const match of body.matchAll(/<text[^>]*start="([\d.]+)"[^>]*>(.*?)<\/text>/gs)) {
    const seconds = Number(match[1]);
    const line = decodeXml(match[2] ?? "").trim();
    if (!line) continue;
    if (parts.length % 12 === 0) anchors.push({ kind: "timestamp", value: clock(seconds), offset });
    parts.push(line);
    offset += line.length + 1;
  }
  return { text: parts.join(" "), anchors };
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/* ------------------------------------------------------------------ */
/* Public social evidence                                              */
/* ------------------------------------------------------------------ */

/**
 * Anonymous reads of public social evidence.
 *
 * Bluesky and Mastodon both publish public timelines over unauthenticated
 * endpoints, so they are read directly. LinkedIn, Instagram, X and Threads do
 * not: the anonymous route is an authentication wall, and this records that as
 * an observed `login-required` gap rather than pretending the person has no
 * public presence there. No session is imported and no wall is bypassed.
 */
async function readSocial(url: string, context: ReadContext): Promise<SourceReadResult> {
  const host = hostOf(url) ?? "";
  if (/bsky\.app|bsky\.social/.test(host)) return readBluesky(url, context);
  if (/x\.com|twitter\.com|linkedin\.com|instagram\.com|threads\.net/.test(host)) {
    const response = await request(url, context, "social-reader");
    const challenge = response ? detectChallenge(response.body, response.contentType) : null;
    /* A public post page that actually renders anonymously is still worth
       reading; only a wall is recorded as a wall. */
    if (response && response.status < 400 && !challenge)
      return readHtml(url, response, "public-social", context);
    context.recorder.record({
      stage: "access",
      code:
        challenge ??
        (response
          ? classifyHttpStatus(response.status, response.body, response.contentType).code
          : "transport-failed"),
      outcome: "failed",
      recovery: "stopped",
      cause: response ? "observed" : "unknown",
      target: url,
      targetKind: "url",
      collector: "social-reader",
      reason: challenge
        ? `${host} served a ${challenge === "login-required" ? "sign-in" : "challenge"} page to an anonymous reader.`
        : `${host} did not return a readable anonymous response.`,
      attemptOf: context.attemptOf,
      ...(response
        ? {
            observed: {
              status: response.status,
              finalUrl: response.url,
              contentType: response.contentType,
              bytes: response.body.length,
            },
          }
        : {}),
      impact: `Public posts on ${host} did not contribute evidence.`,
      remediation:
        "No keyless anonymous route exists for this network; keep it as a recorded source gap.",
      recoveryStopped:
        "Signing in, importing a session or using a paid proxy is out of scope for data acquisition.",
    });
    return unavailable("public-social", "social-reader", "blocked", context.snippet, url);
  }
  return readMastodon(url, context);
}

async function readBluesky(url: string, context: ReadContext): Promise<SourceReadResult> {
  const handle = /\/profile\/([^/?#]+)/.exec(url)?.[1];
  if (!handle) return readWeb(url, "public-social", context);
  const feedUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=40`;
  const response = await request(feedUrl, context, "social-reader");
  if (!response || response.status >= 400) {
    context.recorder.record({
      stage: "access",
      code: response
        ? classifyHttpStatus(response.status, response.body, response.contentType).code
        : "transport-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: response ? "observed" : "unknown",
      target: feedUrl,
      targetKind: "record",
      collector: "social-reader",
      reason: response
        ? `HTTP ${response.status} from the public Bluesky endpoint.`
        : "The public Bluesky endpoint did not answer.",
      attemptOf: context.attemptOf,
      ...(response ? { observed: { status: response.status, finalUrl: response.url } } : {}),
      impact: "Public posts by this account did not contribute evidence.",
      remediation: `Reproduce with: curl -sS '${feedUrl}'`,
    });
    return unavailable("public-social", "social-reader", "failed", context.snippet, url);
  }
  const parsed = safeJson(response.body) as {
    feed?: {
      reason?: { $type?: string };
      post?: {
        uri?: string;
        author?: { handle?: string; did?: string };
        record?: { text?: string; createdAt?: string };
      };
    }[];
  } | null;
  const lines = (parsed?.feed ?? [])
    .map((entry) =>
      entry.post?.record?.text
        ? `${entry.post.record.createdAt ?? "unknown date"} — author: ${entry.post.author?.handle ?? entry.post.author?.did ?? "unknown (do not attribute to feed owner)"}; post: ${entry.post.uri ?? "unknown"}; ${entry.reason?.$type?.endsWith("#reasonRepost") ? "repost" : "feed entry"} — ${entry.post.record.text}`
        : "",
    )
    .filter(Boolean);
  if (!lines.length)
    return unavailable("public-social", "social-reader", "retrieved", context.snippet, url);
  const text = `Public Bluesky feed for ${handle}; entries retain their own authors\n\n${lines.join("\n\n")}`;
  return {
    text: text.slice(0, MAX_TEXT),
    capturedAt: null,
    completeness: "partial",
    access: "retrieved",
    outboundUrls: [],
    family: "public-social",
    route: "bluesky",
    upstreamIndex: "bsky.app",
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote:
      "The account's own posts. Self-report: a post is not independent verification of itself.",
    sourceVersion: null,
    rights: null,
    finalUrl: url,
  };
}

async function readMastodon(url: string, context: ReadContext): Promise<SourceReadResult> {
  const match = /^https?:\/\/([^/]+)\/@([^/?#]+)\/?$/.exec(url);
  if (!match) return readWeb(url, "public-social", context);
  const [, instance, handle] = match as unknown as [string, string, string];
  const lookup = `https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`;
  const account = await request(lookup, context, "social-reader");
  if (!account || account.status >= 400) {
    context.recorder.record({
      stage: "access",
      code: account
        ? classifyHttpStatus(account.status, account.body, account.contentType).code
        : "transport-failed",
      outcome: "failed",
      recovery: "alternative-route",
      cause: account ? "observed" : "unknown",
      target: lookup,
      targetKind: "record",
      collector: "social-reader",
      reason: account
        ? `HTTP ${account.status} from this instance's public account lookup.`
        : "The instance's public account lookup did not answer.",
      attemptOf: context.attemptOf,
      impact: "Falling back to the public profile page for this account.",
      remediation: `Reproduce with: curl -sS '${lookup}'`,
    });
    return readWeb(url, "public-social", context);
  }
  const id = (safeJson(account.body) as { id?: string } | null)?.id;
  if (!id) return readWeb(url, "public-social", context);
  const statuses = await request(
    `https://${instance}/api/v1/accounts/${encodeURIComponent(id)}/statuses?limit=40&exclude_replies=true`,
    context,
    "social-reader",
  );
  const posts =
    (safeJson(statuses?.body ?? "null") as { created_at?: string; content?: string }[] | null) ??
    [];
  const lines = posts
    .map((post) => `${post.created_at ?? "unknown date"} — ${stripTags(post.content ?? "")}`)
    .filter((line) => line.length > 20);
  if (!lines.length) return readWeb(url, "public-social", context);
  const text = `Public Mastodon posts by @${handle}@${instance}\n\n${lines.join("\n\n")}`;
  return {
    text: text.slice(0, MAX_TEXT),
    capturedAt: null,
    completeness: "partial",
    access: "retrieved",
    outboundUrls: [],
    family: "public-social",
    route: "mastodon",
    upstreamIndex: instance,
    publishedAt: null,
    author: `@${handle}@${instance}`,
    anchors: [],
    provenanceNote:
      "The account's own posts. Self-report: a post is not independent verification of itself.",
    sourceVersion: null,
    rights: null,
    finalUrl: url,
  };
}

/* ------------------------------------------------------------------ */
/* Structured records                                                   */
/* ------------------------------------------------------------------ */

/**
 * Public record routes read as data rather than as pages.
 *
 * Each entry is one anonymous, keyless endpoint verified against its own
 * current documentation. A URL that matches gets its JSON rendered into
 * readable, quotable lines so a claim can cite a record the same way it cites
 * an article.
 */
interface RecordRoute {
  match: RegExp;
  build: (url: URL) => string | null;
  index: string;
  /**
   * Where to look next when the first index does not hold this identifier.
   *
   * A DOI is one namespace with several registration agencies behind it, so
   * the work index answering 404 is that agency saying "not mine", not the
   * record being unreadable: a deposited dataset resolves through DataCite
   * exactly where a journal article resolves through Crossref (#249).
   */
  alternates?: { build: (url: URL) => string | null; index: string }[];
}

const RECORD_ROUTES: RecordRoute[] = [
  {
    match: /(^|\.)wikidata\.org$/,
    index: "wikidata.org",
    build: (url) => {
      const id = /(Q\d+)/.exec(url.pathname)?.[1];
      return id ? `https://www.wikidata.org/wiki/Special:EntityData/${id}.json` : null;
    },
  },
  {
    match: /(^|\.)doi\.org$/,
    index: "crossref.org",
    build: (url) => `https://api.crossref.org/works/${encodeURIComponent(url.pathname.slice(1))}`,
    alternates: [
      {
        index: "datacite.org",
        build: (url) =>
          `https://api.datacite.org/dois/${encodeURIComponent(url.pathname.slice(1))}`,
      },
    ],
  },
  {
    match: /(^|\.)crossref\.org$/,
    index: "crossref.org",
    build: (url) => url.toString(),
  },
  {
    match: /(^|\.)datacite\.org$/,
    index: "datacite.org",
    build: (url) => url.toString(),
  },
  {
    match: /(^|\.)openalex\.org$/,
    index: "openalex.org",
    build: (url) =>
      url.hostname.startsWith("api.") ? url.toString() : `https://api.openalex.org${url.pathname}`,
  },
  {
    match: /(^|\.)orcid\.org$/,
    index: "orcid.org",
    build: (url) => {
      const id = /(\d{4}-\d{4}-\d{4}-[\dX]{4})/.exec(url.pathname)?.[1];
      return id ? `https://pub.orcid.org/v3.0/${id}/record` : null;
    },
  },
  {
    match: /(^|\.)ror\.org$/,
    index: "ror.org",
    build: (url) => {
      const id = /([0-9a-z]{9})/.exec(url.pathname)?.[1];
      return id ? `https://api.ror.org/organizations/${id}` : null;
    },
  },
  {
    match: /(^|\.)clinicaltrials\.gov$/,
    index: "clinicaltrials.gov",
    build: (url) => {
      const id = /(NCT\d{8})/.exec(url.pathname + url.search)?.[1];
      return id ? `https://clinicaltrials.gov/api/v2/studies/${id}` : null;
    },
  },
  {
    match: /(^|\.)npiregistry\.cms\.hhs\.gov$/,
    index: "npiregistry.cms.hhs.gov",
    build: (url) => {
      const npi = url.searchParams.get("number") ?? /(\d{10})/.exec(url.pathname)?.[1];
      return npi
        ? `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${encodeURIComponent(npi)}`
        : null;
    },
  },
  {
    match: /(^|\.)openlibrary\.org$/,
    index: "openlibrary.org",
    build: (url) => {
      const path = url.pathname;
      if (path.startsWith("/search/authors.json")) return url.toString();
      const match = /^\/(authors|books|works)\/(OL[0-9A-Za-z]+)(\.json)?$/i.exec(path);
      if (match) {
        return `https://openlibrary.org/${match[1]}/${match[2]}.json`;
      }
      return null;
    },
  },
  {
    match: /(^|\.)tvmaze\.com$/,
    index: "tvmaze.com",
    build: (url) => {
      const personId = /\/people\/(\d+)/.exec(url.pathname)?.[1];
      if (personId) return `https://api.tvmaze.com/people/${personId}?embed=castcredits`;
      const showId = /\/shows\/(\d+)/.exec(url.pathname)?.[1];
      if (showId) return `https://api.tvmaze.com/shows/${showId}?embed=cast`;
      return url.hostname.startsWith("api.")
        ? url.toString()
        : `https://api.tvmaze.com${url.pathname}${url.search}`;
    },
  },
  {
    match: /(^|\.)artic\.edu$/,
    index: "artic.edu",
    build: (url) =>
      url.hostname.startsWith("api.")
        ? url.toString()
        : `https://api.artic.edu/api/v1${url.pathname.replace(/^\/artworks/, "/artworks")}`,
  },
  {
    match: /(^|\.)loc\.gov$/,
    index: "loc.gov",
    build: (url) => {
      const next = new URL(url.toString());
      next.searchParams.set("fo", "json");
      return next.toString();
    },
  },
];

/**
 * Every upstream index a page can be escalated to.
 *
 * #230's eligibility check walks these beside the search providers: reading a
 * record is data acquisition too, so a route added above has to declare what
 * it costs before it can be reached from production.
 */
export const RECORD_ROUTE_INDEXES: readonly string[] = [
  ...new Set(
    RECORD_ROUTES.flatMap((route) => [
      route.index,
      ...(route.alternates ?? []).map((alternate) => alternate.index),
    ]),
  ),
];

/** The endpoints a URL can be read as a record at, in the order they are tried. */
function recordRoute(url: string): { endpoint: string; index: string }[] {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    for (const route of RECORD_ROUTES) {
      if (!route.match.test(host)) continue;
      return [route, ...(route.alternates ?? [])].flatMap((entry) => {
        const endpoint = entry.build(parsed);
        return endpoint ? [{ endpoint, index: entry.index }] : [];
      });
    }
    return [];
  } catch {
    return [];
  }
}

async function readRecord(
  url: string,
  routes: { endpoint: string; index: string }[],
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  for (const [position, route] of routes.entries()) {
    /* Record endpoints answer data, not pages: several of them serve XML or a
       406 to the shared transport's HTML-first accept list. */
    const response = await request(route.endpoint, context, "record-reader", "application/json");
    if (response) {
      if (response.status < 400) return renderJson(url, response, family, context, route.index);
      const parsed = safeJson(response.body);
      const nonRecord = parsed
        ? (registryNonRecordBody(route.index, parsed) ?? creativeNonRecordBody(route.index, parsed))
        : null;
      if (nonRecord) {
        const refusal = nonRecord === "registry-error-envelope";
        context.recorder.record({
          stage: "access",
          code: nonRecord,
          outcome: "failed",
          recovery: "stopped",
          cause: "observed",
          target: response.url,
          targetKind: "record",
          collector: "record-reader",
          reason: refusal
            ? `The ${route.index} record endpoint answered HTTP ${response.status} with its own error envelope rather than a record.`
            : `The ${route.index} record endpoint answered: no record for this identifier.`,
          attemptOf: context.attemptOf,
          observed: {
            status: response.status,
            finalUrl: response.url,
            bytes: response.body.length,
            bodyHash: hash(response.body),
          },
          impact: refusal
            ? "The record contributed no text."
            : `The ${route.index} catalogue holds no record for this identifier.`,
          remediation: `Retry later, then reproduce with: curl -sS '${response.url}'`,
        });
        return unavailable(family, "record-reader", "failed", "", response.url);
      }
    }
    const remaining = routes.length - position - 1;
    context.recorder.record({
      stage: "access",
      code: response
        ? classifyHttpStatus(response.status, response.body, response.contentType).code
        : "transport-failed",
      outcome: "failed",
      recovery: "alternative-route",
      cause: response ? "observed" : "unknown",
      target: route.endpoint,
      targetKind: "record",
      collector: "record-reader",
      reason: response
        ? `HTTP ${response.status} from the ${route.index} public record endpoint.`
        : `The ${route.index} public record endpoint did not answer.`,
      attemptOf: context.attemptOf,
      ...(response ? { observed: { status: response.status, finalUrl: response.url } } : {}),
      impact: remaining
        ? "Trying the next index that registers this identifier."
        : "Falling back to reading the record's human-facing page.",
      remediation: `Reproduce with: curl -sS '${route.endpoint}'`,
    });
  }
  return readWeb(url, family, context);
}

function renderJson(
  url: string,
  response: PublicHttpResponse,
  family: PersonSourceFamily,
  context: ReadContext,
  index: string,
): SourceReadResult {
  const parsed = safeJson(response.body);
  if (parsed === null) {
    context.recorder.record({
      stage: "document-parsing",
      code: "parser-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "record",
      collector: "record-reader",
      reason: "The record endpoint answered with a body that is not JSON.",
      attemptOf: context.attemptOf,
      observed: {
        contentType: response.contentType,
        bytes: response.body.length,
        excerpt: response.body.slice(0, 400),
      },
      impact: "The record contributed no text.",
      remediation: "Inspect the endpoint's response shape; it may have changed.",
    });
    return unavailable(family, "record-reader", "failed", context.snippet, response.url);
  }
  /* A publication or deposit record, and a professional or institutional
     record, are each rendered field by field rather than flattened whole: the
     flattener would carry an abstract into retained text under a permission
     that does not cover it, or a registry's organisation scale into a
     personal-competence claim, and would drop the dates, record version and
     rights a claim on this evidence has to keep (#249, #250). */
  const publication = renderPublicationRecord(index, parsed);
  /* Only ever computed when the body was not a publication record: the two
     renderers read the same shapes for different indexes, so a body that
     matched one never needs to be tried against the other. */
  const institutional = publication ? null : renderInstitutionalRecord(index, parsed);
  const creative = publication || institutional ? null : renderCreativeRecord(index, parsed);
  const structured = publication ?? institutional ?? creative;
  if (structured)
    return {
      text: structured.text.slice(0, MAX_TEXT),
      /* A record read live carries no capture date: it is the index's current
         answer, not evidence of what it said on some earlier day (#253). */
      capturedAt: null,
      completeness: structured.text.length > MAX_TEXT ? "partial" : "full",
      access: "retrieved",
      outboundUrls: structured.outboundUrls.slice(0, 200),
      family,
      route: "record-reader",
      upstreamIndex: index,
      publishedAt: structured.publishedAt,
      /* The people in the record are its subject, not its author: the index
         published the record, and naming a listed author here would turn
         participation into authorship of the evidence about it. */
      author: null,
      anchors: structured.anchors,
      provenanceNote: structured.provenanceNote,
      sourceVersion: structured.sourceVersion,
      rights: structured.rights,
      finalUrl: response.url,
      ...(institutional ? { namedIndividuals: institutional.namedIndividuals } : {}),
    };
  /* An identity or affiliation registry record is rendered the same
     deliberate way: the identifier and affiliations are what a claim can cite
     as the anchor, and the flattener would carry a linked work's title in as
     if the registry itself established it (#252). */
  const identityAnchor = renderIdentityAnchor(index, parsed);
  if (identityAnchor)
    return {
      text: identityAnchor.text.slice(0, MAX_TEXT),
      capturedAt: null,
      completeness: identityAnchor.text.length > MAX_TEXT ? "partial" : "full",
      access: "retrieved",
      outboundUrls: identityAnchor.outboundUrls.slice(0, 200),
      family,
      route: "record-reader",
      upstreamIndex: index,
      publishedAt: identityAnchor.publishedAt,
      author: null,
      anchors: identityAnchor.anchors,
      provenanceNote: identityAnchor.provenanceNote,
      sourceVersion: identityAnchor.sourceVersion,
      rights: identityAnchor.rights,
      finalUrl: response.url,
    };
  /* A record index with a specialized renderer answers every request with
     either a record or one of the non-record answers its own conventions
     define: an error or refusal envelope, an empty result set. Such an
     answer is never retained as text — it can echo the requested name, and
     no rights basis, version or attribution would cover it (review finding
     on issue #250, PR #295) — so the read fails, the way the renderers
     above refuse a body that is not a record they can render. A body that
     is merely a record shape the renderer cannot fully read still
     flattens: that is the normal retention path for records this module
     has not grown into (#249, #250). */
  const nonRecord = registryNonRecordBody(index, parsed) ?? creativeNonRecordBody(index, parsed);
  if (nonRecord) {
    const refusal = nonRecord === "registry-error-envelope";
    context.recorder.record({
      stage: "access",
      code: nonRecord,
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: response.url,
      targetKind: "record",
      collector: "record-reader",
      reason: refusal
        ? `The ${index} record endpoint answered HTTP ${response.status} with its own error envelope rather than a record.`
        : `The ${index} record endpoint answered: no record for this identifier.`,
      attemptOf: context.attemptOf,
      /* Shape only: the answered address, its size and hash. The body's own
         text is exactly what must not be retained — it can echo the
         requested name. */
      observed: {
        finalUrl: response.url,
        bytes: response.body.length,
        bodyHash: hash(response.body),
      },
      impact: refusal
        ? "The record contributed no text."
        : "The registry holds no record for this identifier.",
      remediation: `Retry later, then reproduce with: curl -sS '${response.url}'`,
    });
    return unavailable(family, "record-reader", "failed", "", response.url);
  }
  const text = flattenJson(parsed);
  return {
    text: text.slice(0, MAX_TEXT),
    capturedAt: null,
    completeness: text.length > MAX_TEXT ? "partial" : "full",
    access: "retrieved",
    outboundUrls: [...new Set(collectUrls(parsed))].slice(0, 200),
    family,
    route: "record-reader",
    upstreamIndex: index,
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote: `Structured public record from ${index}, rendered as field lines.`,
    sourceVersion: null,
    rights: null,
    finalUrl: response.url,
  };
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * One anonymous request with its own retry.
 *
 * Retries happen here, per request, rather than in the operation loop: waiting
 * out a `Retry-After` inside a serial reading loop stalls every other source
 * for that person, which is exactly what the parallel batches above exist to
 * avoid. The caller reads one settled response.
 */
async function request(
  url: string,
  context: ReadContext,
  collector: CollectorName,
  accept?: string,
): Promise<PublicHttpResponse | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await context.fetch(url, {
        timeoutMs: context.timeoutMs,
        ...(accept ? { accept } : {}),
      });
      if (response.status < 400) {
        if (attempt > 1)
          context.recorder.record({
            stage: "transport",
            code: "retrieval-recovered",
            outcome: "recovered",
            recovery: "recovered",
            cause: "observed",
            target: url,
            targetKind: "url",
            collector,
            reason: "Retrieval succeeded after a temporary failure.",
            attemptOf: context.attemptOf,
            attempt,
            observed: {
              status: response.status,
              finalUrl: response.url,
              elapsedMilliseconds: Date.now() - startedAt,
            },
          });
        return response;
      }
      const temporary = response.status === 429 || [500, 502, 503, 504].includes(response.status);
      if (!temporary || attempt === 3) return response;
      const requestedDelay = retryAfterMilliseconds(response.retryAfter, new Date());
      const delay = requestedDelay ?? Math.min(8_000, 500 * 2 ** attempt);
      const retrying = delay <= 60_000;
      context.recorder.record({
        stage: "transport",
        code: response.status === 429 ? "rate-limited" : "http-error",
        outcome: "failed",
        recovery: retrying ? "retry" : "stopped",
        cause: "observed",
        target: url,
        targetKind: "url",
        collector,
        reason: retrying
          ? `HTTP ${response.status}; waiting ${delay} ms before retrying.`
          : `HTTP ${response.status}; Retry-After exceeds this request's recovery allowance.`,
        ...(!retrying
          ? {
              recoveryStopped:
                "The upstream Retry-After exceeds the 60-second request recovery allowance; this route will not retry early.",
            }
          : {}),
        attemptOf: context.attemptOf,
        attempt,
        observed: {
          status: response.status,
          finalUrl: response.url,
          contentType: response.contentType,
          bytes: response.body.length,
          bodyHash: hash(response.body),
          ...(requestedDelay !== undefined ? { retryAfterMilliseconds: requestedDelay } : {}),
          elapsedMilliseconds: Date.now() - startedAt,
        },
      });
      if (!retrying) return response;
      await sleep(delay);
    } catch (error) {
      lastError = error;
      const { code, reason } = classifyTransportError(error);
      const retrying = attempt < 3;
      context.recorder.record({
        stage: "transport",
        code,
        outcome: "failed",
        recovery: retrying ? "retry" : "stopped",
        cause: code === "transport-failed" ? "unknown" : "observed",
        target: url,
        targetKind: "url",
        collector,
        reason: `${reason}${retrying ? " Retrying." : ""}`,
        attemptOf: context.attemptOf,
        attempt,
        observed: { elapsedMilliseconds: Date.now() - startedAt },
        ...(retrying ? {} : { recoveryStopped: "The retry budget for this request is spent." }),
      });
      if (!retrying) return null;
      await sleep(Math.min(4_000, 500 * 2 ** attempt));
    }
  }
  return lastError ? null : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function looksLikeBinaryDocument(url: string): boolean {
  return /\.(pdf|docx)(\?|#|$)/i.test(url);
}

function documentFileName(url: string, contentType: string | null): string {
  if (/\.pdf(\?|#|$)/i.test(url) || contentType?.includes("pdf")) return "source.pdf";
  if (/\.docx(\?|#|$)/i.test(url) || contentType?.includes("wordprocessingml"))
    return "source.docx";
  return "source.txt";
}

function isFeed(contentType: string, body: string): boolean {
  if (/(rss|atom)\+xml/.test(contentType)) return true;
  return /^\s*<\?xml/.test(body) && /<(rss|feed)[\s>]/i.test(body.slice(0, 4000));
}

function pageAnchors(text: string): SourceAnchor[] {
  const anchors: SourceAnchor[] = [];
  for (const match of text.matchAll(/\n\[page (\d+)\]\n/g))
    anchors.push({ kind: "page", value: match[1]!, offset: match.index });
  return anchors.slice(0, 500);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return decodeXml(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function unescapeJson(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/** Render a record into quotable lines. Bounded in depth, breadth and size. */
function flattenJson(value: unknown, prefix = "", depth = 0): string {
  if (depth > 6) return "";
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") {
    const text =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value).trim()
        : "";
    return text && text.length < 4000 ? `${prefix}: ${text}\n` : "";
  }
  if (Array.isArray(value))
    return value
      .slice(0, 40)
      .map((entry, index) => flattenJson(entry, `${prefix}[${index}]`, depth + 1))
      .join("");
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 80)
    .map(([key, entry]) => flattenJson(entry, prefix ? `${prefix}.${key}` : key, depth + 1))
    .join("");
}

function collectUrls(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== "object") {
    return typeof value === "string" && /^https?:\/\//.test(value) ? [value] : [];
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return entries.slice(0, 80).flatMap((entry) => collectUrls(entry, depth + 1));
}
