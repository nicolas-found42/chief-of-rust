import { retryAfterMilliseconds } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
/**
 * GDELT DOC 2.0 artlist (ADR-0049, layers 2–3) — the strongest keyless
 * co-mention surface found in the research doc: global news across 100k+
 * outlets over a 3-month rolling window, with quoted-phrase and domain:
 * operators. Two documented quirks shape this provider: probes answered in
 * 15–75 s, so every call overrides the composite's deadline with the 90 s
 * budget pinned by the contract; and ~1 req/5 s is the observed pace,
 * honored by refusing fast and letting the composite's cooldown pace later
 * queries — no sleeps or retries live here.
 */
export function createGdeltProvider(): SearchProvider {
  return {
    name: "gdelt",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      // The caller's query rides verbatim — quoting multi-word phrases is the
      // caller's call, exactly as the research doc's examples do.
      const response = await io.fetch(
        `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=25`,
        { timeoutMs: 90_000 },
      );
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `GDELT is rate-limited: the DOC API answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `GDELT search failed: the DOC API answered ${String(response.status)}.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        // GDELT answers 200 with a plain-text error message on bad input, so a
        // body that is not the documented JSON is a failed query — refusing
        // here is what keeps it from reading as "no coverage found".
        throw new ProviderRefusedError(
          "error",
          "GDELT search failed: the response was not the documented article list.",
        );
      }
      const articles = (parsed as { articles?: unknown } | null)?.articles;
      if (!Array.isArray(articles)) {
        throw new ProviderRefusedError(
          "error",
          "GDELT search failed: the response had no article list.",
        );
      }
      const results: PublicSearchResult[] = [];
      for (const article of articles.slice(0, MAX_RESULTS)) {
        if (typeof article !== "object" || article === null) continue;
        const { url, title } = article as { url?: unknown; title?: unknown };
        // A result without a usable URL is dropped, never invented.
        let resolved: URL;
        try {
          resolved = new URL(asText(url));
        } catch {
          continue;
        }
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
        // The artlist schema carries no snippet field, so the empty snippet is
        // the documented shape, not a parse failure.
        results.push({
          title: asText(title).trim().slice(0, 200),
          url: resolved.toString(),
          snippet: "",
        });
      }
      return results;
    },
  };
}
