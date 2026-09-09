import { createHttpFetch, retryAfterMilliseconds, type PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;

function imageHits(value: unknown): unknown[] | null {
  if (typeof value !== "object" || value === null || !("results" in value)) return null;
  const results: unknown = value.results;
  return Array.isArray(results) ? results : null;
}

function isImageHit(
  value: unknown,
): value is { title: unknown; url: unknown; foreign_landing_url: unknown; description: unknown } {
  return typeof value === "object" && value !== null && "url" in value;
}

/** Openverse media results carry both the image asset route and the source
 * page; `foreign_landing_url` is the stable page on the origin site and is
 * the link worth keeping when both exist. */
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
 * Openverse (ADR-0049, layer 3) — keyless CC-media search. Anonymous access
 * is fine but bounded (~200 req/day, maintainer-issue sourced), so a 429
 * refuses as rate-limited and the composite's cooldown does the pacing.
 */
export function createOpenverseProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  // Openverse's API content-negotiates: with the default transport's
  // HTML-first accept it answers the fast browsable HTML page (200
  // text/html, live-verified 2026-09-02); JSON needs an explicit accept.
  // The header is bound at the transport, like ORCID's.
  const fetch = options.fetch ?? createHttpFetch({ headers: { accept: "application/json" } });
  return {
    name: "openverse",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      /* Openverse is slow from a residential IP — 32 s observed for one small
         page (2026-09-02) — so this call gets a longer deadline than the
         composite's 20 s default instead of aborting mid-flight. The
         `format=json` parameter matters beyond the doc'd default: Cloudflare
         caches the DRF browsable HTML page under the bare URL's key and
         serves it to every accept variant, while `format=json` selects a
         clean JSON cache key (SearXNG's engine requests the same shape;
         live-diagnosed 2026-09-02). */
      const response = await fetch(
        `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=8&format=json`,
        { timeoutMs: Math.max(io.timeoutMs, 60_000) },
      );

      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `openverse is rate-limited: /v1/images/ answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `openverse search failed: /v1/images/ answered ${String(response.status)}.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new ProviderRefusedError("error", "openverse returned an unparseable body");
      }

      const hits = imageHits(parsed);
      if (hits === null) {
        throw new ProviderRefusedError("error", "openverse returned a malformed results body");
      }

      const results: PublicSearchResult[] = [];
      for (const hit of hits) {
        if (results.length >= MAX_RESULTS) break;
        if (!isImageHit(hit)) continue;
        const url =
          absoluteHttpUrl(
            typeof hit.foreign_landing_url === "string" ? hit.foreign_landing_url : null,
          ) ?? absoluteHttpUrl(typeof hit.url === "string" ? hit.url : null);
        // A result without a usable URL is dropped, never invented.
        if (url === null) continue;
        results.push({
          title: (typeof hit.title === "string" ? hit.title : "").trim().slice(0, TITLE_LIMIT),
          url,
          snippet: (typeof hit.description === "string" ? hit.description : "")
            .trim()
            .slice(0, SNIPPET_LIMIT),
        });
      }
      return results;
    },
  };
}
