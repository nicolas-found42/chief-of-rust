import { JSDOM } from "jsdom";
import {
  browserUserAgent,
  createHttpFetch,
  retryAfterMilliseconds,
  type PublicHttpFetch,
} from "../http.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";
import type { PublicSearchResult } from "../search.js";

const MAX_RESULTS = 8;

/** The anonymous HTML route this provider searches by default. */
const ROUTE = "https://html.duckduckgo.com/html/";

/** A DuckDuckGo HTML result link, unwrapping its `uddg` redirect parameter. */
function resolveHref(href: string, base: string): string | null {
  try {
    const parsed = new URL(href, base);
    const target = parsed.searchParams.get("uddg");
    const resolved = target ? new URL(target) : parsed;
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * The incumbent PublicSearch source (ADR-0049 demotes it to one provider among
 * many): an anonymous HTML route with no key and no login. SearXNG's engine
 * source documents the route's working shape — POST form-encoded `q` with a
 * stable browser-like UA, a referer echo, and a navigate sec-fetch-mode;
 * plain GETs with programmatic UAs are what earn the 202 challenge wall. Per
 * docs/research/anti-bot-keyless-search.md this scrape is a documented
 * single-user exception: stable headers, tiny volume, and the 202 challenge
 * classifies as a captcha refusal so the composite rests it for a day —
 * never retries or UA rotation.
 */
export function createDuckDuckGoProvider(
  options: { fetch?: PublicHttpFetch; endpoint?: (query: string) => string } = {},
): SearchProvider {
  const fetch =
    options.fetch ??
    createHttpFetch({
      headers: {
        "user-agent": browserUserAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        referer: "https://html.duckduckgo.com/",
        "sec-fetch-mode": "navigate",
      },
    });
  return {
    name: "duckduckgo",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const endpoint = options.endpoint ?? (() => ROUTE);
      const response = await fetch(endpoint(query), {
        timeoutMs: io.timeoutMs,
        method: "POST",
        // DDG caps queries at 499 characters (SearXNG's engine documents it).
        body: new URLSearchParams({ q: query.slice(0, 499) }).toString(),
      });

      /* A refused search and a search that found nothing are different facts,
         and only a failure is allowed to look like one. The route answers 200
         with results and 202 with an anti-bot challenge page, so anything but
         200 is "could not search" — reported as a refusal rather than an
         empty pass, which is what tells the composite the person's empty
         result is not evidence that they have no public footprint. */
      if (response.status !== 200) {
        if (response.status === 202)
          throw new ProviderRefusedError(
            "captcha",
            "duckduckgo is showing an anti-bot challenge page: the search route answered 202.",
          );
        if (response.status === 429 || response.status === 503)
          throw new ProviderRefusedError(
            "rate-limited",
            `duckduckgo is rate-limited: the search route answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        throw new ProviderRefusedError(
          "error",
          `duckduckgo search failed: the search route answered ${String(response.status)}.`,
        );
      }
      const document = new JSDOM(response.body, { url: response.url }).window.document;
      const results: PublicSearchResult[] = [];
      for (const anchor of [
        ...document.querySelectorAll<HTMLAnchorElement>("a.result__a[href]"),
      ].slice(0, MAX_RESULTS)) {
        const url = resolveHref(anchor.getAttribute("href") ?? "", response.url);
        if (!url) continue;
        const row = anchor.closest(".result");
        const snippet = row?.querySelector(".result__snippet")?.textContent.trim() ?? "";
        results.push({
          title: anchor.textContent.trim().slice(0, 200),
          url,
          snippet: snippet.slice(0, 400),
        });
      }
      return results;
    },
  };
}
