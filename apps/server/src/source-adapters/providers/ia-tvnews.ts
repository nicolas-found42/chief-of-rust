import { retryAfterMilliseconds } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
/**
 * Internet Archive TV News (ADR-0049, layer 2 vertical) — broadcast-news
 * captions scoped to the `tvarchive` collection through the same keyless
 * `advancedsearch.php` endpoint the research doc live-verified (8,994 hits
 * for a person query). Co-mention surface nobody else covers. The mapping is
 * deliberately self-contained rather than shared with the general Internet
 * Archive provider: it is a different slice of the same endpoint, and no
 * provider imports another. The ~1 req/s pace on caption files is honored by
 * refusing fast — the composite's cooldown paces later queries.
 */
export function createIaTvNewsProvider(): SearchProvider {
  return {
    name: "ia-tvnews",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      /* The composite sends two query shapes: plain phrases, and co-mention
         queries that already carry quotes and OR/AND operators. Nesting
         either inside this endpoint's own Solr phrase quotes breaks the
         parse outright or guts it (the whole boolean string becomes one
         literal), so boolean queries are sent verbatim and only plain ones
         are wrapped. */
      const isBoolean = /["()]|\b(?:OR|AND|NOT)\b/.test(query);
      const clause = isBoolean ? query : `"${query}"`;
      const response = await io.fetch(
        `https://archive.org/advancedsearch.php?q=collection%3A%22tvarchive%22+AND+${encodeURIComponent(clause)}` +
          `&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&rows=${MAX_RESULTS}&output=json`,
        { timeoutMs: io.timeoutMs },
      );
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `Internet Archive TV News is rate-limited: advancedsearch.php answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `Internet Archive TV News search failed: advancedsearch.php answered ${String(response.status)}.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError(
          "error",
          "Internet Archive TV News search failed: the response was not the documented search format.",
        );
      }
      const docs = (parsed as { response?: { docs?: unknown } } | null)?.response?.docs;
      if (!Array.isArray(docs)) {
        throw new ProviderRefusedError(
          "error",
          "Internet Archive TV News search failed: the response had no document list.",
        );
      }
      const results: PublicSearchResult[] = [];
      for (const doc of docs.slice(0, MAX_RESULTS)) {
        if (typeof doc !== "object" || doc === null) continue;
        const { identifier, title, description } = doc as {
          identifier?: unknown;
          title?: unknown;
          description?: unknown;
        };
        // A result without a usable identifier is dropped, never invented.
        if (typeof identifier !== "string" || identifier === "") continue;
        // The archive.org metadata model wraps scalar fields like `title` or
        // `description` in a one-element array, so text fields are
        // array-joined before slicing.
        results.push({
          title: (Array.isArray(title) ? title.map(asText).join(" ") : asText(title))
            .trim()
            .slice(0, 200),
          url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
          snippet: (Array.isArray(description)
            ? description.map(asText).join(" ")
            : asText(description)
          )
            .trim()
            .slice(0, 400),
        });
      }
      return results;
    },
  };
}
