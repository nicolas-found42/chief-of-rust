import { retryAfterMilliseconds } from "../http.js";
import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError } from "./types.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;

/** The excerpts endpoint wraps matched terms in `<span class="highlight">`;
 * stored snippets keep the matched words, not the decoration. */
const HIGHLIGHT_MARKUP = /<\/?span(?:\s[^>]*)?>/g;

function readsAsBackoffSeconds(value: unknown): value is { backoff: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "backoff" in value &&
    typeof value.backoff === "number"
  );
}

function hasExcerptItems(value: unknown): value is { items: unknown[] } {
  return (
    typeof value === "object" && value !== null && "items" in value && Array.isArray(value.items)
  );
}

function isExcerptHit(
  value: unknown,
): value is { title: unknown; question_id: unknown; excerpt: unknown } {
  return typeof value === "object" && value !== null && "title" in value && "question_id" in value;
}

/**
 * Stack Exchange excerpts (ADR-0049, layer 3) — real keyless full-text search
 * of the technical Q&A corpus, throttled to 300/day/IP anonymously. The
 * throttle answers two ways: an HTTP 429, or a 200 body carrying a `backoff`
 * seconds value; both refuse as rate-limited so the composite's cooldown
 * paces later queries instead of this provider retrying.
 */
export function createStackExchangeProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  return {
    name: "stackexchange",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const fetch = options.fetch ?? io.fetch;
      const response = await fetch(
        `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow`,
        { timeoutMs: io.timeoutMs },
      );

      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `stackexchange is rate-limited: search/excerpts answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `stackexchange search failed: search/excerpts answered ${String(response.status)}.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "stackexchange returned an unparseable body");
      }

      // A 200 can still be the daily throttle: the body carries `backoff`
      // seconds alongside (or instead of) the hits.
      if (readsAsBackoffSeconds(parsed)) {
        throw new ProviderRefusedError(
          "rate-limited",
          `stackexchange is rate-limited: the body carried a ${String(parsed.backoff)}s backoff.`,
          parsed.backoff * 1000,
        );
      }

      if (!hasExcerptItems(parsed)) {
        throw new ProviderRefusedError("error", "stackexchange returned a malformed excerpts body");
      }

      const results: PublicSearchResult[] = [];
      for (const item of parsed.items) {
        if (results.length >= MAX_RESULTS) break;
        if (!isExcerptHit(item)) continue;
        if (typeof item.question_id !== "number" || !Number.isInteger(item.question_id)) continue;
        const excerpt = typeof item.excerpt === "string" ? item.excerpt : "";
        results.push({
          title: (typeof item.title === "string" ? item.title : "").trim().slice(0, TITLE_LIMIT),
          url: `https://stackoverflow.com/q/${String(item.question_id)}`,
          snippet: excerpt.replace(HIGHLIGHT_MARKUP, "").trim().slice(0, SNIPPET_LIMIT),
        });
      }
      return results;
    },
  };
}
