import { describe, expect, it } from "vitest";
import {
  createPublicSearch,
  PublicSearchUnavailableError,
  type PublicSearchDiagnosticEvent,
} from "../../../apps/server/src/source-adapters/search";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";

/**
 * Hermetic composite tests for the multi-provider PublicSearch fan-out
 * (ADR-0049). The fake transport dispatches on URL: every provider's real
 * endpoint host gets an empty-but-parseable 200 body by default, and each
 * test layers routes on top for the behavior under test. Nothing here
 * touches the network.
 */

type FakeRoute = {
  match: (url: string) => boolean;
  status?: number;
  body: string;
  retryAfter?: string;
  reject?: string;
};

const CHALLENGE = "<html><body>Please complete the following challenge</body></html>";

/** A 200 body every RSS provider parses to a feed whose one item has no link. */
const EMPTY_RSS =
  '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item></item></channel></rss>';

/** One empty-but-parseable 200 body per provider endpoint host in the bundle. */
const EMPTY_BODIES: Record<string, string> = {
  "api.crossref.org": '{"message":{"items":[]}}',
  "api.datacite.org": '{"data":[]}',
  "openlibrary.org": '{"docs":[]}',
  "npiregistry.cms.hhs.gov": '{"results":[]}',
  "clinicaltrials.gov": '{"studies":[]}',
  "projects.propublica.org": '{"organizations":[]}',
  "api.tvmaze.com": "[]",
  "www.loc.gov": '{"results":[]}',
  "api.artic.edu": '{"data":[]}',
  "api.mwmbl.org": "[]",
  "sepiasearch.org": '{"data":[]}',
  "itunes.apple.com": '{"results":[]}',
  "public.api.bsky.app": '{"actors":[]}',

  "html.duckduckgo.com": "<html><body></body></html>",
  "www.mojeek.com": '<html><body><ul class="results"></ul></body></html>',
  "api2.marginalia-search.com": "[]",
  "en.wikipedia.org": '["",[],[],[]]',
  "www.wikidata.org": '{"search":[]}',
  "www.bing.com": EMPTY_RSS,
  "news.google.com": EMPTY_RSS,
  "api.gdeltproject.org": '{"articles":[]}',
  "api.stackexchange.com": '{"items":[]}',
  "www.reddit.com": EMPTY_RSS,
  "api.openverse.org": '{"results":[]}',
  "www.ebi.ac.uk": '{"resultList":{"result":[]}}',
  "archive.org": '{"response":{"docs":[]}}',
  "wiby.me": "[]",
  "api.openalex.org": '{"results":[]}',
  "pub.orcid.org": '{"expanded-result":[]}',
  "api.github.com": '{"items":[]}',
  "dblp.org": '{"result":{}}',
  "api.ror.org": '{"items":[]}',
  "api.gleif.org": '{"data":[]}',
  "efts.sec.gov": '{"hits":{"hits":[]}}',
};

function hostOf(url: string): string {
  return new URL(url).host;
}

function queryParam(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

/** The three suggest endpoints the second-chance expansion asks. */
const isSuggestUrl = (url: string): boolean =>
  url.startsWith("https://suggestqueries.google.com/") ||
  url.startsWith("https://duckduckgo.com/ac/") ||
  url.startsWith("https://api.bing.com/osjson.aspx");

function respond(
  url: string,
  status: number,
  body: string,
  retryAfter?: string,
): PublicHttpResponse {
  return {
    url,
    status,
    contentType: "text/html",
    etag: null,
    lastModified: null,
    retryAfter: retryAfter ?? null,
    body,
  };
}

function makeFetch(routes: FakeRoute[] = []): {
  fetch: PublicHttpFetch;
  calls: string[];
  bodies: string[];
} {
  const calls: string[] = [];
  const bodies: string[] = [];
  const fetch: PublicHttpFetch = async (url, perCall = {}) => {
    calls.push(url);
    bodies.push(perCall.body ?? "");
    const route = routes.find((candidate) => candidate.match(url));
    if (route === undefined) {
      return respond(url, 200, EMPTY_BODIES[hostOf(url)] ?? "");
    }
    if (route.reject !== undefined) throw new Error(route.reject);
    return respond(url, route.status ?? 200, route.body, route.retryAfter);
  };
  return { fetch, calls, bodies };
}

function captureDiagnostics(): {
  events: PublicSearchDiagnosticEvent[];
  diagnostics: (event: PublicSearchDiagnosticEvent) => void;
} {
  const events: PublicSearchDiagnosticEvent[] = [];
  return {
    events,
    diagnostics: (event) => {
      events.push(event);
    },
  };
}

function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function ddgHtml(results: Array<{ title: string; url: string; snippet?: string }>): string {
  return results
    .map(
      (result) =>
        `<div class="result"><a class="result__a" href="${result.url}">${result.title}</a>` +
        `<span class="result__snippet">${result.snippet ?? ""}</span></div>`,
    )
    .join("");
}

/** The MediaWiki opensearch positional array: [query, titles, snippets, urls]. */
function wikiBody(results: Array<{ title: string; snippet: string; url: string }>): string {
  return JSON.stringify([
    "",
    results.map((result) => result.title),
    results.map((result) => result.snippet),
    results.map((result) => result.url),
  ]);
}

function rssBody(items: Array<{ title: string; link: string; snippet?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link>` +
        `<description>${item.snippet ?? ""}</description></item>`,
    )
    .join("")}</channel></rss>`;
}

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

describe("the PublicSearch composite", () => {
  it("refuses with PublicSearchUnavailableError when every provider refuses", async () => {
    const { fetch } = makeFetch([
      { match: (url) => hostOf(url) === "html.duckduckgo.com", status: 202, body: CHALLENGE },
      { match: () => true, status: 500, body: "server error" },
    ]);
    const search = createPublicSearch(fetch);

    await expect(search("ada lovelace")).rejects.toThrow(PublicSearchUnavailableError);
    await expect(search("ada lovelace")).rejects.toThrow(/all \d+ providers refused/);
  });

  it("narrows to the providers that answered when one refuses", async () => {
    const { fetch } = makeFetch([
      { match: (url) => hostOf(url) === "html.duckduckgo.com", status: 500, body: "boom" },
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody([
          {
            title: "Ada Lovelace",
            snippet: "English mathematician",
            url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
          },
        ]),
      },
    ]);
    const search = createPublicSearch(fetch);

    await expect(search("ada lovelace")).resolves.toMatchObject([
      {
        title: "Ada Lovelace",
        url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
        snippet: "English mathematician",
      },
    ]);
  });

  it("expands a cleanly empty pass through the suggest endpoints", async () => {
    const { fetch, calls, bodies } = makeFetch([
      {
        match: isSuggestUrl,
        body: JSON.stringify([
          "ada lovelace",
          ["ada lovelace biography", "ada lovelace achievements"],
        ]),
      },
      {
        match: (url) =>
          hostOf(url) === "en.wikipedia.org" &&
          queryParam(url, "search") === "ada lovelace biography",
        body: wikiBody([
          {
            title: "Ada Lovelace biography",
            snippet: "A biography",
            url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
          },
        ]),
      },
      {
        match: (url) =>
          hostOf(url) === "en.wikipedia.org" &&
          queryParam(url, "search") === "ada lovelace achievements",
        body: wikiBody([
          {
            title: "Ada Lovelace achievements",
            snippet: "Some achievements",
            url: "https://en.wikipedia.org/wiki/Ada_Lovelace_achievements",
          },
        ]),
      },
    ]);
    const { events, diagnostics } = captureDiagnostics();
    const search = createPublicSearch(fetch, undefined, { diagnostics });

    await expect(search("ada lovelace")).resolves.toMatchObject([
      {
        title: "Ada Lovelace biography",
        url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
        snippet: "A biography",
      },
      {
        title: "Ada Lovelace achievements",
        url: "https://en.wikipedia.org/wiki/Ada_Lovelace_achievements",
        snippet: "Some achievements",
      },
    ]);

    // All three suggest endpoints were asked, and the provider bundle ran
    // again per variant — the variant queries ride the real endpoints.
    expect(calls.filter((url) => isSuggestUrl(url))).toHaveLength(3);
    // The variant query rides the DuckDuckGo POST body, not the URL.
    expect(calls.some((url) => url === "https://html.duckduckgo.com/html/")).toBe(true);
    expect(bodies.some((body) => body.includes("q=ada+lovelace+biography"))).toBe(true);
    expect(
      events.some(
        (event) =>
          event.provider === "wikipedia" && event.outcome === "expanded" && event.results === 1,
      ),
    ).toBe(true);
  });

  it("never expands when the first pass found results", async () => {
    const { fetch, calls } = makeFetch([
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody([
          {
            title: "Ada Lovelace",
            snippet: "English mathematician",
            url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
          },
        ]),
      },
    ]);
    const search = createPublicSearch(fetch);

    await expect(search("ada lovelace")).resolves.toMatchObject([
      {
        title: "Ada Lovelace",
        url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
        snippet: "English mathematician",
      },
    ]);
    expect(calls.some((url) => isSuggestUrl(url))).toBe(false);
  });

  it("swallows suggest-endpoint failures instead of failing the query", async () => {
    const { fetch, calls } = makeFetch([
      { match: isSuggestUrl, body: "", reject: "suggest endpoint down" },
    ]);
    const search = createPublicSearch(fetch);

    await expect(search("ada lovelace")).resolves.toMatchObject([]);
    expect(calls.filter((url) => isSuggestUrl(url))).toHaveLength(3);
    expect(calls.some((url) => url.includes("ada%20lovelace%20biography"))).toBe(false);
  });

  it("serves a repeat query from the TTL cache without refetching", async () => {
    const { fetch, calls } = makeFetch([
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody([
          {
            title: "Grace Hopper",
            snippet: "Naval officer and pioneer",
            url: "https://en.wikipedia.org/wiki/Grace_Hopper",
          },
        ]),
      },
    ]);
    const { events, diagnostics } = captureDiagnostics();
    const { now, advance } = clock();
    const search = createPublicSearch(fetch, undefined, { diagnostics, now });

    const first = await search("grace hopper");
    const afterFirst = calls.length;
    advance(1_000);
    const second = await search("grace hopper");

    expect(second).toEqual(first);
    expect(calls.length).toBe(afterFirst);
    expect(
      events.some(
        (event) =>
          event.provider === "cache" &&
          event.outcome === "cached" &&
          event.query === "grace hopper" &&
          event.results === 1,
      ),
    ).toBe(true);

    // Past the TTL the entry is dropped and the bundle runs again.
    advance(600_001);
    await search("grace hopper");
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it("rests a rate-limited provider for its cooldown and refetches after", async () => {
    const { fetch, calls, bodies } = makeFetch([
      {
        match: (url) => hostOf(url) === "html.duckduckgo.com",
        status: 429,
        body: "slow down",
        retryAfter: "120",
      },
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody([
          {
            title: "Grace Hopper",
            snippet: "Naval officer and pioneer",
            url: "https://en.wikipedia.org/wiki/Grace_Hopper",
          },
        ]),
      },
    ]);
    const { events, diagnostics } = captureDiagnostics();
    const { now, advance } = clock();
    const search = createPublicSearch(fetch, undefined, { diagnostics, now });
    const ddgCalls = () => calls.filter((url) => hostOf(url) === "html.duckduckgo.com");

    await expect(search("rate one")).resolves.toHaveLength(1);
    expect(ddgCalls()).toHaveLength(1);

    // The next query inside the cooldown window skips the refused provider.
    await expect(search("rate two")).resolves.toHaveLength(1);
    expect(ddgCalls()).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.provider === "duckduckgo" &&
          event.outcome === "cooldown" &&
          event.query === "rate two" &&
          event.ms === 0,
      ),
    ).toBe(true);

    // Past max(Retry-After, 1 h) the provider is asked again.
    advance(3_600_001);
    await expect(search("rate three")).resolves.toHaveLength(1);
    expect(ddgCalls()).toHaveLength(2);
    expect(
      calls.some(
        (url, index) =>
          hostOf(url) === "html.duckduckgo.com" && bodies[index]?.includes("rate+three"),
      ),
    ).toBe(true);
  });

  it("rests a captcha'd provider for a full day", async () => {
    const { fetch, calls } = makeFetch([
      { match: (url) => hostOf(url) === "html.duckduckgo.com", status: 202, body: CHALLENGE },
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody([
          {
            title: "Grace Hopper",
            snippet: "Naval officer and pioneer",
            url: "https://en.wikipedia.org/wiki/Grace_Hopper",
          },
        ]),
      },
    ]);
    const { now, advance } = clock();
    const search = createPublicSearch(fetch, undefined, { now });
    const ddgCalls = () => calls.filter((url) => hostOf(url) === "html.duckduckgo.com");

    await expect(search("cap one")).resolves.toHaveLength(1);
    expect(ddgCalls()).toHaveLength(1);

    // One hour later the captcha cooldown still holds.
    advance(3_600_001);
    await expect(search("cap two")).resolves.toHaveLength(1);
    expect(ddgCalls()).toHaveLength(1);

    // Past 24 h it is fetched again.
    advance(86_400_000);
    await expect(search("cap three")).resolves.toHaveLength(1);
    expect(ddgCalls()).toHaveLength(2);
  });

  it("emits one pinned-shape diagnostic event per provider per pass", async () => {
    const { fetch } = makeFetch([
      { match: (url) => hostOf(url) === "html.duckduckgo.com", status: 500, body: "nope" },
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody([
          {
            title: "Ada Lovelace",
            snippet: "English mathematician",
            url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
          },
        ]),
      },
    ]);
    const { events, diagnostics } = captureDiagnostics();
    const search = createPublicSearch(fetch, undefined, { diagnostics });

    await search("diagnostics");

    const allowedKeys = ["provider", "query", "outcome", "results", "ms", "detail"];
    const allowedOutcomes = ["ok", "empty", "refused", "cooldown", "cached", "expanded"];
    for (const event of events) {
      expect(Object.keys(event).every((key) => allowedKeys.includes(key))).toBe(true);
      expect(allowedOutcomes).toContain(event.outcome);
      expect(typeof event.provider).toBe("string");
      expect(event.query).toBe("diagnostics");
      expect(typeof event.results).toBe("number");
      expect(typeof event.ms).toBe("number");
    }
    // The default bundle registers 37 providers; each emits exactly one event.
    expect(events).toHaveLength(37);
    expect(new Set(events.map((event) => event.provider)).size).toBe(37);
    expect(
      events.some(
        (event) => event.provider === "wikipedia" && event.outcome === "ok" && event.results === 1,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.provider === "duckduckgo" &&
          event.outcome === "refused" &&
          typeof event.detail === "string" &&
          event.detail.includes("500"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.provider === "gdelt" && event.outcome === "empty")).toBe(
      true,
    );
  });

  it("interleaves providers and dedupes by exact URL keeping the first copy", async () => {
    const sharedUrl = "https://example.com/ddg-first";
    const { fetch } = makeFetch([
      {
        match: (url) => hostOf(url) === "html.duckduckgo.com",
        body: ddgHtml([{ title: "From ddg", url: sharedUrl, snippet: "ddg snippet" }]),
      },
      {
        match: (url) => hostOf(url) === "api2.marginalia-search.com",
        body: JSON.stringify([
          { url: sharedUrl, title: "Marginalia duplicate", description: "" },
          {
            url: "https://example.com/marginalia",
            title: "From marginalia",
            description: "marginalia snippet",
          },
        ]),
      },
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody([
          { title: "Merge page", snippet: "", url: "https://en.wikipedia.org/wiki/Merge" },
        ]),
      },
      {
        match: (url) => hostOf(url) === "www.bing.com",
        body: rssBody([
          { title: "Bing item", link: "https://example.com/bing", snippet: "bing snippet" },
          { title: "Bing duplicate", link: sharedUrl },
        ]),
      },
      {
        match: (url) => hostOf(url) === "api.gdeltproject.org",
        body: JSON.stringify({
          articles: [{ url: "https://example.com/gdelt", title: "Gdelt item" }],
        }),
      },
    ]);
    const search = createPublicSearch(fetch);

    // Registration order is duckduckgo → marginalia → wikipedia → bing-news →
    // gdelt; both later duplicates of the ddg URL lose to the first copy.
    await expect(search("merge")).resolves.toMatchObject([
      { title: "From ddg", url: sharedUrl, snippet: "ddg snippet" },
      { title: "Merge page", url: "https://en.wikipedia.org/wiki/Merge", snippet: "" },
      { title: "Bing item", url: "https://example.com/bing", snippet: "bing snippet" },
      { title: "Gdelt item", url: "https://example.com/gdelt", snippet: "" },
      {
        title: "From marginalia",
        url: "https://example.com/marginalia",
        snippet: "marginalia snippet",
      },
    ]);
  });

  it("retains all 32 results beyond the former 24-result cap", async () => {
    const { fetch } = makeFetch([
      {
        match: (url) => hostOf(url) === "html.duckduckgo.com",
        body: ddgHtml(
          range(8).map((index) => ({
            title: `Ddg ${String(index)}`,
            url: `https://example.com/ddg-${String(index)}`,
          })),
        ),
      },
      {
        match: (url) => hostOf(url) === "api2.marginalia-search.com",
        body: JSON.stringify(
          range(8).map((index) => ({
            url: `https://example.com/marginalia-${String(index)}`,
            title: `Marginalia ${String(index)}`,
            description: "",
          })),
        ),
      },
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody(
          range(8).map((index) => ({
            title: `Wiki ${String(index)}`,
            snippet: "",
            url: `https://en.wikipedia.org/wiki/Page_${String(index)}`,
          })),
        ),
      },
      {
        match: (url) => hostOf(url) === "www.wikidata.org",
        body: JSON.stringify({
          search: range(8).map((index) => ({
            label: `Q entity ${String(index)}`,
            description: "",
            concepturi: `https://www.wikidata.org/wiki/Q${String(100 + index)}`,
          })),
        }),
      },
    ]);
    const search = createPublicSearch(fetch);

    const merged = await search("cap");
    expect(merged).toHaveLength(32);
    expect(merged.slice(0, 4).map((result) => result.url)).toEqual([
      "https://example.com/ddg-0",
      "https://example.com/marginalia-0",
      "https://en.wikipedia.org/wiki/Page_0",
      "https://www.wikidata.org/wiki/Q100",
    ]);
    expect(merged).toContainEqual(
      expect.objectContaining({ url: "https://www.wikidata.org/wiki/Q107" }),
    );
  });

  it("keeps createPublicSearch(injectedFetch) hermetic across the curated transports", async () => {
    const { fetch, calls } = makeFetch([
      {
        match: (url) => hostOf(url) === "en.wikipedia.org",
        body: wikiBody([
          {
            title: "Ada Lovelace",
            snippet: "English mathematician",
            url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
          },
        ]),
      },
    ]);
    const search = createPublicSearch(fetch);

    await expect(search("ada lovelace")).resolves.toMatchObject([
      {
        title: "Ada Lovelace",
        url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
        snippet: "English mathematician",
      },
    ]);
    // The curated transports (Marginalia's api-key, ORCID's accept header,
    // EDGAR's declared UA) rode the injected fetch too — their real endpoint
    // URLs were requested through the fake, never the network.
    expect(
      calls.some((url) => url.startsWith("https://api2.marginalia-search.com/search?query=")),
    ).toBe(true);
    expect(
      calls.some((url) => url.startsWith("https://pub.orcid.org/v3.0/expanded-search?q=")),
    ).toBe(true);
    expect(calls.some((url) => url.startsWith("https://efts.sec.gov/LATEST/search-index?q="))).toBe(
      true,
    );
  });

  it("keeps createPublicSearch(injectedFetch, customEndpoint) working", async () => {
    const { fetch, calls } = makeFetch([
      {
        match: (url) => hostOf(url) === "ddg.test",
        body: ddgHtml([
          {
            title: "From custom endpoint",
            url: "https://example.com/custom",
            snippet: "custom snippet",
          },
        ]),
      },
    ]);
    const search = createPublicSearch(
      fetch,
      (query) => `https://ddg.test/search?q=${encodeURIComponent(query)}`,
    );

    await expect(search("custom query")).resolves.toMatchObject([
      {
        title: "From custom endpoint",
        url: "https://example.com/custom",
        snippet: "custom snippet",
      },
    ]);
    expect(calls.some((url) => url.startsWith("https://ddg.test/search?q="))).toBe(true);
    expect(calls.some((url) => url.startsWith("https://html.duckduckgo.com"))).toBe(false);
  });
});
