import Parser from "rss-parser";
import { retryAfterMilliseconds } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Bing News RSS (ADR-0049, layers 2–3) — the undocumented but live-verified
 * `format=RSS` route on Bing News: freshest co-mention signals with zero
 * setup. The feed carries an embedded "personal, non-commercial feed
 * rendering" restriction; that is a product-policy caveat the research doc
 * flags rather than hides, not something this provider can decide. The
 * observed pace is honored by refusing fast — the composite's cooldown paces
 * later queries, no sleeps or retries live here.
 */
export function createBingNewsProvider(): SearchProvider {
  const parser = new Parser();
  return {
    name: "bing-news",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const response = await io.fetch(
        `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=RSS`,
        { timeoutMs: io.timeoutMs },
      );
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `Bing News is rate-limited: the RSS route answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `Bing News search failed: the RSS route answered ${String(response.status)}.`,
        );
      }
      let feed: unknown;
      try {
        feed = await parser.parseString(response.body);
      } catch {
        // A 200 anti-bot challenge page is not XML — refusing keeps it from
        // reading as a clean empty pass.
        throw new ProviderRefusedError(
          "error",
          "Bing News search failed: the response was not a parsable RSS feed.",
        );
      }
      const items = (feed as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) {
        throw new ProviderRefusedError(
          "error",
          "Bing News search failed: the feed had no item list.",
        );
      }
      const results: PublicSearchResult[] = [];
      for (const item of (items as unknown[]).slice(0, MAX_RESULTS)) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        // RSS items carry a link; the guid is the documented fallback and is
        // itself the article URL on this feed.
        const href = asText(record.link) || asText(record.guid);
        let resolved: URL;
        try {
          resolved = new URL(href);
        } catch {
          continue;
        }
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
        results.push({
          title: asText(record.title).trim().slice(0, 200),
          url: resolved.toString(),
          // rss-parser strips the HTML out of <description> into
          // contentSnippet; a feed item without one answers an empty snippet.
          snippet: asText(record.contentSnippet).trim().slice(0, 400),
        });
      }
      return results;
    },
  };
}
