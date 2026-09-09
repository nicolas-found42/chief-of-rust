import { retryAfterMilliseconds } from "../http.js";
import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError } from "./types.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;

function isArticle(
  value: unknown,
): value is { title: unknown; doi: unknown; id: unknown; source: unknown; abstractText: unknown } {
  return typeof value === "object" && value !== null && "id" in value;
}

function absoluteHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The DOI resolves to the publisher's landing page when one exists; without
 * a DOI the Europe PMC article route is the stable public location. */
function articleUrl(article: { doi: unknown; id: unknown; source: unknown }): string | null {
  if (typeof article.doi === "string" && article.doi !== "") {
    return absoluteHttpUrl(`https://doi.org/${article.doi}`);
  }
  if (
    typeof article.source === "string" &&
    article.source !== "" &&
    typeof article.id === "string" &&
    article.id !== ""
  ) {
    return absoluteHttpUrl(`https://europepmc.org/article/${article.source}/${article.id}`);
  }
  return null;
}

/**
 * Europe PMC (ADR-0049, layer 3) — the keyless academic search the research
 * doc live-verified at 200. Its REST search is generous, so the only refusals
 * here are transport-shaped: a non-200 or a body that is not the documented
 * `resultList.result` shape.
 */
export function createEuropePmcProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return {
    name: "europepmc",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const fetch = options.fetch ?? io.fetch;
      const response = await fetch(
        `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=8`,
        { timeoutMs: io.timeoutMs },
      );

      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `europepmc is rate-limited: rest/search answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `europepmc search failed: rest/search answered ${String(response.status)}.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "europepmc returned an unparseable body");
      }

      const hits =
        typeof parsed === "object" && parsed !== null && "resultList" in parsed
          ? resultListHits(parsed.resultList)
          : null;
      if (hits === null) {
        throw new ProviderRefusedError("error", "europepmc returned a malformed result list");
      }

      const results: PublicSearchResult[] = [];
      for (const hit of hits) {
        if (results.length >= MAX_RESULTS) break;
        if (!isArticle(hit)) continue;
        const url = articleUrl(hit);
        if (url === null) continue;
        results.push({
          title: (typeof hit.title === "string" ? hit.title : "").trim().slice(0, TITLE_LIMIT),
          url,
          snippet: (typeof hit.abstractText === "string" ? hit.abstractText : "")
            .trim()
            .slice(0, SNIPPET_LIMIT),
        });
      }
      return results;
    },
  };
}

function resultListHits(value: unknown): unknown[] | null {
  if (typeof value !== "object" || value === null || !("result" in value)) return null;
  const result: unknown = value.result;
  return Array.isArray(result) ? result : null;
}
