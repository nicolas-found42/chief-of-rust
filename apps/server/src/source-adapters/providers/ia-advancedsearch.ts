import { retryAfterMilliseconds } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;

/**
 * Archive.org repeats a scalar metadata field as a one-element array of
 * strings; anything else parses as absent.
 */
function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string").join(" ");
  }
  return "";
}

/**
 * Internet Archive catalog search (ADR-0049, layer 4 vertical) — the same
 * `advancedsearch.php` endpoint the Wayback tooling uses, keyless and
 * live-verified in the research doc. It answers with the archive.org
 * metadata model, where a scalar field like `title` or `description` can
 * arrive wrapped in a one-element array, so text fields are array-joined
 * before slicing.
 */
export function createInternetArchiveProvider(): SearchProvider {
  return {
    name: "internet-archive",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const response = await io.fetch(
        `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}` +
          `&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&rows=${MAX_RESULTS}&output=json`,
        { timeoutMs: io.timeoutMs },
      );
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `Internet Archive search failed: advancedsearch.php answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `Internet Archive search failed: advancedsearch.php answered ${String(response.status)}.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError(
          "error",
          "Internet Archive search failed: the response was not the documented search format.",
        );
      }
      const docs = (parsed as { response?: { docs?: unknown } } | null)?.response?.docs;
      if (!Array.isArray(docs)) {
        throw new ProviderRefusedError(
          "error",
          "Internet Archive search failed: the response had no document list.",
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
        // A result without a usable URL is dropped, never invented.
        if (typeof identifier !== "string" || identifier === "") continue;
        results.push({
          title: fieldText(title).trim().slice(0, 200),
          url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
          snippet: fieldText(description).trim().slice(0, 400),
        });
      }
      return results;
    },
  };
}
