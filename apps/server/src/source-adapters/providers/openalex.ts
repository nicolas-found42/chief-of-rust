import { retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
// The polite pool is OpenAlex's whole access model: a mailto param buys 10 req/s
// and 100k/day without an account (research doc, Layer 3).
const ENDPOINT = "https://api.openalex.org/authors";
const MAILTO = "owner@found42.local";

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

export function createOpenAlexProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  return {
    name: "openalex",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const fetch = options.fetch ?? io.fetch;
      const url = `${ENDPOINT}?search=${encodeURIComponent(query)}&per-page=${MAX_RESULTS}&mailto=${MAILTO}`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });
      if (response.status !== 200) {
        const rateLimited = response.status === 429 || response.status === 503;
        throw new ProviderRefusedError(
          rateLimited ? "rate-limited" : "error",
          `OpenAlex answered ${String(response.status)}.`,
          rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "OpenAlex returned a malformed body.");
      }
      const body = asRecord(parsed);
      if (!body || !Array.isArray(body.results)) {
        throw new ProviderRefusedError("error", "OpenAlex returned an unexpected body shape.");
      }
      const results: PublicSearchResult[] = [];
      for (const entry of body.results.slice(0, MAX_RESULTS)) {
        const record = asRecord(entry);
        if (!record) continue;
        // The `id` field is the canonical author URL (https://openalex.org/A…).
        const url = usableUrl(record.id);
        if (!url) continue;
        results.push({ title: clippedText(record.display_name, 200), url, snippet: "" });
      }
      return results;
    },
  };
}
