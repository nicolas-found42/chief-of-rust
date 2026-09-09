import { retryAfterMilliseconds } from "../http.js";
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
 * Wiby (ADR-0049, layer 4 vertical) — a small-web index of personal
 * homepages, the supplement surface the research doc names for finding
 * pages the big indexes never crawl: `wiby.me/json/?q=…` answers a plain
 * keyless GET with an array of `{ URL, Title, Snippet }`.
 */
export function createWibyProvider(): SearchProvider {
  return {
    name: "wiby",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const response = await io.fetch(`https://wiby.me/json/?q=${encodeURIComponent(query)}`, {
        timeoutMs: io.timeoutMs,
      });
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `Wiby search failed: the JSON API answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `Wiby search failed: the JSON API answered ${String(response.status)}.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError(
          "error",
          "Wiby search failed: the response was not the documented result array.",
        );
      }
      if (!Array.isArray(parsed)) {
        throw new ProviderRefusedError(
          "error",
          "Wiby search failed: the response was not the documented result array.",
        );
      }
      const results: PublicSearchResult[] = [];
      for (const entry of parsed.slice(0, MAX_RESULTS)) {
        if (typeof entry !== "object" || entry === null) continue;
        const {
          URL: url,
          Title: title,
          Snippet: snippet,
        } = entry as {
          URL?: unknown;
          Title?: unknown;
          Snippet?: unknown;
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
          snippet: fieldText(snippet).slice(0, 400),
        });
      }
      return results;
    },
  };
}
