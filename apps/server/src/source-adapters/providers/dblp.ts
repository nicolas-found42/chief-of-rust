import { retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
// DBLP's FAQ asks for one or two seconds between requests; like the other
// keyless sources here, pacing is the composite's cooldown job, not ours
// (research doc, Layer 3).
const ENDPOINT = "https://dblp.org/search/publ/api";

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

/** Narrows parsed-JSON `unknown` to a keyed record so field reads stay checked. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function createDblpProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return {
    name: "dblp",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const fetch = options.fetch ?? io.fetch;
      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=json&h=${MAX_RESULTS}`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });
      if (response.status !== 200) {
        const rateLimited = response.status === 429 || response.status === 503;
        throw new ProviderRefusedError(
          rateLimited ? "rate-limited" : "error",
          `DBLP answered ${String(response.status)}.`,
          rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "DBLP returned a malformed body.");
      }
      const body = asRecord(parsed);
      const result = body ? asRecord(body.result) : null;
      if (!result) {
        throw new ProviderRefusedError("error", "DBLP returned an unexpected body shape.");
      }
      const hits = asRecord(result.hits);
      if (!hits || !("hit" in hits)) {
        // DBLP omits `hits` entirely when nothing matched — an empty answer,
        // not a refusal.
        return [];
      }
      if (!Array.isArray(hits.hit)) {
        throw new ProviderRefusedError("error", "DBLP returned an unexpected body shape.");
      }
      const results: PublicSearchResult[] = [];
      for (const entry of hits.hit.slice(0, MAX_RESULTS)) {
        const record = asRecord(entry);
        const info = record ? asRecord(record.info) : null;
        if (!info) continue;
        const url = usableUrl(info.url);
        if (!url) continue;
        results.push({
          url,
          title: clippedText(info.title, 200),
          snippet: clippedText(
            [info.venue, info.year]
              .filter((part): part is string => typeof part === "string")
              .join(", "),
            400,
          ),
        });
      }
      return results;
    },
  };
}
