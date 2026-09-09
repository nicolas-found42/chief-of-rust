import Parser from "rss-parser";
import { retryAfterMilliseconds } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Google News RSS (ADR-0049, layers 2–3) — the undocumented but
 * live-verified Atom route on news.google.com: freshest co-mention signals
 * with zero setup. The feed carries an embedded "personal, non-commercial
 * feed rendering" restriction; that is a product-policy caveat the research
 * doc flags rather than hides, not something this provider can decide. Its
 * links are redirect-wrapped through news.google.com and are kept as-is —
 * the reader follows them like any person opening the feed would.
 */
export function createGoogleNewsProvider(): SearchProvider {
  const parser = new Parser();
  return {
    name: "google-news",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const response = await io.fetch(
        `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
        { timeoutMs: io.timeoutMs },
      );
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `Google News is rate-limited: the RSS route answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `Google News search failed: the RSS route answered ${String(response.status)}.`,
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
          "Google News search failed: the response was not a parsable Atom feed.",
        );
      }
      const entries = (feed as { items?: unknown } | null)?.items;
      if (!Array.isArray(entries)) {
        throw new ProviderRefusedError(
          "error",
          "Google News search failed: the feed had no entry list.",
        );
      }
      const results: PublicSearchResult[] = [];
      for (const entry of (entries as unknown[]).slice(0, MAX_RESULTS)) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        // Atom entries carry a <link href>; the <id> is the fallback and is
        // itself a news.google.com article URL on this feed. Redirect-wrapped
        // links are kept as-is — no unwrapping.
        const href = asText(record.link) || asText(record.id);
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
          snippet: asText(record.contentSnippet).trim().slice(0, 400),
        });
      }
      return results;
    },
  };
}
