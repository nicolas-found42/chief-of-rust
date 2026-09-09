import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RedditSourceAdapter } from "../../../apps/server/src/source-adapters/reddit";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";
import type { SourceTarget } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const SINCE = "2026-08-18T12:00:00.000Z";
const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "fixtures", "content-scout", name), "utf8");

const target = (url: string): SourceTarget => ({
  id: "target-reddit",
  adapterId: "reddit",
  label: "reddit",
  url,
  state: "active",
  createdAt: "2026-08-20T12:00:00.000Z",
  archivedAt: null,
  checkpoint: null,
  lastSuccessfulAt: null,
  conditional: null,
});

const baseResponse = (overrides: Partial<PublicHttpResponse> = {}): PublicHttpResponse => ({
  url: "https://www.reddit.com/r/publiccommunity/",
  status: 200,
  contentType: "application/atom+xml; charset=UTF-8",
  etag: null,
  lastModified: null,
  retryAfter: null,
  body: "",
  ...overrides,
});

const rssResponse = (
  body: string,
  overrides: Partial<PublicHttpResponse> = {},
): PublicHttpResponse =>
  baseResponse({
    url: "https://www.reddit.com/r/publiccommunity.rss",
    contentType: "application/atom+xml; charset=UTF-8",
    body,
    ...overrides,
  });

const jsonResponse = (
  body: string,
  overrides: Partial<PublicHttpResponse> = {},
): PublicHttpResponse =>
  baseResponse({
    url: "https://www.reddit.com/r/publiccommunity.json?limit=25",
    contentType: "application/json",
    body,
    ...overrides,
  });

const pageResponse = (
  body: string,
  overrides: Partial<PublicHttpResponse> = {},
): PublicHttpResponse =>
  baseResponse({
    url: "https://www.reddit.com/r/publiccommunity/",
    contentType: "text/html; charset=UTF-8",
    body,
    ...overrides,
  });

const abortError = (): Error & { name: string } => {
  const error = new Error("The operation was aborted due to timeout") as Error & { name: string };
  error.name = "AbortError";
  return error;
};

const collect = (
  adapter: RedditSourceAdapter,
  url: string,
  checkpoint: string | null = null,
  conditional: { etag: string | null; lastModified: string | null } | null = null,
) =>
  adapter.collect({
    target: target(url),
    since: SINCE,
    until: NOW.toISOString(),
    checkpoint,
    conditional,
  });

describe("Reddit Source Adapter fixture contract", () => {
  it("uses public RSS first and stays Experimental", async () => {
    const fetched: string[] = [];
    const adapter = new RedditSourceAdapter(
      async (url) => {
        fetched.push(url);
        return rssResponse(fixture("reddit-rss.xml"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(adapter.state).toBe("experimental");
    expect(fetched).toEqual(["https://www.reddit.com/r/publiccommunity.rss"]);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "t3_1a2b3c",
          adapterId: "reddit",
          author: "PublicAuthor",
          title: "A verified public community change",
          body: "The change and its practical consequences.",
          publishedAt: "2026-08-24T14:00:00.000Z",
          canonicalUrl:
            "https://www.reddit.com/r/publiccommunity/comments/1a2b3c/a_verified_public_community_change/",
          completeness: {
            title: "available",
            body: "available",
            description: "available",
            transcript: "unsupported",
            comments: "unsupported",
          },
        },
      ],
    });
  });

  it("keeps an empty RSS feed a legitimate empty without falling back", async () => {
    const fetched: string[] = [];
    const adapter = new RedditSourceAdapter(
      async (url) => {
        fetched.push(url);
        return rssResponse(fixture("reddit-rss-empty.xml"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(fetched).toEqual(["https://www.reddit.com/r/publiccommunity.rss"]);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "legitimate_empty",
      items: [],
    });
  });

  it("honors a 304 from RSS as no new material without falling back", async () => {
    const fetched: string[] = [];
    const adapter = new RedditSourceAdapter(
      async (url) => {
        fetched.push(url);
        return rssResponse(fixture("reddit-rss.xml"), { url, status: 304 });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/", "feed-v1", {
      etag: '"feed-v1"',
      lastModified: null,
    });

    expect(fetched).toEqual(["https://www.reddit.com/r/publiccommunity.rss"]);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "no_new_material",
      items: [],
      checkpoint: "feed-v1",
    });
  });

  it("falls back to public JSON when RSS is unavailable", async () => {
    const fetched: string[] = [];
    const adapter = new RedditSourceAdapter(
      async (url) => {
        fetched.push(url);
        if (url.endsWith(".rss")) throw abortError();
        return jsonResponse(fixture("reddit-listing.json"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(fetched).toEqual([
      "https://www.reddit.com/r/publiccommunity.rss",
      "https://www.reddit.com/r/publiccommunity.json?limit=25",
    ]);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "t3_1a2b3c",
          adapterId: "reddit",
          author: "PublicAuthor",
          title: "A verified public community change",
          body: "The change and its practical consequences.",
          publishedAt: "2026-08-24T14:00:00.000Z",
          canonicalUrl:
            "https://www.reddit.com/r/publiccommunity/comments/1a2b3c/a_verified_public_community_change/",
          completeness: {
            title: "available",
            body: "available",
            description: "unavailable",
            transcript: "unsupported",
            comments: "unsupported",
          },
        },
      ],
    });
  });

  it("falls back to public JSON when RSS is blocked", async () => {
    const fetched: string[] = [];
    const adapter = new RedditSourceAdapter(
      async (url) => {
        fetched.push(url);
        if (url.endsWith(".rss")) return rssResponse("Forbidden", { url, status: 403 });
        return jsonResponse(fixture("reddit-listing.json"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(fetched).toEqual([
      "https://www.reddit.com/r/publiccommunity.rss",
      "https://www.reddit.com/r/publiccommunity.json?limit=25",
    ]);
    expect(result).toMatchObject({ kind: "completed", outcome: "items_found" });
  });

  it("falls back to JSON when RSS is no longer XML", async () => {
    const fetched: string[] = [];
    const adapter = new RedditSourceAdapter(
      async (url) => {
        fetched.push(url);
        if (url.endsWith(".rss")) return rssResponse(fixture("rss-malformed.xml"), { url });
        return jsonResponse(fixture("reddit-listing.json"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(fetched).toEqual([
      "https://www.reddit.com/r/publiccommunity.rss",
      "https://www.reddit.com/r/publiccommunity.json?limit=25",
    ]);
    expect(result).toMatchObject({ kind: "completed", outcome: "items_found" });
  });

  it("recovers canonical identity, author and time from JSON when RSS entries are incomplete", async () => {
    const fetched: string[] = [];
    const adapter = new RedditSourceAdapter(
      async (url) => {
        fetched.push(url);
        if (url.endsWith(".rss")) return rssResponse(fixture("reddit-rss-incomplete.xml"), { url });
        return jsonResponse(fixture("reddit-listing.json"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(fetched).toEqual([
      "https://www.reddit.com/r/publiccommunity.rss",
      "https://www.reddit.com/r/publiccommunity.json?limit=25",
    ]);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "t3_1a2b3c",
          author: "PublicAuthor",
          title: "A verified public community change",
          body: "The change and its practical consequences.",
          publishedAt: "2026-08-24T14:00:00.000Z",
        },
      ],
    });
  });

  it("distinguishes no new material from legitimate empty on the JSON route", async () => {
    const fresh = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) return rssResponse("Forbidden", { url, status: 403 });
        return jsonResponse(fixture("reddit-listing-empty.json"), { url });
      },
      () => NOW,
    );
    const empty = await collect(fresh, "https://www.reddit.com/r/publiccommunity/");
    expect(empty).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });

    const hash = fixture("reddit-listing-empty.json");
    const repeated = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) return rssResponse("Forbidden", { url, status: 403 });
        return jsonResponse(fixture("reddit-listing-empty.json"), { url });
      },
      () => NOW,
    );
    const unchanged = await collect(repeated, "https://www.reddit.com/r/publiccommunity/", hash);
    expect(unchanged).toMatchObject({
      kind: "completed",
      outcome: "no_new_material",
      items: [],
    });
  });

  it("falls back to public HTML when JSON is blocked", async () => {
    const fetched: string[] = [];
    const adapter = new RedditSourceAdapter(
      async (url) => {
        fetched.push(url);
        if (url.endsWith(".rss")) throw abortError();
        if (url.endsWith(".json")) return jsonResponse("Forbidden", { url, status: 403 });
        return pageResponse(fixture("reddit-page.html"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(fetched).toEqual([
      "https://www.reddit.com/r/publiccommunity.rss",
      "https://www.reddit.com/r/publiccommunity.json?limit=25",
      "https://www.reddit.com/r/publiccommunity/",
    ]);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "t3_1a2b3c",
          adapterId: "reddit",
          author: "PublicAuthor",
          title: "A verified public community change",
          body: "The change and its practical consequences.",
          publishedAt: "2026-08-24T14:00:00.000Z",
          canonicalUrl:
            "https://www.reddit.com/r/publiccommunity/comments/1a2b3c/a_verified_public_community_change/",
          completeness: {
            title: "available",
            body: "available",
            transcript: "unsupported",
            comments: "unsupported",
          },
        },
      ],
    });
  });

  it("classifies a missing shreddit framework as a response shape change", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) throw abortError();
        if (url.endsWith(".json")) return jsonResponse("Forbidden", { url, status: 403 });
        return pageResponse(fixture("reddit-page-shape-change.html"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(result).toMatchObject({
      kind: "failed",
      outcome: "response_shape_change",
      items: [],
      checkpoint: null,
      diagnostic: { parserStage: "reddit_html_parse", affectedCapabilities: ["items"] },
    });
    expect(result.diagnosticBody).toBeDefined();
  });

  it("keeps an empty public page a legitimate empty", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) throw abortError();
        if (url.endsWith(".json")) return jsonResponse("Forbidden", { url, status: 403 });
        return pageResponse(fixture("reddit-page-empty.html"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(result).toMatchObject({
      kind: "completed",
      outcome: "legitimate_empty",
      items: [],
    });
  });

  it("never collapses a malformed fallback into empty success", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) return rssResponse("Forbidden", { url, status: 403 });
        if (url.endsWith(".json"))
          return jsonResponse(fixture("reddit-listing-shape-change.json"), { url });
        return pageResponse(fixture("reddit-page-shape-change.html"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(result).toMatchObject({
      kind: "failed",
      outcome: "response_shape_change",
      items: [],
      checkpoint: null,
      diagnostic: { parserStage: "reddit_html_parse", affectedCapabilities: ["items"] },
    });
    expect(result.diagnostic.causeChain).toHaveLength(3);
    expect(result.diagnosticBody).toBeDefined();
  });

  it("completes from a later route only with the earlier failures attached", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) return rssResponse("Forbidden", { url, status: 403 });
        if (url.endsWith(".json"))
          return jsonResponse(fixture("reddit-listing-shape-change.json"), { url });
        return pageResponse(fixture("reddit-page.html"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "t3_1a2b3c",
          adapterId: "reddit",
          author: "PublicAuthor",
        },
      ],
    });
    expect(result.diagnostic.causeChain).toHaveLength(2);
  });

  it("classifies blocked access when every public route is inaccessible", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) return rssResponse("Forbidden", { url, status: 403 });
        if (url.endsWith(".json")) return jsonResponse("Forbidden", { url, status: 403 });
        return pageResponse("Forbidden", { url, status: 403 });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(result).toMatchObject({
      kind: "failed",
      outcome: "blocked_access",
      items: [],
      checkpoint: null,
    });
    expect(result.diagnostic.causeChain).toHaveLength(3);
  });

  it("stops at the first rate limit instead of hammering the remaining routes", async () => {
    let calls = 0;
    const adapter = new RedditSourceAdapter(
      async (url) => {
        calls += 1;
        if (url.endsWith(".rss"))
          return rssResponse("Slow down", { url, status: 429, retryAfter: "30" });
        throw new Error("must not be fetched after a rate limit");
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "rate_limit",
      items: [],
      checkpoint: null,
      diagnostic: { retryAfterMs: 30_000 },
    });
  });

  it("classifies a full-route timeout as a timeout with the fallback chain attached", async () => {
    const adapter = new RedditSourceAdapter(
      async () => {
        throw abortError();
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(result).toMatchObject({
      kind: "failed",
      outcome: "timeout",
      items: [],
      diagnostic: { parserStage: "fetch" },
    });
    expect(result.diagnostic.causeChain).toHaveLength(3);
  });

  it("reports the terminal fallback failure when routes fail differently", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) throw abortError();
        if (url.endsWith(".json")) return jsonResponse("Forbidden", { url, status: 403 });
        return pageResponse(fixture("reddit-page-shape-change.html"), { url });
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://www.reddit.com/r/publiccommunity/");

    expect(result).toMatchObject({
      kind: "failed",
      outcome: "response_shape_change",
      diagnostic: { parserStage: "reddit_html_parse" },
    });
    expect(result.diagnostic.causeChain).toHaveLength(3);
  });

  it("fails as unsupported for a target that is not a public reddit.com URL", async () => {
    const adapter = new RedditSourceAdapter(
      async () => {
        throw new Error("must not be fetched");
      },
      () => NOW,
    );
    const result = await collect(adapter, "https://example.com/not-reddit");

    expect(result).toMatchObject({
      kind: "failed",
      outcome: "unsupported_capability",
      items: [],
      checkpoint: null,
    });
  });
});
