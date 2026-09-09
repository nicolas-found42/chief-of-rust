import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RssSourceAdapter } from "../../../apps/server/src/source-adapters/rss";
import { SubstackEnrichmentAdapter } from "../../../apps/server/src/modules/content-scout/adapters/substack";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";
import { WebsiteSourceAdapter } from "../../../apps/server/src/source-adapters/website";
import { ExperimentalPublicPageAdapter } from "../../../apps/server/src/modules/content-scout/adapters/experimental";
import { TikTokYtDlpAdapter } from "../../../apps/server/src/modules/content-scout/adapters/tiktok";
import {
  YouTubeSourceAdapter,
  type YouTubeSourceClient,
} from "../../../apps/server/src/source-adapters/youtube";
import type { SourceItem, SourceTarget } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "fixtures", "content-scout", name), "utf8");

const target = (adapterId: string, url: string): SourceTarget => ({
  id: `target-${adapterId}`,
  adapterId,
  label: adapterId,
  url,
  state: "active",
  createdAt: "2026-08-20T12:00:00.000Z",
  archivedAt: null,
  checkpoint: null,
  lastSuccessfulAt: null,
  conditional: null,
});

const response = (overrides: Partial<PublicHttpResponse> = {}): PublicHttpResponse => ({
  url: "https://example.com/feed.xml",
  status: 200,
  contentType: "application/rss+xml",
  etag: null,
  lastModified: null,
  retryAfter: null,
  body: fixture("rss-success.xml"),
  ...overrides,
});

describe("RSS Source Adapter fixture contract", () => {
  it("forwards persisted validators and returns refreshed conditional-request state", async () => {
    let options: unknown;
    const result = await new RssSourceAdapter(
      async (_url, received) => {
        options = received;
        return response({
          etag: '"feed-v2"',
          lastModified: "Tue, 25 Aug 2026 12:00:00 GMT",
        });
      },
      () => NOW,
    ).collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: "feed-v1",
      conditional: {
        etag: '"feed-v1"',
        lastModified: "Mon, 24 Aug 2026 12:00:00 GMT",
      },
    });

    expect(options).toEqual({
      etag: '"feed-v1"',
      lastModified: "Mon, 24 Aug 2026 12:00:00 GMT",
    });
    expect(result).toMatchObject({
      kind: "completed",
      conditional: {
        etag: '"feed-v2"',
        lastModified: "Tue, 25 Aug 2026 12:00:00 GMT",
      },
    });
  });

  it("normalizes successful and partial items with field-level completeness", async () => {
    const adapter = new RssSourceAdapter(
      async () => response(),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });

    expect(result.kind).toBe("completed");
    expect(result.outcome).toBe("items_found");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      externalId: "story-1",
      canonicalUrl: "https://example.com/story-1",
      completeness: { title: "available", body: "available" },
    });
    expect(result.items[1]?.completeness).toMatchObject({
      title: "unavailable",
      body: "unavailable",
    });
  });

  it.each([
    ["empty", response({ body: fixture("rss-empty.xml") }), "legitimate_empty"],
    ["blocked", response({ status: 403, body: "Forbidden" }), "blocked_access"],
    ["rate limited", response({ status: 429, body: "Slow down" }), "rate_limit"],
    [
      "response shape changed",
      response({ contentType: "text/html", body: fixture("rss-malformed.xml") }),
      "response_shape_change",
    ],
  ])("classifies %s without sharing a success shape", async (_name, raw, classification) => {
    const result = await new RssSourceAdapter(
      async () => raw,
      () => NOW,
    ).collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result.outcome).toBe(classification);
    expect(result.diagnostic.classification).toBe(classification);
    expect(result.kind).toBe(classification === "legitimate_empty" ? "completed" : "failed");
  });
});

describe("Website Source Adapter fixture contract", () => {
  it("extracts a public article through plain HTTP and Readability without a browser", async () => {
    let rendered = 0;
    const adapter = new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-article.html"),
        }),
      () => NOW,
      async () => {
        rendered += 1;
        return {
          url: "https://news.example/updates",
          contentType: "text/html",
          status: 200,
          body: "",
        };
      },
    );
    const result = await adapter.collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(rendered).toBe(0);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      diagnostic: { parserStage: "readability" },
      items: [
        {
          canonicalUrl: "https://news.example/product-update",
          title: "Public product update",
          completeness: { body: "available", comments: "unsupported" },
        },
      ],
    });
  });

  it("keeps a static parser break classified without invoking the browser", async () => {
    let rendered = 0;
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-parse-failure.html"),
        }),
      () => NOW,
      async () => {
        rendered += 1;
        return {
          url: "https://news.example/updates",
          contentType: "text/html",
          status: 200,
          body: "",
        };
      },
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(rendered).toBe(0);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "parser_failure",
      diagnostic: { parserStage: "readability" },
    });
  });

  it("renders a JavaScript-only shell through the bounded public browser fallback", async () => {
    const renderedBody = fixture("website-rendered-article.html");
    let renderedUrl = "";
    const adapter = new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => {
        renderedUrl = url;
        return {
          url: "https://news.example/product-update",
          contentType: "text/html",
          status: 200,
          body: renderedBody,
        };
      },
    );
    const request = {
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    };
    const result = await adapter.collect(request);
    expect(renderedUrl).toBe("https://news.example/updates");
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      conditional: { etag: null, lastModified: null },
      diagnostic: { parserStage: "browser_render" },
      items: [
        {
          canonicalUrl: "https://news.example/product-update",
          title: "Public product update",
          evidence: [{ route: "https://news.example/product-update" }],
          completeness: { body: "available", comments: "unsupported" },
        },
      ],
    });
    expect(result.items[0]?.body).toContain("Example Research released");

    const unchanged = await adapter.collect({ ...request, checkpoint: result.checkpoint });
    expect(unchanged).toMatchObject({
      kind: "completed",
      outcome: "no_new_material",
      items: [],
      diagnostic: { parserStage: "browser_render" },
    });
  });

  it("reports a rendered but genuinely empty section as a legitimate empty", async () => {
    let rendered = 0;
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/section",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => {
        rendered += 1;
        return {
          url,
          contentType: "text/html",
          status: 200,
          body: fixture("website-rendered-empty.html"),
        };
      },
    ).collect({
      target: target("website", "https://news.example/section"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(rendered).toBe(1);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "legitimate_empty",
      items: [],
      diagnostic: { parserStage: "browser_render" },
    });
  });

  it("keeps plain-HTTP failures in front of the browser route", async () => {
    let rendered = 0;
    const render = async (url: string) => {
      rendered += 1;
      return {
        url,
        contentType: "text/html",
        status: 200,
        body: fixture("website-rendered-article.html"),
      };
    };
    const request = {
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    };
    const blocked = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          status: 403,
          body: fixture("website-blocked.html"),
        }),
      () => NOW,
      render,
    ).collect(request);
    expect(blocked).toMatchObject({
      kind: "failed",
      outcome: "blocked_access",
      diagnostic: { parserStage: "fetch", status: 403 },
    });

    const limited = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          status: 429,
          retryAfter: "30",
          body: fixture("website-rate-limited.html"),
        }),
      () => NOW,
      render,
    ).collect(request);
    expect(limited).toMatchObject({
      kind: "failed",
      outcome: "rate_limit",
      diagnostic: { parserStage: "fetch", retryAfterMs: 30_000 },
    });
    expect(rendered).toBe(0);
  });

  it("classifies a browser render timeout separately from the fetch route", async () => {
    const timeout = new Error("Navigation timed out.");
    timeout.name = "AbortError";
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async () => {
        throw timeout;
      },
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "timeout",
      diagnostic: { parserStage: "browser_render" },
    });
  });

  it("keeps a rendered access or rate-limit response classified at the browser stage", async () => {
    const request = {
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    };
    const blocked = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => ({
        url,
        contentType: "text/html",
        status: 403,
        body: fixture("website-blocked.html"),
      }),
    ).collect(request);
    expect(blocked).toMatchObject({
      kind: "failed",
      outcome: "blocked_access",
      diagnostic: { parserStage: "browser_render", status: 403 },
    });

    const limited = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => ({
        url,
        contentType: "text/html",
        status: 429,
        body: fixture("website-rate-limited.html"),
      }),
    ).collect(request);
    expect(limited).toMatchObject({
      kind: "failed",
      outcome: "rate_limit",
      diagnostic: { parserStage: "browser_render", status: 429 },
    });
  });

  it("classifies a browser launch failure without hiding it behind a parser break", async () => {
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async () => {
        throw new Error("Chromium executable or library is missing from this runtime.");
      },
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "internal_failure",
      diagnostic: {
        parserStage: "browser_render",
        causeChain: ["Chromium executable or library is missing from this runtime."],
      },
    });
  });

  it("reports a rendered page that no longer parses as a browser-stage parser failure", async () => {
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => ({
        url,
        contentType: "text/html",
        status: 200,
        body: fixture("website-parse-failure.html"),
      }),
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "parser_failure",
      diagnostic: { parserStage: "browser_render", affectedCapabilities: ["body"] },
    });
  });
});

describe("YouTube Source Adapter fixture contract", () => {
  it("uses the existing official connection seam and enriches at most 50 comments", async () => {
    const data = JSON.parse(fixture("youtube-channel.json")) as {
      channel: { id: string; uploadsPlaylistId: string };
      videos: Awaited<ReturnType<YouTubeSourceClient["listUploads"]>>;
      comments: Awaited<ReturnType<YouTubeSourceClient["listComments"]>>;
    };
    let commentLimit = 0;
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return data.channel;
      },
      async listUploads() {
        return data.videos;
      },
      async listComments(_videoId, limit) {
        commentLimit = limit;
        return data.comments;
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target("youtube", "https://www.youtube.com/@found42"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "video-1",
          completeness: { transcript: "unavailable", comments: "unavailable" },
        },
      ],
    });
    const enriched = await adapter.enrich(result.items);
    expect(commentLimit).toBe(50);
    expect(enriched[0]).toMatchObject({
      comments: [{ text: "How would a small team apply this?" }],
      completeness: { comments: "available" },
    });
  });

  it("keeps a disconnected official connection distinct from an empty channel", async () => {
    const result = await new YouTubeSourceAdapter(
      () => ({ ok: false, state: "disconnected" }),
      () => NOW,
    ).collect({
      target: target("youtube", "https://www.youtube.com/@found42"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "failed", outcome: "blocked_access", items: [] });
  });
});

describe("Experimental anonymous social adapters", () => {
  it("keeps instagram Experimental while normalizing explicit public embedded evidence", async () => {
    const platform = "instagram" as const;
    const adapter = new ExperimentalPublicPageAdapter(
      platform,
      async () =>
        response({
          url: `https://www.${platform}.com/public-creator`,
          contentType: "text/html",
          body: fixture("social-public-page.html").replaceAll("instagram", platform),
        }),
      () => NOW,
    );
    const request = {
      target: target(platform, `https://www.${platform}.com/public-creator`),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    };
    const result = await adapter.collect(request);
    expect(adapter.state).toBe("experimental");
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "public-post-42",
          adapterId: platform,
          completeness: { transcript: "unavailable", comments: "unavailable" },
        },
      ],
    });

    const changed = await new ExperimentalPublicPageAdapter(
      platform,
      async () =>
        response({
          url: `https://www.${platform}.com/public-creator`,
          contentType: "text/html",
          body: fixture("social-shape-change.html"),
        }),
      () => NOW,
    ).collect(request);
    expect(changed).toMatchObject({
      kind: "failed",
      outcome: "response_shape_change",
      diagnostic: { affectedCapabilities: ["items", "transcript", "comments"] },
    });
  });
});

describe("Substack media enrichment adapter", () => {
  const substackTarget = target("substack", "https://research-public.substack.com/feed");
  const page = (name: string, overrides: Partial<PublicHttpResponse> = {}) =>
    response({
      url: "https://research-public.substack.com/p/a-media-walkthrough",
      contentType: "text/html",
      body: fixture(name),
      ...overrides,
    });

  async function feedItems(feedName: string, checkpoint: string | null): Promise<SourceItem[]> {
    const result = await new RssSourceAdapter(
      async () => response({ body: fixture(feedName) }),
      () => NOW,
      { id: "substack" },
    ).collect({
      target: substackTarget,
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint,
    });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      return result.items;
    }
    return [];
  }

  it("enriches a known Substack post with bounded public media and publication evidence", async () => {
    const adapter = new SubstackEnrichmentAdapter(
      async () => page("substack-post-media.html"),
      () => NOW,
    );
    const feed = (await feedItems("substack-feed-media.xml", null))[0];
    expect(feed.adapterId).toBe("substack");
    expect(feed.canonicalUrl).toBe("https://research-public.substack.com/p/a-media-walkthrough");
    expect(feed.completeness.media).toBe("available");

    const enriched = (await adapter.enrich([feed]))[0];
    expect(enriched.id).toBe(feed.id);
    expect(enriched.externalId).toBe(feed.externalId);
    expect(enriched.canonicalUrl).toBe(
      "https://research-public.substack.com/p/a-media-walkthrough",
    );
    expect(enriched.body).toBe(feed.body);
    expect(enriched.completeness).toMatchObject({
      title: "available",
      body: "available",
      media: "available",
    });
    expect(enriched.media).toEqual(
      expect.arrayContaining([
        { type: "audio", url: "https://api.substack.com/feed/podcast/789.mp3" },
        {
          type: "image",
          url: "https://substackcdn.com/image/fetch/w_1456,c_limit,f_auto,q_auto:good/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fcover.jpeg",
        },
        {
          type: "audio",
          url: "https://substackcdn.com/audio/789c0ffe-6a1e-4b2b-8c9d-1f2a3b4c5d6e.mp3",
        },
      ]),
    );
    expect(enriched.evidence.at(-1)).toMatchObject({
      route: "https://research-public.substack.com/p/a-media-walkthrough",
      retrievedAt: NOW.toISOString(),
    });
  });

  it("keeps feed identity, checkpoint, and text stable across the feed and enrichment routes", async () => {
    const adapter = new SubstackEnrichmentAdapter(
      async () => page("substack-post-text-only.html"),
      () => NOW,
    );
    const feed = (await feedItems("substack-feed-text-only.xml", "feed-v1"))[0];
    const enriched = (await adapter.enrich([feed]))[0];
    expect(enriched).toMatchObject({
      id: "target-substack:https://research-public.substack.com/p/a-text-only-post",
      externalId: "https://research-public.substack.com/p/a-text-only-post",
      canonicalUrl: "https://research-public.substack.com/p/a-text-only-post",
      author: "Research Author",
      publishedAt: "2026-08-25T10:00:00.000Z",
      title: "A text-only analysis of the verified change",
      media: [],
      completeness: { media: "unavailable" },
    });
  });

  it("classifies an empty Substack feed as a legitimate empty source", async () => {
    const result = await new RssSourceAdapter(
      async () => response({ body: fixture("substack-feed-empty.xml") }),
      () => NOW,
      { id: "substack" },
    ).collect({
      target: substackTarget,
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
  });

  it("marks missing public media as unavailable, not failed", async () => {
    const adapter = new SubstackEnrichmentAdapter(
      async () => page("substack-post-no-media.html"),
      () => NOW,
    );
    const feed = (await feedItems("substack-feed-text-only.xml", null))[0];
    const enriched = (await adapter.enrich([feed]))[0];
    expect(enriched.completeness.media).toBe("unavailable");
    expect(enriched.media).toEqual([]);
    expect(enriched.claims).toBeUndefined();
  });

  it("preserves usable feed text when the post page blocks or rate-limits", async () => {
    for (const status of [403, 429]) {
      const adapter = new SubstackEnrichmentAdapter(
        async () =>
          page("substack-post-media.html", {
            status,
            body: status === 403 ? "Forbidden" : "Slow down",
          }),
        () => NOW,
      );
      const feed = (await feedItems("substack-feed-media.xml", null))[0];
      const enriched = (await adapter.enrich([feed]))[0];
      expect(enriched.completeness).toMatchObject({
        title: "available",
        body: "available",
        media: "failed",
      });
      expect(enriched.body).toBe(feed.body);
      expect(enriched.claims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: "unsupported",
            sourceUrls: ["https://research-public.substack.com/p/a-media-walkthrough"],
          }),
        ]),
      );
      expect(enriched.evidence.at(-1)?.route).toBe(
        "https://research-public.substack.com/p/a-media-walkthrough",
      );
    }
  });

  it("preserves usable feed text when the post page changed shape", async () => {
    const adapter = new SubstackEnrichmentAdapter(
      async () => page("substack-post-shape-change.html"),
      () => NOW,
    );
    const feed = (await feedItems("substack-feed-text-only.xml", null))[0];
    const enriched = (await adapter.enrich([feed]))[0];
    expect(enriched.title).toBe("A text-only analysis of the verified change");
    expect(enriched.completeness.media).toBe("unavailable");
  });
  it("keeps partial publication evidence without inventing media or times", async () => {
    const adapter = new SubstackEnrichmentAdapter(
      async () => page("substack-post-partial.html"),
      () => NOW,
    );
    const feed = (await feedItems("substack-feed-text-only.xml", null))[0];
    const enriched = (await adapter.enrich([feed]))[0];
    expect(enriched.canonicalUrl).toBe("https://research-public.substack.com/p/partial-post");
    expect(enriched.author).toBe("Research Author");
    expect(enriched.publishedAt).toBe(feed.publishedAt);
    expect(enriched.completeness.media).toBe("unavailable");
  });

  it("does not touch items from other platforms and never claims collection", async () => {
    const adapter = new SubstackEnrichmentAdapter(
      async () => page("substack-post-media.html"),
      () => NOW,
    );
    expect(adapter.supports()).toBe(false);
    const youtube = await new YouTubeSourceAdapter(
      () => ({
        ok: true,
        client: {
          async resolveChannel() {
            return { id: "channel-1", uploadsPlaylistId: "playlist-1" };
          },
          async listUploads() {
            return [];
          },
          async listComments() {
            return [];
          },
        } satisfies YouTubeSourceClient,
      }),
      () => NOW,
    ).collect({
      target: target("youtube", "https://www.youtube.com/@found42"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(youtube.kind).toBe("completed");
    if (youtube.kind === "completed") {
      const untouched = await adapter.enrich(youtube.items);
      expect(untouched).toHaveLength(0);
    }
  });

  it("leaves unrelated feeds on the shared RSS route untouched", async () => {
    const adapter = new SubstackEnrichmentAdapter(
      async () => {
        throw new Error("should never be called for non-Substack items");
      },
      () => NOW,
    );
    const result = await new RssSourceAdapter(
      async () => response(),
      () => NOW,
    ).collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      const enriched = await adapter.enrich(result.items);
      expect(enriched).toEqual(result.items);
    }
  });
});

describe("TikTok yt-dlp Source Adapter fixture contract", () => {
  const userRequest = {
    target: target("tiktok", "https://www.tiktok.com/@publicmaker"),
    since: "2026-08-18T12:00:00.000Z",
    until: NOW.toISOString(),
    checkpoint: null,
  };

  it("normalizes a public user page through the isolated yt-dlp route", async () => {
    let invoked: string[] | null = null;
    const adapter = new TikTokYtDlpAdapter(
      async (args) => {
        invoked = args;
        return { stdout: fixture("tiktok-user-page.json"), stderr: "", code: 0 };
      },
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect(userRequest);
    expect(adapter.state).toBe("experimental");
    // The production command boundary is exact: metadata-only flags, no media
    // download (`-o`, `--write-*`, `--download-sections`), no config/cookie
    // import, so nothing temporary is ever retained by collection.
    expect(invoked).toEqual([
      "--ignore-config",
      "--no-warnings",
      "--socket-timeout",
      "30",
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-end",
      "50",
      "https://www.tiktok.com/@publicmaker",
    ]);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      diagnostic: {
        classification: "items_found",
        parserStage: "yt_dlp",
        adapterVersion: "tiktok-yt-dlp-v1",
      },
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      externalId: "7321000000000000001",
      canonicalUrl: "https://www.tiktok.com/@publicmaker/video/7321000000000000001",
      adapterId: "tiktok",
      author: "publicmaker",
      media: [
        { type: "video", url: "https://www.tiktok.com/@publicmaker/video/7321000000000000001" },
      ],
      completeness: {
        title: "available",
        body: "unavailable",
        transcript: "unsupported",
        comments: "unavailable",
      },
    });
    expect(result.items[0]?.publishedAt).toBe("2026-08-20T10:00:00.000Z");
    // The third fixture entry is outside the collection window and must not
    // appear as an empty success or a stale item.
    expect(result.items.map((item) => item.externalId)).toEqual([
      "7321000000000000001",
      "7321000000000000002",
    ]);
    expect(result.checkpoint).toEqual(expect.any(String));
  });

  it("normalizes a single public video and keeps its canonical route", async () => {
    let invoked: string[] | null = null;
    const adapter = new TikTokYtDlpAdapter(
      async (args) => {
        invoked = args;
        return { stdout: fixture("tiktok-video.json"), stderr: "", code: 0 };
      },
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target("tiktok", "https://www.tiktok.com/@publicmaker/video/7321000000000000004"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(invoked).toEqual(expect.arrayContaining(["--no-playlist", "--dump-single-json"]));
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "7321000000000000004",
          canonicalUrl: "https://www.tiktok.com/@publicmaker/video/7321000000000000004",
          author: "publicmaker",
          description: expect.stringContaining("interoperability rule"),
          completeness: { body: "available", description: "available" },
        },
      ],
    });
  });

  it("keeps a legitimate empty public account distinct from a failed fetch", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-user-empty.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      ...userRequest,
      target: target("tiktok", "https://www.tiktok.com/@quietaccount"),
    });
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "legitimate_empty",
      items: [],
    });
    const unchanged = await adapter.collect({
      ...userRequest,
      target: target("tiktok", "https://www.tiktok.com/@quietaccount"),
      checkpoint: "existing-checkpoint",
    });
    expect(unchanged).toMatchObject({ kind: "completed", outcome: "no_new_material", items: [] });
  });

  it("classifies a response-shape change as a loud failure, not an empty success", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-shape-change.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect(userRequest);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "response_shape_change",
      diagnostic: {
        affectedCapabilities: ["items"],
        parserStage: "yt_dlp",
      },
    });
  });

  it("keeps unsupported target kinds explicit instead of guessing", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: "{}", stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      ...userRequest,
      target: target("tiktok", "https://www.tiktok.com/@maker/tag/practical"),
    });
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "unsupported_capability",
      diagnostic: { affectedCapabilities: ["source_target"] },
    });
  });

  it.each([
    [
      "login wall",
      "ERROR: [TikTok] @maker: login required",
      "blocked_access",
      ["items", "comments"],
    ],
    ["rate limit", "ERROR: Too many requests (429)", "rate_limit", ["items"]],
    [
      "parser change",
      "ERROR: no supported extractor for tiktok.com",
      "unsupported_capability",
      ["source_target"],
    ],
    ["internal failure", "ERROR: Unexpected network error", "internal_failure", ["items"]],
  ] as const)(
    "classifies %s on the yt-dlp stderr boundary",
    async (_name, stderr, outcome, affectedCapabilities) => {
      const adapter = new TikTokYtDlpAdapter(
        async () => ({ stdout: "", stderr, code: 1 }),
        async () => ({ stdout: "", stderr: "", code: 0 }),
        () => NOW,
      );
      const result = await adapter.collect(userRequest);
      expect(result).toMatchObject({
        kind: "failed",
        outcome,
        diagnostic: { affectedCapabilities },
      });
    },
  );

  it("keeps Pyktok enrichment optional and never a hidden collection requirement", async () => {
    const collected = await new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-user-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    ).collect(userRequest);
    expect(collected.kind).toBe("completed");

    // Pyktok absent: the version probe fails, comments stay explicitly
    // unsupported, and collected evidence is untouched.
    const withoutPyktok = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-user-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "pyktok not installed", code: 1 }),
      () => NOW,
    );
    const collectedAgain = await withoutPyktok.collect(userRequest);
    const enriched = await withoutPyktok.enrich(collectedAgain.items);
    expect(enriched[0]).toMatchObject({ completeness: { comments: "unsupported" } });
    expect(enriched[0]?.body).toBe(collectedAgain.items[0]?.body);
  });

  it("normalizes optional Pyktok comments and marks worker failures as failed fields", async () => {
    let pythonCalls = 0;
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-video.json"), stderr: "", code: 0 }),
      async (args) => {
        pythonCalls += 1;
        if (args.some((arg) => arg.includes("importlib.metadata.version('pyktok')"))) {
          return { stdout: "0.0.11", stderr: "", code: 0 };
        }
        return { stdout: fixture("tiktok-comments.json"), stderr: "", code: 0 };
      },
      () => NOW,
    );
    const result = await adapter.collect({
      target: target("tiktok", "https://www.tiktok.com/@publicmaker/video/7321000000000000004"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    const enriched = await adapter.enrich(result.items);
    expect(pythonCalls).toBe(2); // one version probe, one comment worker
    expect(enriched[0]?.comments).toEqual([
      {
        author: "builder_alice",
        publishedAt: "2026-08-20T10:05:00.000Z",
        url: null,
        text: "How would a small team apply this?",
        engagement: 88,
      },
      {
        author: "skeptic_bob",
        publishedAt: "2026-08-20T10:06:00.000Z",
        url: null,
        text: "This contradicts the guidance we saw last week.",
        engagement: 41,
      },
      {
        author: "maker_carol",
        publishedAt: "2026-08-20T10:07:00.000Z",
        url: null,
        text: "Useful breakdown, thanks.",
        engagement: 12,
      },
    ]);
    expect(enriched[0]).toMatchObject({ completeness: { comments: "available" } });

    const failing = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-video.json"), stderr: "", code: 0 }),
      async (args) => {
        if (args.some((arg) => arg.includes("importlib.metadata.version('pyktok')"))) {
          return { stdout: "0.0.11", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "Traceback: TikTok blocked this worker", code: 1 };
      },
      () => NOW,
    );
    // Every video worker failed: the enrichment call stays loud so the shared
    // path counts a warning, rather than silently returning "failed" fields.
    await expect(failing.enrich(result.items)).rejects.toThrow(/Pyktok comment enrichment failed/);
  });
});
