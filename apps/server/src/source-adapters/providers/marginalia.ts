import { createHttpFetch, retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;

/** API fields are strings in practice; anything else parses as absent. */
function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string").join(" ");
  }
  return "";
}

/**
 * Marginalia Search (ADR-0049, layer 2) — an independent non-commercial index
 * with a documented keyless path: the shared `API-Key: public` header against
 * api2.marginalia-search.com (about.marginalia-search.com/article/api/). The
 * key is QPM-contended across everyone using it, so a 503 "QPM Limit
 * Exceeded" is normal operation, not an outage — the provider refuses as
 * rate-limited and the composite's cooldown paces later queries instead of
 * any provider-side retry.
 */
export function createMarginaliaProvider(
  options: { fetch?: PublicHttpFetch } = {},
): SearchProvider {
  // Curated transport: the api-key header is part of how this source is
  // addressed, so it binds here rather than riding the composite's io.fetch.
  const fetch = options.fetch ?? createHttpFetch({ headers: { "api-key": "public" } });
  return {
    name: "marginalia",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const response = await fetch(
        `https://api2.marginalia-search.com/search?query=${encodeURIComponent(query)}&count=${MAX_RESULTS}`,
        { timeoutMs: io.timeoutMs },
      );
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          // The research doc's live probe: the shared public key saturates its
          // QPM regularly and answers 503 while the service itself is up.
          throw new ProviderRefusedError(
            "rate-limited",
            `Marginalia is rate-limited: the search API answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `Marginalia search failed: the search API answered ${String(response.status)}.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError(
          "error",
          "Marginalia search failed: the response was not the documented result array.",
        );
      }
      if (!Array.isArray(parsed)) {
        throw new ProviderRefusedError(
          "error",
          "Marginalia search failed: the response was not the documented result array.",
        );
      }
      const results: PublicSearchResult[] = [];
      for (const entry of parsed.slice(0, MAX_RESULTS)) {
        if (typeof entry !== "object" || entry === null) continue;
        const { url, title, description } = entry as {
          url?: unknown;
          title?: unknown;
          description?: unknown;
        };
        // A result without a usable URL is dropped, never invented.
        let resolved: URL;
        try {
          resolved = new URL(typeof url === "string" ? url : "");
        } catch {
          continue;
        }
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
        results.push({
          title: fieldText(title).slice(0, 200),
          url: resolved.toString(),
          snippet: fieldText(description).slice(0, 400),
        });
      }
      return results;
    },
  };
}
