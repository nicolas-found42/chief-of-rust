import { createHttpFetch } from "../http.js";
import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError } from "./types.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;
const WIKIDATA_ENDPOINT = "https://www.wikidata.org/w/api.php";

type WbSearchEntity = { label?: unknown; description?: unknown; concepturi?: unknown };

type WbSearchResponse = { search?: unknown };

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
 * Wikidata's entity search maps an entity to a result directly:
 * label → title, description → snippet, concepturi → the canonical
 * https://www.wikidata.org/wiki/Q… URL. An entity without a concepturi has no
 * usable URL and is dropped, never invented.
 */
export function createWikidataProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  const fetch: PublicHttpFetch = options.fetch ?? createHttpFetch();

  return {
    name: "wikidata",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const url = `${WIKIDATA_ENDPOINT}?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&format=json&limit=8`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });

      if (response.status !== 200) {
        throw new ProviderRefusedError(
          "error",
          `wikidata wbsearchentities answered HTTP ${response.status}`,
        );
      }

      let parsed: WbSearchResponse;
      try {
        parsed = JSON.parse(response.body) as WbSearchResponse;
      } catch {
        throw new ProviderRefusedError("error", "wikidata returned an unparseable body");
      }
      if (!Array.isArray(parsed.search)) {
        throw new ProviderRefusedError("error", "wikidata returned a body without search[]");
      }

      const results: PublicSearchResult[] = [];
      for (const raw of (parsed.search as unknown[]).slice(0, MAX_RESULTS)) {
        const entity = raw as WbSearchEntity;
        const resultUrl = absoluteHttpUrl(
          typeof entity.concepturi === "string" ? entity.concepturi : null,
        );
        if (resultUrl === null) continue;
        results.push({
          title: (typeof entity.label === "string" ? entity.label : "").slice(0, TITLE_LIMIT),
          url: resultUrl,
          snippet: (typeof entity.description === "string" ? entity.description : "").slice(
            0,
            SNIPPET_LIMIT,
          ),
        });
      }
      return results;
    },
  };
}
