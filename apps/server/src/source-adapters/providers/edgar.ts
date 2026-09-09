import { createHttpFetch, retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
// SEC EDGAR 403s generic user agents — the declared-contact UA is the whole
// access model (research doc, Layer 3, live-verified both ways). It is bound
// at the transport because PublicHttpFetch has no per-call header channel.
const DECLARED_UA =
  "Found42-Content-Scout/1.0 (public-source-monitor; contact: owner@found42.local)";
const ENDPOINT = "https://efts.sec.gov/LATEST/search-index";

/** An http(s) URL string, or null — a result without a usable URL is dropped, never invented. */
function usableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function clippedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function clippedList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((s) => s.slice(0, limit))
    : [];
}

/** Narrows parsed-JSON `unknown` to a keyed record so field reads stay checked. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** EDGAR's `_id` is `<accession-no>:<filename>`; the archive path works from the accession alone. */
function filingUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const accession = value.slice(0, separator);
  const filename = value.slice(separator + 1);
  if (accession.length === 0 || filename.length === 0) return null;
  return usableUrl(
    `https://www.sec.gov/Archives/edgar/data/${accession.replaceAll("-", "")}/${filename}`,
  );
}

export function createEdgarProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  const fetch =
    options.fetch ??
    createHttpFetch({ headers: { "user-agent": DECLARED_UA, accept: "application/json" } });
  return {
    name: "edgar",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const url = `${ENDPOINT}?q=${encodeURIComponent(`"${query}"`)}&forms=10-K`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });
      if (response.status !== 200) {
        const rateLimited = response.status === 429 || response.status === 503;
        throw new ProviderRefusedError(
          rateLimited ? "rate-limited" : "error",
          `SEC EDGAR answered ${String(response.status)}.`,
          rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "SEC EDGAR returned a malformed body.");
      }
      const parsedBody = asRecord(parsed);
      // parsed.hits is already Elasticsearch's hits wrapper ({ total, hits: [...] }).
      const hitsWrapper = parsedBody ? asRecord(parsedBody.hits) : null;
      if (!hitsWrapper || !Array.isArray(hitsWrapper.hits)) {
        throw new ProviderRefusedError("error", "SEC EDGAR returned an unexpected body shape.");
      }
      const results: PublicSearchResult[] = [];
      for (const entry of hitsWrapper.hits.slice(0, MAX_RESULTS)) {
        const record = asRecord(entry);
        if (!record) continue;
        const source = asRecord(record._source);
        if (!source) continue;
        const url = filingUrl(record._id);
        if (!url) continue;
        // display_names carries entity/ticker/CIK aliases; biz_locations the
        // registered addresses — the employer/role evidence the layer exists for.
        const names = clippedList(source.display_names, 200);
        const locations = clippedList(source.biz_locations, 200);
        results.push({
          title: clippedText(names[0], 200),
          url,
          snippet: clippedText([...names.slice(1), ...locations].join("; "), 400),
        });
      }
      return results;
    },
  };
}
