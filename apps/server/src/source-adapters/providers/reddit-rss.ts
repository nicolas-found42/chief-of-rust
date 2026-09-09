import Parser from "rss-parser";
import { retryAfterMilliseconds } from "../http.js";
import type { PublicHttpFetch } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError } from "./types.js";
import type { SearchProvider, SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;
const TITLE_LIMIT = 200;
const SNIPPET_LIMIT = 400;

function feedItems(value: unknown): unknown[] | null {
  if (typeof value !== "object" || value === null || !("items" in value)) return null;
  const items: unknown = value.items;
  return Array.isArray(items) ? items : null;
}

function isFeedEntry(
  value: unknown,
): value is { title: unknown; link: unknown; contentSnippet: unknown } {
  return typeof value === "object" && value !== null && "link" in value;
}

/**
 * Reddit's public search RSS (ADR-0049, layers 2–3) — still-live Atom with a
 * ~2–3 req/min observed budget per IP. The pace is honored by refusing fast
 * (Reddit answers its wall with 403 as often as 429, both carrying
 * Retry-After) so the composite's cooldown paces later queries; no sleeps or
 * retries live here.
 */
export function createRedditRssProvider(options: { fetch?: PublicHttpFetch } = {}): SearchProvider {
  const parser = new Parser();
  return {
    name: "reddit-rss",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const fetch = options.fetch ?? io.fetch;
      const response = await fetch(
        `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new`,
        { timeoutMs: io.timeoutMs },
      );

      if (response.status !== 200) {
        if (response.status === 403 || response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `reddit-rss is rate-limited: search.rss answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `reddit-rss search failed: search.rss answered ${String(response.status)}.`,
        );
      }

      let feed: unknown;
      try {
        feed = await parser.parseString(response.body);
      } catch {
        // A 200 anti-bot page is not XML — refusing keeps it from reading
        // as a clean empty pass.
        throw new ProviderRefusedError(
          "error",
          "reddit-rss search failed: the response was not a parsable Atom feed.",
        );
      }

      const items = feedItems(feed);
      if (items === null) {
        throw new ProviderRefusedError(
          "error",
          "reddit-rss search failed: the feed had no entry list.",
        );
      }

      const results: PublicSearchResult[] = [];
      for (const entry of items) {
        if (results.length >= MAX_RESULTS) break;
        if (!isFeedEntry(entry)) continue;
        // Atom entries carry their target in <link href>; an entry without a
        // usable link is dropped, never invented.
        if (typeof entry.link !== "string") continue;
        let resolved: URL;
        try {
          resolved = new URL(entry.link);
        } catch {
          continue;
        }
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
        results.push({
          title: (typeof entry.title === "string" ? entry.title : "").trim().slice(0, TITLE_LIMIT),
          url: resolved.toString(),
          // rss-parser strips the HTML out of <content> into contentSnippet;
          // an entry without one answers an empty snippet.
          snippet: (typeof entry.contentSnippet === "string" ? entry.contentSnippet : "")
            .trim()
            .slice(0, SNIPPET_LIMIT),
        });
      }
      return results;
    },
  };
}
