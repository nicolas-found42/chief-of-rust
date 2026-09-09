import { createHttpFetch, retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
// GLEIF canonicalizes employer legal names; api.gleif.io is dead — .org only
// (research doc, Layer 3). The search UI record URL is the durable human link;
// the API's own resource URL leaks its internal pagination shape.
const ENDPOINT = "https://api.gleif.org/api/v1/lei-records";

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

export function createGleifProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  // GLEIF answers the default transport's HTML-first accept list with an
  // HTML body that is not the JSON API — an explicit application/json accept
  // gets the documented envelope (live-verified both ways 2026-09-02). The
  // header is bound at the transport, like ORCID's.
  const fetch = options.fetch ?? createHttpFetch({ headers: { accept: "application/json" } });
  return {
    name: "gleif",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const url = `${ENDPOINT}?filter%5Bentity.legalName%5D=${encodeURIComponent(query)}&page%5Bsize%5D=${MAX_RESULTS}`;
      const response = await fetch(url, { timeoutMs: io.timeoutMs });
      if (response.status !== 200) {
        const rateLimited = response.status === 429 || response.status === 503;
        throw new ProviderRefusedError(
          rateLimited ? "rate-limited" : "error",
          `GLEIF answered ${String(response.status)}.`,
          rateLimited ? retryAfterMilliseconds(response.retryAfter, new Date()) : undefined,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "GLEIF returned a malformed body.");
      }
      const body = asRecord(parsed);
      if (!body || !Array.isArray(body.data)) {
        throw new ProviderRefusedError("error", "GLEIF returned an unexpected body shape.");
      }
      const results: PublicSearchResult[] = [];
      for (const entry of body.data.slice(0, MAX_RESULTS)) {
        const record = asRecord(entry);
        const attributes = record ? asRecord(record.attributes) : null;
        if (!attributes || typeof attributes.lei !== "string" || attributes.lei.length === 0) {
          continue;
        }
        const url = usableUrl(`https://search.gleif.org/#/record/${attributes.lei}`);
        if (!url) continue;
        const entity = asRecord(attributes.entity);
        const legalName = entity ? asRecord(entity.legalName) : null;
        results.push({
          title: clippedText(legalName?.name, 200),
          url,
          snippet: clippedText(attributes.lei, 400),
        });
      }
      return results;
    },
  };
}
