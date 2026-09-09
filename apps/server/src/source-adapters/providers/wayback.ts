import type { PublicSearchResult } from "../search.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";
import { ProviderRefusedError } from "./types.js";

/**
 * The availability API answers 200 but slowly: the research doc's probes took
 * 25–75 s (docs/research/public-search-providers.md, "Wayback"), so this
 * provider overrides the composite's per-request deadline rather than timing
 * out on healthy answers.
 */
const WAYBACK_TIMEOUT_MS = 90_000;

type ClosestSnapshot = { url: string; timestamp: string };

/**
 * The availability body is `{ archived_snapshots: { closest: { url, timestamp } } }`
 * or `{ archived_snapshots: {} }` when nothing was captured. Returns `null`
 * for the clean no-snapshot fact, `"malformed"` for a body that is not the
 * documented shape, and the snapshot otherwise.
 */
function parseClosestSnapshot(body: string): ClosestSnapshot | null | "malformed" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "malformed";
  }
  if (typeof parsed !== "object" || parsed === null || !("archived_snapshots" in parsed)) {
    return "malformed";
  }
  const archived = parsed.archived_snapshots;
  if (typeof archived !== "object" || archived === null || !("closest" in archived)) return null;
  const closest: unknown = archived.closest;
  if (typeof closest !== "object" || closest === null) return null;
  if (!("url" in closest) || !("timestamp" in closest)) return "malformed";
  const { url, timestamp } = closest;
  // A result without a usable absolute http(s) URL is dropped, never invented.
  if (typeof url !== "string" || typeof timestamp !== "string" || !/^https?:\/\//i.test(url)) {
    return "malformed";
  }
  return { url, timestamp };
}

/**
 * Wayback lookup (ADR-0049, pinned name "wayback"): the only provider whose
 * query is itself a URL. An availability hit becomes ONE result pointing at
 * the closest archived snapshot; anything else is an empty fact or a refusal.
 */
export function createWaybackProvider(): SearchProvider {
  return {
    name: "wayback",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      // Only an absolute http(s) URL means "is this page archived?"; any other
      // query is a different question entirely and must not fire a request.
      let parsedQuery: URL;
      try {
        parsedQuery = new URL(query);
      } catch {
        return [];
      }
      if (parsedQuery.protocol !== "http:" && parsedQuery.protocol !== "https:") return [];

      const response = await io.fetch(
        `https://archive.org/wayback/available?url=${encodeURIComponent(query)}`,
        { timeoutMs: WAYBACK_TIMEOUT_MS },
      );
      if (response.status === 429 || response.status === 503) {
        throw new ProviderRefusedError(
          "rate-limited",
          `Wayback availability API is rate-limited: answered ${String(response.status)}.`,
        );
      }
      if (response.status !== 200) {
        throw new ProviderRefusedError(
          "error",
          `Wayback availability API answered ${String(response.status)}.`,
        );
      }

      const snapshot = parseClosestSnapshot(response.body);
      if (snapshot === "malformed") {
        throw new ProviderRefusedError(
          "error",
          "Wayback availability API answered 200 with a malformed body.",
        );
      }
      if (snapshot === null) return [];
      return [
        {
          title: `Archived snapshot ${snapshot.timestamp}`,
          url: snapshot.url,
          snippet: `Wayback Machine copy of ${query}, captured ${snapshot.timestamp}.`,
        },
      ];
    },
  };
}
