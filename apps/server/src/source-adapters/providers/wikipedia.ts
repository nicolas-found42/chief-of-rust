import { createHttpFetch } from "../http.js";
import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError } from "./types.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;
const OPENSEARCH_ENDPOINT = "https://en.wikipedia.org/w/api.php";

function absoluteHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Wikipedia's opensearch answers a positional array
 * `[query, [titles], [descriptions], [urls]]` (the MediaWiki opensearch JSON
 * format) — titles, descriptions and URLs are matched by index, and a missing
 * description at an index simply means an empty snippet.
 */
export function createWikipediaProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  const fetch: PublicHttpFetch = options.fetch ?? createHttpFetch();

  return {
    name: "wikipedia",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const url = `${OPENSEARCH_ENDPOINT}?action=opensearch&search=${encodeURIComponent(query)}&limit=8&format=json&namespace=0`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });

      if (response.status !== 200) {
        throw new ProviderRefusedError(
          "error",
          `wikipedia opensearch answered HTTP ${response.status}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "wikipedia returned an unparseable body");
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length < 4 ||
        !parsed.slice(1).every((part) => Array.isArray(part))
      ) {
        throw new ProviderRefusedError("error", "wikipedia returned a malformed opensearch body");
      }

      const [, titles, descriptions, urls] = parsed as [unknown, unknown[], unknown[], unknown[]];
      const results: PublicSearchResult[] = [];
      for (let index = 0; index < Math.min(titles.length, MAX_RESULTS); index += 1) {
        // A result without a usable URL is dropped, never invented.
        const resultUrl = absoluteHttpUrl(
          typeof urls[index] === "string" ? (urls[index] as string) : null,
        );
        if (resultUrl === null) continue;
        results.push({
          title: (typeof titles[index] === "string" ? (titles[index] as string) : "").slice(
            0,
            TITLE_LIMIT,
          ),
          url: resultUrl,
          snippet: (typeof descriptions[index] === "string"
            ? (descriptions[index] as string)
            : ""
          ).slice(0, SNIPPET_LIMIT),
        });
      }
      return results;
    },
  };
}
