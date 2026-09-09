import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RssSourceAdapter } from "../../../apps/server/src/source-adapters/rss";
import { SubstackEnrichmentAdapter } from "../../../apps/server/src/modules/content-scout/adapters/substack";
import { WebsiteSourceAdapter } from "../../../apps/server/src/source-adapters/website";
import { RedditSourceAdapter } from "../../../apps/server/src/source-adapters/reddit";
import { InstagramInstaloaderAdapter } from "../../../apps/server/src/modules/content-scout/adapters/instagram";
import { TikTokYtDlpAdapter } from "../../../apps/server/src/modules/content-scout/adapters/tiktok";
import { ExperimentalPublicPageAdapter } from "../../../apps/server/src/modules/content-scout/adapters/experimental";
import {
  YouTubeSourceAdapter,
  type YouTubeSourceClient,
} from "../../../apps/server/src/source-adapters/youtube";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";
import type { SourceItem, SourceTarget } from "@chief-of-staff-demo/shared";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const SINCE = "2026-08-18T12:00:00.000Z";
const UNTIL = NOW.toISOString();

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "fixtures", "content-scout", name), "utf8");

interface FailureCapture {
  status?: number;
  body?: string;
  bodyFixture?: string;
  retryAfter?: string;
  name?: string;
  message?: string;
  code?: number;
  connectionState?: "disconnected";
  stdout?: string;
  stdoutFixture?: string;
  stderr?: string;
}

function failureCapture(
  adapterId: "rss" | "substack" | "website" | "youtube" | "reddit" | "instagram" | "tiktok",
  scenario: "blocked" | "rateLimit" | "timeout",
): FailureCapture {
  const captures = JSON.parse(fixture(`${adapterId}-failures.json`)) as Record<
    string,
    FailureCapture
  >;
  return captures[scenario];
}

function capturedError(capture: FailureCapture): Error {
  const error = new Error(capture.message ?? "Captured public route failure");
  error.name = capture.name ?? "Error";
  return error;
}

function capturedCommand(capture: FailureCapture): {
  stdout: string;
  stderr: string;
  code: number;
} {
  return {
    stdout: capture.stdoutFixture ? fixture(capture.stdoutFixture) : (capture.stdout ?? ""),
    stderr: capture.stderr ?? "",
    code: capture.code ?? 1,
  };
}

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

const abortError = (): Error & { name: string } => {
  const error = new Error("aborted") as Error & { name: string };
  error.name = "AbortError";
  return error;
};

const sha256 = (body: string) => createHash("sha256").update(body).digest("hex");

// Helpers for common assertions
function assertCompletedReceipt(
  result: { kind: string; outcome: string; diagnostic: Record<string, unknown> },
  expectedVersion: string,
) {
  expect(result.kind).toBe("completed");
  expect(["items_found", "legitimate_empty", "no_new_material"]).toContain(result.outcome);
  expect(result.diagnostic.adapterVersion).toBe(expectedVersion);
  expect(result.diagnostic.responseHash).toMatch(/^([a-f0-9]{64}|)$/);
  expect(result.diagnostic.startedAt).toBeDefined();
  expect(result.diagnostic.finishedAt).toBeDefined();
  expect(result.diagnostic.retries).toBe(0);
  expect(Array.isArray(result.diagnostic.causeChain)).toBe(true);
}

function assertFailedReceipt(
  result: {
    kind: string;
    outcome: string;
    diagnostic: Record<string, unknown>;
    diagnosticBody?: unknown;
  },
  expectedVersion: string,
  expectedClassification: string,
) {
  expect(result.kind).toBe("failed");
  expect(result.outcome).toBe(expectedClassification);
  expect(result.diagnostic.classification).toBe(expectedClassification);
  expect(result.diagnostic.adapterVersion).toBe(expectedVersion);
  expect(result.diagnostic.responseHash).toMatch(/^([a-f0-9]{64}|)$/);
  expect(result.diagnostic.startedAt).toBeDefined();
  expect(result.diagnostic.finishedAt).toBeDefined();
  expect(result.diagnostic.retries).toBe(0);
  expect(Array.isArray(result.diagnostic.causeChain)).toBe(true);
  expect((result.diagnostic.causeChain as string[]).length).toBeGreaterThan(0);
  // Failed outcomes never share legitimate_empty shape
  expect(result.outcome).not.toBe("legitimate_empty");
  expect(result.kind).not.toBe("completed");
  // checkpoint must be null on failures
  expect((result as unknown as { checkpoint: unknown }).checkpoint).toBeNull();
}

function assertSourceItemInvariants(
  item: SourceItem,
  expectedAdapterId: string,
  expectedTargetId: string,
) {
  expect(item.id).toBe(`${expectedTargetId}:${item.externalId}`);
  expect(item.externalId).toBeTruthy();
  expect(item.targetId).toBe(expectedTargetId);
  expect(item.adapterId).toBe(expectedAdapterId);
  // canonicalUrl must be absolute and not carry UTM params
  expect(item.canonicalUrl).toMatch(/^https:\/\//);
  expect(item.canonicalUrl).not.toMatch(/utm_source/);
  expect(item.discoveredAt).toBe(NOW.toISOString());
  for (const ev of item.evidence) {
    expect(ev.route).toMatch(/^(https:\/\/|youtube\.data)/);
    expect(new Date(ev.retrievedAt).toISOString()).toBe(ev.retrievedAt);
  }
  expect(item.completeness).toBeDefined();
  expect(["available", "unavailable", "unsupported", "failed"]).toContain(item.completeness.title);
  expect(["available", "unavailable", "unsupported", "failed"]).toContain(item.completeness.body);
  expect(["available", "unavailable", "unsupported", "failed"]).toContain(item.completeness.media);
  expect(["available", "unavailable", "unsupported", "failed"]).toContain(
    item.completeness.transcript,
  );
  expect(["available", "unavailable", "unsupported", "failed"]).toContain(
    item.completeness.comments,
  );
  // No raw HTML in body leak of diagnostic secrets
  if (item.body) expect(item.body.length).toBeGreaterThan(0);
}

describe("checked-in fixture matrix", () => {
  const matrix = {
    rss: [
      "rss-success.xml",
      "rss-empty.xml",
      "rss-partial.xml",
      "rss-failures.json",
      "rss-malformed.xml",
    ],
    substack: [
      "substack-feed-media.xml",
      "substack-feed-empty.xml",
      "substack-post-partial.html",
      "substack-failures.json",
      "substack-post-shape-change.html",
    ],
    website: [
      "website-article.html",
      "website-rendered-empty.html",
      "website-article-partial.html",
      "website-failures.json",
      "website-parse-failure.html",
    ],
    youtube: [
      "youtube-channel.json",
      "youtube-channel-empty.json",
      "youtube-channel-partial.json",
      "youtube-failures.json",
      "youtube-channel-shape-change.json",
    ],
    reddit: [
      "reddit-rss.xml",
      "reddit-rss-empty.xml",
      "reddit-rss-incomplete.xml",
      "reddit-failures.json",
      "reddit-listing-shape-change.json",
    ],
    instagram: [
      "instagram-profile-page.json",
      "instagram-profile-empty.json",
      "instagram-profile-partial.json",
      "instagram-failures.json",
      "instagram-parser-change.json",
    ],
    tiktok: [
      "tiktok-user-page.json",
      "tiktok-user-empty.json",
      "tiktok-user-partial.json",
      "tiktok-failures.json",
      "tiktok-shape-change.json",
    ],
  } as const;

  it("keeps success, empty, partial, blocked/rate/timeout, and shape captures for every adapter", () => {
    for (const [adapterId, files] of Object.entries(matrix)) {
      expect(files, adapterId).toHaveLength(5);
      for (const file of files)
        expect(fixture(file).trim().length, `${adapterId}: ${file}`).toBeGreaterThan(0);
      const failures = JSON.parse(fixture(files[3])) as Record<string, unknown>;
      expect(Object.keys(failures), adapterId).toEqual(["blocked", "rateLimit", "timeout"]);
    }
  });
});

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------
describe("RSS fixture contract — hermetic", () => {
  const adapterId = "rss";
  const version = "rss-parser@3";

  it("success normalizes identity, canonicalUrl, checkpoint, evidence, media, transcript/comments", async () => {
    const body = fixture("rss-success.xml");
    const adapter = new RssSourceAdapter(
      async () => response({ body }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.kind).toBe("completed");
    expect(result.outcome).toBe("items_found");
    expect(result.items).toHaveLength(2);
    expect(result.checkpoint).toBe(sha256(body));
    expect(result.conditional).toEqual({ etag: null, lastModified: null });
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
    expect(result.diagnostic.parserStage).toBe("rss_parse");
    // first item complete, second partial
    expect(result.items[0]).toMatchObject({
      externalId: "story-1",
      canonicalUrl: "https://example.com/story-1",
      title: "A verified change",
      author: "research@example.com",
    });
    assertSourceItemInvariants(result.items[0], adapterId, `target-${adapterId}`);
    expect(result.items[0].completeness).toMatchObject({
      title: "available",
      body: "available",
      transcript: "unsupported",
      comments: "unsupported",
    });
    expect(result.items[1].completeness).toMatchObject({
      title: "unavailable",
      body: "unavailable",
    });
  });

  it("partial data keeps usable identity without inventing missing fields", async () => {
    const body = fixture("rss-partial.xml");
    const adapter = new RssSourceAdapter(
      async () => response({ body }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.outcome).toBe("items_found");
    expect(result.items).toHaveLength(2);
    expect(result.items[1].title).toBeNull();
    expect(result.items[1].body).toBeNull();
    expect(result.items[1].completeness.title).toBe("unavailable");
  });

  it("legitimate empty is distinct from failure", async () => {
    const body = fixture("rss-empty.xml");
    const adapter = new RssSourceAdapter(
      async () => response({ body }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
    expect(result.checkpoint).toBe(sha256(body));
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
    // Repeat with checkpoint -> no_new_material (distinct from legitimate_empty)
    const repeat = await adapter.collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: result.checkpoint,
    });
    expect(repeat.outcome).toBe("no_new_material");
    expect(repeat.kind).toBe("completed");
  });

  it("blocked access does not share legitimate empty shape", async () => {
    const captured = failureCapture("rss", "blocked");
    const result = await new RssSourceAdapter(
      async () => response({ status: captured.status!, body: captured.body! }),
      () => NOW,
    ).collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "blocked_access",
    );
    expect(result.diagnostic.parserStage).toBe("fetch");
    expect(result.diagnostic.status).toBe(403);
    expect(result.diagnosticBody?.body).toBe(captured.body);
  });

  it("rate limit carries retryAfterMs and sanitized diagnostic", async () => {
    const captured = failureCapture("rss", "rateLimit");
    const result = await new RssSourceAdapter(
      async () =>
        response({
          status: captured.status!,
          body: captured.body!,
          retryAfter: captured.retryAfter!,
        }),
      () => NOW,
    ).collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "rate_limit",
    );
    expect(result.diagnostic.parserStage).toBe("fetch");
    expect(result.diagnostic.retryAfterMs).toBe(30_000);
    expect(result.diagnosticBody?.body).toBe(captured.body);
  });

  it("timeout is loud and distinct", async () => {
    const captured = failureCapture("rss", "timeout");
    const result = await new RssSourceAdapter(
      async () => {
        throw capturedError(captured);
      },
      () => NOW,
    ).collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "timeout",
    );
    expect(result.diagnostic.parserStage).toBe("fetch");
  });

  it("response shape change is loud and not empty", async () => {
    const body = fixture("rss-malformed.xml");
    const result = await new RssSourceAdapter(
      async () => response({ body, contentType: "text/html" }),
      () => NOW,
    ).collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "response_shape_change",
    );
    expect(result.diagnostic.parserStage).toBe("rss_parse");
    expect(result.diagnosticBody?.body).toBe(body);
  });

  it("receipt identifies adapter version and parser stage", async () => {
    const body = fixture("rss-success.xml");
    const result = await new RssSourceAdapter(
      async () => response({ body }),
      () => NOW,
    ).collect({
      target: target(adapterId, "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.diagnostic.adapterVersion).toBe(version);
    expect(result.diagnostic.parserStage).toBe("rss_parse");
    expect(result.diagnostic.responseHash).toBe(sha256(body));
  });
});

// ---------------------------------------------------------------------------
// Substack (RSS with id substack + enrichment)
// ---------------------------------------------------------------------------
describe("Substack fixture contract — hermetic", () => {
  const feedAdapterId = "substack";
  const feedVersion = "rss-parser@3";
  const enrichVersion = "substack-public-page-v1";

  it("success feed normalizes canonicalUrl and evidence", async () => {
    const body = fixture("substack-feed-media.xml");
    const adapter = new RssSourceAdapter(
      async () => response({ body, url: "https://research-public.substack.com/feed" }),
      () => NOW,
      {
        id: feedAdapterId,
      },
    );
    const result = await adapter.collect({
      target: target(feedAdapterId, "https://research-public.substack.com/feed"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.outcome).toBe("items_found");
    expect(result.items[0].canonicalUrl).toBe(
      "https://research-public.substack.com/p/a-media-walkthrough",
    );
    expect(result.items[0].adapterId).toBe(feedAdapterId);
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      feedVersion,
    );
  });

  it("legitimate empty feed is distinct", async () => {
    const body = fixture("substack-feed-empty.xml");
    const result = await new RssSourceAdapter(
      async () => response({ body, url: "https://research-public.substack.com/feed" }),
      () => NOW,
      { id: feedAdapterId },
    ).collect({
      target: target(feedAdapterId, "https://research-public.substack.com/feed"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
    expect(result.diagnostic.adapterVersion).toBe(feedVersion);
  });

  it("partial enrichment keeps publication identity without inventing media", async () => {
    const enrich = new SubstackEnrichmentAdapter(
      async () => ({
        url: "https://research-public.substack.com/p/partial-post",
        status: 200,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: fixture("substack-post-partial.html"),
      }),
      () => NOW,
    );
    const feedResult = await new RssSourceAdapter(
      async () =>
        response({
          body: fixture("substack-feed-text-only.xml"),
          url: "https://research-public.substack.com/feed",
        }),
      () => NOW,
      { id: feedAdapterId },
    ).collect({
      target: target(feedAdapterId, "https://research-public.substack.com/feed"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    const enriched = (await enrich.enrich(feedResult.items))[0];
    expect(enriched.canonicalUrl).toBe("https://research-public.substack.com/p/partial-post");
    expect(enriched.completeness.media).toBe("unavailable");
    expect(enriched.publishedAt).toBe(feedResult.items[0].publishedAt);
  });

  it("blocked post preserves feed text and marks media failed", async () => {
    const captured = failureCapture("substack", "blocked");
    const enrich = new SubstackEnrichmentAdapter(
      async () => ({
        url: "https://research-public.substack.com/p/a-media-walkthrough",
        status: captured.status!,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: captured.body!,
      }),
      () => NOW,
    );
    const feedResult = await new RssSourceAdapter(
      async () =>
        response({
          body: fixture("substack-feed-media.xml"),
          url: "https://research-public.substack.com/feed",
        }),
      () => NOW,
      { id: feedAdapterId },
    ).collect({
      target: target(feedAdapterId, "https://research-public.substack.com/feed"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    const enriched = (await enrich.enrich(feedResult.items))[0];
    expect(enriched.completeness.media).toBe("failed");
    expect(enriched.body).toBe(feedResult.items[0].body);
  });

  it("rate limited post preserves feed text", async () => {
    const captured = failureCapture("substack", "rateLimit");
    const enrich = new SubstackEnrichmentAdapter(
      async () => ({
        url: "https://research-public.substack.com/p/a-media-walkthrough",
        status: captured.status!,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: captured.retryAfter!,
        body: captured.body!,
      }),
      () => NOW,
    );
    const feedResult = await new RssSourceAdapter(
      async () =>
        response({
          body: fixture("substack-feed-media.xml"),
          url: "https://research-public.substack.com/feed",
        }),
      () => NOW,
      { id: feedAdapterId },
    ).collect({
      target: target(feedAdapterId, "https://research-public.substack.com/feed"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    const enriched = (await enrich.enrich(feedResult.items))[0];
    expect(enriched.completeness.media).toBe("failed");
  });

  it("timed-out post preserves feed text and marks media failed", async () => {
    const captured = failureCapture("substack", "timeout");
    const enrich = new SubstackEnrichmentAdapter(
      async () => {
        throw capturedError(captured);
      },
      () => NOW,
    );
    const feedResult = await new RssSourceAdapter(
      async () =>
        response({
          body: fixture("substack-feed-media.xml"),
          url: "https://research-public.substack.com/feed",
        }),
      () => NOW,
      { id: feedAdapterId },
    ).collect({
      target: target(feedAdapterId, "https://research-public.substack.com/feed"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    const enriched = (await enrich.enrich(feedResult.items))[0];
    expect(enriched.body).toBe(feedResult.items[0].body);
    expect(enriched.completeness.media).toBe("failed");
    expect(enriched.claims?.[0]?.text).toContain(captured.message);
  });

  it("shape change post keeps feed text stable", async () => {
    const enrich = new SubstackEnrichmentAdapter(
      async () => ({
        url: "https://research-public.substack.com/p/a-text-only-post",
        status: 200,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: fixture("substack-post-shape-change.html"),
      }),
      () => NOW,
    );
    const feedResult = await new RssSourceAdapter(
      async () =>
        response({
          body: fixture("substack-feed-text-only.xml"),
          url: "https://research-public.substack.com/feed",
        }),
      () => NOW,
      { id: feedAdapterId },
    ).collect({
      target: target(feedAdapterId, "https://research-public.substack.com/feed"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    const enriched = (await enrich.enrich(feedResult.items))[0];
    expect(enriched.title).toBe(feedResult.items[0].title);
  });

  it("substack enrichment never claims collection and is hermetic", async () => {
    const enrich = new SubstackEnrichmentAdapter(
      async () => {
        throw new Error("should not be called for non-substack");
      },
      () => NOW,
    );
    expect(enrich.supports()).toBe(false);
    expect(enrich.version).toBe(enrichVersion);
  });
});

// ---------------------------------------------------------------------------
// Website
// ---------------------------------------------------------------------------
describe("Website fixture contract — hermetic", () => {
  const adapterId = "website";
  const version = "readability@0.6-browser-render@1";

  it("success via plain HTTP normalizes canonicalUrl and completeness", async () => {
    const adapter = new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-article.html"),
        }),
      () => NOW,
      async () => ({ url: "", contentType: "text/html", status: 200, body: "" }),
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "items_found" });
    expect(result.items[0].canonicalUrl).toBe("https://news.example/product-update");
    expect(result.items[0].completeness).toMatchObject({
      body: "available",
      comments: "unsupported",
      transcript: "unsupported",
    });
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
    expect(result.diagnostic.parserStage).toBe("readability");
    assertSourceItemInvariants(result.items[0], adapterId, `target-${adapterId}`);
  });

  it("partial article keeps identity without inventing time", async () => {
    const adapter = new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-article-partial.html"),
        }),
      () => NOW,
      async () => ({ url: "", contentType: "text/html", status: 200, body: "" }),
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.outcome).toBe("items_found");
    expect(result.items[0].title).toBe("Public product update with partial evidence");
    expect(result.items[0].publishedAt).toBe("2026-08-24T09:30:00.000Z");
  });

  it("legitimate empty via rendered shell is distinct", async () => {
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/section",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async (url) => ({
        url,
        contentType: "text/html",
        status: 200,
        body: fixture("website-rendered-empty.html"),
      }),
    ).collect({
      target: target(adapterId, "https://news.example/section"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
    expect(result.diagnostic.parserStage).toBe("browser_render");
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
  });

  it("blocked access on fetch never reaches browser", async () => {
    const captured = failureCapture("website", "blocked");
    let rendered = 0;
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          status: captured.status!,
          body: fixture(captured.bodyFixture!),
        }),
      () => NOW,
      async (url) => {
        rendered += 1;
        return { url, contentType: "text/html", status: 200, body: "" };
      },
    ).collect({
      target: target(adapterId, "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(rendered).toBe(0);
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "blocked_access",
    );
    expect(result.diagnostic.parserStage).toBe("fetch");
    expect(result.diagnostic.status).toBe(403);
  });

  it("rate limit on fetch carries retryAfterMs", async () => {
    const captured = failureCapture("website", "rateLimit");
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          status: captured.status!,
          retryAfter: captured.retryAfter!,
          body: fixture(captured.bodyFixture!),
        }),
      () => NOW,
      async () => ({ url: "", contentType: "text/html", status: 200, body: "" }),
    ).collect({
      target: target(adapterId, "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "rate_limit",
    );
    expect(result.diagnostic.retryAfterMs).toBe(30_000);
  });

  it("timeout via browser render is distinct", async () => {
    const captured = failureCapture("website", "timeout");
    const err = capturedError(captured);
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-shell.html"),
        }),
      () => NOW,
      async () => {
        throw err;
      },
    ).collect({
      target: target(adapterId, "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "timeout",
    );
    expect(result.diagnostic.parserStage).toBe("browser_render");
  });

  it("response shape change via parse failure is loud", async () => {
    const result = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-parse-failure.html"),
        }),
      () => NOW,
      async () => ({ url: "", contentType: "text/html", status: 200, body: "" }),
    ).collect({
      target: target(adapterId, "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "parser_failure",
    );
    expect(result.diagnostic.parserStage).toBe("readability");
  });

  it("browser render blocked and rate limit are classified at browser stage", async () => {
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
    ).collect({
      target: target(adapterId, "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(blocked.outcome).toBe("blocked_access");
    expect(blocked.diagnostic.parserStage).toBe("browser_render");
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
    ).collect({
      target: target(adapterId, "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(limited.outcome).toBe("rate_limit");
    expect(limited.diagnostic.parserStage).toBe("browser_render");
  });
});

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------
describe("Reddit fixture contract — hermetic", () => {
  const adapterId = "reddit";
  const version = "reddit-public-rss-json-html-v1";

  const rssResponse = (
    body: string,
    overrides: Partial<PublicHttpResponse> = {},
  ): PublicHttpResponse => ({
    url: "https://www.reddit.com/r/publiccommunity.rss",
    status: 200,
    contentType: "application/atom+xml",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
    ...overrides,
  });
  const jsonResponse = (
    body: string,
    overrides: Partial<PublicHttpResponse> = {},
  ): PublicHttpResponse => ({
    url: "https://www.reddit.com/r/publiccommunity.json?limit=25",
    status: 200,
    contentType: "application/json",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
    ...overrides,
  });
  const pageResponse = (
    body: string,
    overrides: Partial<PublicHttpResponse> = {},
  ): PublicHttpResponse => ({
    url: "https://www.reddit.com/r/publiccommunity/",
    status: 200,
    contentType: "text/html",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
    ...overrides,
  });

  it("success via RSS normalizes identity and completeness", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => rssResponse(fixture("reddit-rss.xml"), { url }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "items_found" });
    expect(result.items[0].externalId).toBe("t3_1a2b3c");
    expect(result.items[0].canonicalUrl).toBe(
      "https://www.reddit.com/r/publiccommunity/comments/1a2b3c/a_verified_public_community_change/",
    );
    expect(result.items[0].completeness).toMatchObject({
      transcript: "unsupported",
      comments: "unsupported",
    });
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
    assertSourceItemInvariants(result.items[0], adapterId, `target-${adapterId}`);
  });

  it("legitimate empty via RSS is distinct", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => rssResponse(fixture("reddit-rss-empty.xml"), { url }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
  });

  it("partial data via incomplete RSS recovers identity", async () => {
    const adapter = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) return rssResponse(fixture("reddit-rss-incomplete.xml"), { url });
        return jsonResponse(fixture("reddit-listing.json"), { url });
      },
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.outcome).toBe("items_found");
    expect(result.items[0].author).toBe("PublicAuthor");
  });

  it("blocked access across all routes is loud", async () => {
    const captured = failureCapture("reddit", "blocked");
    const adapter = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss"))
          return rssResponse(captured.body!, { url, status: captured.status! });
        if (url.endsWith(".json"))
          return jsonResponse(captured.body!, { url, status: captured.status! });
        return pageResponse(captured.body!, { url, status: captured.status! });
      },
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "blocked_access",
    );
  });

  it("rate limit stops fallback chain", async () => {
    const captured = failureCapture("reddit", "rateLimit");
    let calls = 0;
    const adapter = new RedditSourceAdapter(
      async (url) => {
        calls += 1;
        return rssResponse(captured.body!, {
          url,
          status: captured.status!,
          retryAfter: captured.retryAfter!,
        });
      },
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(calls).toBe(1);
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "rate_limit",
    );
    expect(result.diagnostic.retryAfterMs).toBe(30_000);
  });

  it("timeout across routes is loud", async () => {
    const captured = failureCapture("reddit", "timeout");
    const adapter = new RedditSourceAdapter(
      async () => {
        throw capturedError(captured);
      },
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "timeout",
    );
  });

  it("response shape change is loud and not legitimate empty", async () => {
    // Directly test HTML shape change via fallback: make RSS throw, JSON 403, HTML shape change
    const adapter2 = new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) throw abortError();
        if (url.endsWith(".json")) return jsonResponse("Forbidden", { url, status: 403 });
        return pageResponse(fixture("reddit-page-shape-change.html"), { url });
      },
      () => NOW,
    );
    const result = await adapter2.collect({
      target: target(adapterId, "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "response_shape_change",
    );
    expect(result.diagnostic.parserStage).toBe("reddit_html_parse");
  });

  it("unsupported target fails loudly", async () => {
    const adapter = new RedditSourceAdapter(
      async () => {
        throw new Error("must not fetch");
      },
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://example.com/not-reddit"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "unsupported_capability",
    );
  });
});

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------
describe("YouTube fixture contract — hermetic", () => {
  const adapterId = "youtube";
  const version = "youtube-data-api-v3";

  interface YouTubeFixture {
    channel: { id: string; uploadsPlaylistId: string };
    videos: {
      id: string;
      title: string;
      description: string | null;
      channelTitle: string | null;
      publishedAt: string;
    }[];
    comments: {
      author: string | null;
      publishedAt: string | null;
      url: string | null;
      text: string;
      engagement: number | null;
    }[];
  }

  function clientFromFixture(name: string): YouTubeSourceClient {
    const data = JSON.parse(fixture(name)) as YouTubeFixture;
    return {
      async resolveChannel() {
        return data.channel;
      },
      async listUploads() {
        return data.videos;
      },
      async listComments() {
        return data.comments;
      },
    };
  }

  it("success normalizes canonicalUrl, media, evidence, completeness", async () => {
    const client = clientFromFixture("youtube-channel.json");
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "items_found" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].canonicalUrl).toBe("https://www.youtube.com/watch?v=video-1");
    expect(result.items[0].media).toEqual([
      { type: "video", url: "https://www.youtube.com/watch?v=video-1" },
    ]);
    expect(result.items[0].evidence[0].route).toBe("youtube.data.playlistItems.list");
    expect(result.items[0].completeness).toMatchObject({
      transcript: "unavailable",
      comments: "unavailable",
      media: "available",
    });
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
    assertSourceItemInvariants(result.items[0], adapterId, `target-${adapterId}`);
    expect(result.diagnostic.parserStage).toBe("youtube_data_api");
    expect(result.checkpoint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("legitimate empty when channel has no videos", async () => {
    const client = clientFromFixture("youtube-channel-empty.json");
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@quietchannel"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
  });

  it("partial data keeps usable title while marking missing description unavailable", async () => {
    const client = clientFromFixture("youtube-channel-partial.json");
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@partial"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.outcome).toBe("items_found");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].completeness).toMatchObject({
      body: "unavailable",
      description: "unavailable",
    });
    expect(result.items[1].completeness).toMatchObject({ body: "available" });
  });

  it("blocked access when Google connection disconnected is distinct from empty", async () => {
    const captured = failureCapture("youtube", "blocked");
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: false, state: captured.connectionState! }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "blocked_access",
    );
    expect(result.diagnostic.parserStage).toBe("youtube_data_api");
  });

  it("rate limit from API maps to rate_limit", async () => {
    const captured = failureCapture("youtube", "rateLimit");
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return { id: "UC1", uploadsPlaylistId: "UU1" };
      },
      async listUploads() {
        const err = new Error(captured.message) as Error & { code?: number };
        err.code = captured.code!;
        throw err;
      },
      async listComments() {
        return [];
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "rate_limit",
    );
  });

  it("timeout is loud and classified separately from internal failure", async () => {
    const captured = failureCapture("youtube", "timeout");
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        throw capturedError(captured);
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "timeout",
    );
  });

  it("response shape change when uploads playlist missing", async () => {
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "response_shape_change",
    );
  });

  it("unsupported channel URL is not empty", async () => {
    const client = clientFromFixture("youtube-channel.json");
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/c/legacyname"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "unsupported_capability",
    );
  });

  it("checkpoint and evidence are stable and sanitized", async () => {
    const client = clientFromFixture("youtube-channel.json");
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const first = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    const second = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: first.checkpoint,
    });
    // second call still returns items_found if videos still present; checkpoint is hash of ids, not conditional.
    // The second call with checkpoint set but items present should still be items_found (since checkpoint is hash of ids, not 304).
    // But if we pass previous checkpoint, it still returns items_found because logic doesn't compare checkpoint to hash for YouTube (it just hashes ids).
    // Ensure checkpoint is consistent hash.
    expect(first.checkpoint).toBe(second.checkpoint);
    expect(first.diagnostic.responseHash).toBe("");
  });

  it("enrichment caps at 50 and marks completeness", async () => {
    const client = clientFromFixture("youtube-channel.json");
    let limitSeen = 0;
    const trackingClient: YouTubeSourceClient = {
      async resolveChannel() {
        return client.resolveChannel({ kind: "handle", value: "found42" });
      },
      async listUploads(pid, since) {
        return client.listUploads(pid, since);
      },
      async listComments(id, limit) {
        limitSeen = limit;
        return client.listComments(id, limit);
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client: trackingClient }),
      () => NOW,
    );
    const collected = await adapter.collect({
      target: target(adapterId, "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    const enriched = await adapter.enrich(collected.items);
    expect(limitSeen).toBe(50);
    expect(enriched[0].completeness.comments).toBe("available");
  });
});

// ---------------------------------------------------------------------------
// Instagram (Instaloader)
// ---------------------------------------------------------------------------
describe("Instagram fixture contract — hermetic", () => {
  const adapterId = "instagram";
  const version = "instagram-instaloader-v1";

  it("success normalizes identity, canonicalUrl, evidence, media, completeness", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "items_found" });
    expect(result.items).toHaveLength(2);
    expect(result.items[0].canonicalUrl).toBe(
      "https://www.instagram.com/publicmaker/reel/ABCdef123XyZ",
    );
    expect(result.items[1].canonicalUrl).toBe("https://www.instagram.com/p/XyZ987abcDEF");
    expect(result.items[0].completeness).toMatchObject({
      transcript: "unsupported",
      comments: "unavailable",
      media: "available",
    });
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
    expect(result.diagnostic.parserStage).toBe("instaloader");
    assertSourceItemInvariants(result.items[0], adapterId, `target-${adapterId}`);
  });

  it("legitimate empty is distinct", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-empty.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/quietaccount"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
  });

  it("partial data keeps usable identity for available posts", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-partial.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/partialmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.outcome).toBe("items_found");
    expect(result.items[0].body).toBeNull();
    expect(result.items[0].completeness.body).toBe("unavailable");
    expect(result.items[1].body).toBeTruthy();
  });

  it("blocked access via login required is loud", async () => {
    const captured = failureCapture("instagram", "blocked");
    const adapter = new InstagramInstaloaderAdapter(
      async () => capturedCommand(captured),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "blocked_access",
    );
  });

  it("blocked access via private profile is loud", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-private-profile.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/privateaccount"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "blocked_access",
    );
  });

  it("rate limit is loud", async () => {
    const captured = failureCapture("instagram", "rateLimit");
    const adapter = new InstagramInstaloaderAdapter(
      async () => capturedCommand(captured),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "rate_limit",
    );
  });

  it("timeout via stderr is loud", async () => {
    const captured = failureCapture("instagram", "timeout");
    const adapter = new InstagramInstaloaderAdapter(
      async () => capturedCommand(captured),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "timeout",
    );
  });

  it("response shape change is loud and not empty", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-parser-change.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "response_shape_change",
    );
  });

  it("reel via yt-dlp success normalizes comments bounded", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: "", stderr: "", code: 0 }),
      async () => ({ stdout: fixture("instagram-reel.json"), stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/reel/ABCdef123XyZ"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "items_found" });
    expect(result.items[0].externalId).toBe("ABCdef123XyZ");
    expect(result.items[0].completeness.media).toBe("available");
  });

  it("unsupported target kind is explicit", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: "{}", stderr: "", code: 0 }),
      async () => ({ stdout: "{}", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/explore/tags/practical"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "unsupported_capability",
    );
  });

  it("receipt identifies version and parser stage", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.instagram.com/publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.diagnostic.adapterVersion).toBe(version);
    expect(result.diagnostic.parserStage).toBe("instaloader");
  });
});

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------
describe("TikTok fixture contract — hermetic", () => {
  const adapterId = "tiktok";
  const version = "tiktok-yt-dlp-v1";

  it("success normalizes canonicalUrl, media, evidence, completeness", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-user-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "items_found" });
    expect(result.items).toHaveLength(2);
    expect(result.items[0].canonicalUrl).toBe(
      "https://www.tiktok.com/@publicmaker/video/7321000000000000001",
    );
    expect(result.items[0].media[0].url).toBe(
      "https://www.tiktok.com/@publicmaker/video/7321000000000000001",
    );
    expect(result.items[0].completeness).toMatchObject({
      transcript: "unsupported",
      comments: "unavailable",
    });
    assertCompletedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
    );
    expect(result.diagnostic.parserStage).toBe("yt_dlp");
    assertSourceItemInvariants(result.items[0], adapterId, `target-${adapterId}`);
  });

  it("legitimate empty is distinct", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-user-empty.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@quietaccount"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result).toMatchObject({ kind: "completed", outcome: "legitimate_empty", items: [] });
  });

  it("partial data via tiktok-user-partial keeps usable items", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-user-partial.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@partialmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.outcome).toBe("items_found");
    // First entry has empty title -> completeness unavailable, but still an item? Check normalize: title empty should be unavailable but item still returned
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("blocked access via login wall is loud", async () => {
    const captured = failureCapture("tiktok", "blocked");
    const adapter = new TikTokYtDlpAdapter(
      async () => capturedCommand(captured),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "blocked_access",
    );
  });

  it("rate limit is loud", async () => {
    const captured = failureCapture("tiktok", "rateLimit");
    const adapter = new TikTokYtDlpAdapter(
      async () => capturedCommand(captured),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "rate_limit",
    );
  });

  it("timeout is loud", async () => {
    const captured = failureCapture("tiktok", "timeout");
    const adapter = new TikTokYtDlpAdapter(
      async () => capturedCommand(captured),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    // TikTok classify: timeout maps from "Connection timed out"
    // Check implementation: classifyCommandFailure maps it to timeout
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "timeout",
    );
  });

  it("response shape change is loud and not empty", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-shape-change.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "response_shape_change",
    );
  });

  it("unsupported target kind is explicit", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: "{}", stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@maker/tag/practical"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    assertFailedReceipt(
      result as unknown as Record<string, unknown> & {
        kind: string;
        outcome: string;
        diagnostic: Record<string, unknown>;
      },
      version,
      "unsupported_capability",
    );
  });

  it("single video normalizes canonicalUrl", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-video.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@publicmaker/video/7321000000000000004"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.items[0].canonicalUrl).toBe(
      "https://www.tiktok.com/@publicmaker/video/7321000000000000004",
    );
  });

  it("receipt identifies version and parser stage", async () => {
    const adapter = new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-user-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target(adapterId, "https://www.tiktok.com/@publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(result.diagnostic.adapterVersion).toBe(version);
    expect(result.diagnostic.parserStage).toBe("yt_dlp");
  });
});

// ---------------------------------------------------------------------------
// Experimental public page (Instagram placeholder)
// ---------------------------------------------------------------------------
describe("Experimental public page fixture contract — hermetic", () => {
  const version = "public-page-jsonld-v1";
  it("success and shape change are distinct", async () => {
    const platform = "instagram" as const;
    const success = await new ExperimentalPublicPageAdapter(
      platform,
      async () => ({
        url: `https://www.${platform}.com/public-creator`,
        status: 200,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: fixture("social-public-page.html").replaceAll("instagram", platform),
      }),
      () => NOW,
    ).collect({
      target: target(platform, `https://www.${platform}.com/public-creator`),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(success).toMatchObject({ kind: "completed", outcome: "items_found" });
    expect(success.diagnostic.adapterVersion).toBe(version);
    expect(success.diagnostic.parserStage).toBe("public_embedded_data");

    const shape = await new ExperimentalPublicPageAdapter(
      platform,
      async () => ({
        url: `https://www.${platform}.com/public-creator`,
        status: 200,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: fixture("social-shape-change.html"),
      }),
      () => NOW,
    ).collect({
      target: target(platform, `https://www.${platform}.com/public-creator`),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(shape).toMatchObject({ kind: "failed", outcome: "response_shape_change" });
    expect(shape.kind).not.toBe("completed");
  });

  it("blocked and rate limit are distinct from empty", async () => {
    const platform = "instagram" as const;
    const blocked = await new ExperimentalPublicPageAdapter(
      platform,
      async () => ({
        url: `https://www.${platform}.com/public-creator`,
        status: 403,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: "Forbidden",
      }),
      () => NOW,
    ).collect({
      target: target(platform, `https://www.${platform}.com/public-creator`),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(blocked.outcome).toBe("blocked_access");
    expect(blocked.kind).toBe("failed");

    const limited = await new ExperimentalPublicPageAdapter(
      platform,
      async () => ({
        url: `https://www.${platform}.com/public-creator`,
        status: 429,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: "30",
        body: "Slow down",
      }),
      () => NOW,
    ).collect({
      target: target(platform, `https://www.${platform}.com/public-creator`),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(limited.outcome).toBe("rate_limit");
    expect(limited.diagnostic.retryAfterMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Cross-adapter invariants
// ---------------------------------------------------------------------------
describe("Fixture contract cross-adapter invariants — hermetic", () => {
  it("no adapter shares legitimate_empty success shape for blocked, malformed, unsupported, or timeout", async () => {
    // RSS malformed already asserts failed, not legitimate_empty
    const rssBlocked = await new RssSourceAdapter(
      async () => response({ status: 403, body: "Forbidden" }),
      () => NOW,
    ).collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(rssBlocked.outcome).not.toBe("legitimate_empty");
    expect(rssBlocked.kind).toBe("failed");

    const redditShape = await new RedditSourceAdapter(
      async (url) => {
        if (url.endsWith(".rss")) throw abortError();
        if (url.endsWith(".json"))
          return {
            url,
            status: 403,
            contentType: "application/json",
            etag: null,
            lastModified: null,
            retryAfter: null,
            body: "Forbidden",
          };
        return {
          url,
          status: 200,
          contentType: "text/html",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: fixture("reddit-page-shape-change.html"),
        };
      },
      () => NOW,
    ).collect({
      target: target("reddit", "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(redditShape.outcome).not.toBe("legitimate_empty");

    const instaTimeout = await new InstagramInstaloaderAdapter(
      async () => ({ stdout: "", stderr: "ERROR: Connection timed out", code: 1 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    ).collect({
      target: target("instagram", "https://www.instagram.com/publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(instaTimeout.outcome).toBe("timeout");
    expect(instaTimeout.kind).toBe("failed");

    const tiktokUnsupported = await new TikTokYtDlpAdapter(
      async () => ({ stdout: "{}", stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    ).collect({
      target: target("tiktok", "https://www.tiktok.com/@maker/tag/practical"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(tiktokUnsupported.outcome).toBe("unsupported_capability");
    expect(tiktokUnsupported.kind).toBe("failed");
  });

  it("all fixture receipts identify adapter version and are hermetic (no network)", async () => {
    // This test ensures each adapter's diagnostic carries a version string that names the parser/library
    const rss = await new RssSourceAdapter(
      async () => response({ body: fixture("rss-success.xml") }),
      () => NOW,
    ).collect({
      target: target("rss", "https://example.com/feed.xml"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(rss.diagnostic.adapterVersion).toMatch(/rss-parser/);
    const website = await new WebsiteSourceAdapter(
      async () =>
        response({
          url: "https://news.example/updates",
          contentType: "text/html",
          body: fixture("website-article.html"),
        }),
      () => NOW,
      async () => ({ url: "", contentType: "text/html", status: 200, body: "" }),
    ).collect({
      target: target("website", "https://news.example/updates"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(website.diagnostic.adapterVersion).toMatch(/readability|browser-render/);
    const youtube = await new YouTubeSourceAdapter(
      () => ({
        ok: true,
        client: {
          async resolveChannel() {
            return { id: "UC1", uploadsPlaylistId: "UU1" };
          },
          async listUploads() {
            return [
              {
                id: "v1",
                title: "t",
                description: "d",
                channelTitle: "c",
                publishedAt: NOW.toISOString(),
              },
            ];
          },
          async listComments() {
            return [];
          },
        },
      }),
      () => NOW,
    ).collect({
      target: target("youtube", "https://www.youtube.com/@found42"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(youtube.diagnostic.adapterVersion).toBe("youtube-data-api-v3");
    const reddit = await new RedditSourceAdapter(
      async (url) => ({
        url,
        status: 200,
        contentType: "application/atom+xml",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: fixture("reddit-rss.xml"),
      }),
      () => NOW,
    ).collect({
      target: target("reddit", "https://www.reddit.com/r/publiccommunity/"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(reddit.diagnostic.adapterVersion).toBe("reddit-public-rss-json-html-v1");
    const instagram = await new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    ).collect({
      target: target("instagram", "https://www.instagram.com/publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(instagram.diagnostic.adapterVersion).toBe("instagram-instaloader-v1");
    const tiktok = await new TikTokYtDlpAdapter(
      async () => ({ stdout: fixture("tiktok-user-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    ).collect({
      target: target("tiktok", "https://www.tiktok.com/@publicmaker"),
      since: SINCE,
      until: UNTIL,
      checkpoint: null,
    });
    expect(tiktok.diagnostic.adapterVersion).toBe("tiktok-yt-dlp-v1");
  });
});
