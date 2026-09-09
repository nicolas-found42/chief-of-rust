import { describe, expect, it } from "vitest";
import {
  sanitizeAdapterDiagnostic,
  sanitizeDiagnosticBody,
} from "../../../apps/server/src/source-adapters/diagnostics.js";
import { createPublicSearch } from "../../../apps/server/src/source-adapters/search.js";
import { createFeedDiscoverer } from "../../../apps/server/src/source-adapters/feeds.js";
import { failedResult } from "../../../apps/server/src/source-adapters/collection.js";
import type { SourceAdapter } from "../../../apps/server/src/source-adapters/source-adapter.js";

describe("Source Adapter diagnostics", () => {
  it("persists bounded diagnostics without public response content or route values", () => {
    const diagnostic = sanitizeAdapterDiagnostic(
      {
        classification: "parser_failure",
        route: "https://example.com/users/alice/feed?token=secret&q=launch",
        status: 200,
        contentType: "text/html; charset=utf-8",
        parserStage: "rss_parse",
        responseHash: "raw response",
        adapterVersion: "ignored",
        startedAt: "2026-08-31T12:00:00.000Z",
        finishedAt: "2026-08-31T12:00:01.000Z",
        retries: 0,
        affectedCapabilities: ["items"],
        causeChain: ["response body contained private response content"],
      },
      "rss@1",
    );

    expect(diagnostic.route).toMatch(
      /^https:\/\/example\.com\/\[segment;sha256:[a-f0-9]{12}\]\/\[segment;sha256:[a-f0-9]{12}\]\/feed\?redacted=&q=$/,
    );
    expect(diagnostic.contentType).toBe("text/html");
    expect(diagnostic.adapterVersion).toBe("rss@1");
    expect(diagnostic.causeChain[0]).toContain("private_response_redacted");
    expect(sanitizeDiagnosticBody("private response content")).toMatch(
      /^\[response body omitted; bytes:24; sha256:[a-f0-9]{64}\]$/,
    );
  });
});

describe("Source Adapter discovery", () => {
  it("returns bounded normalized results from anonymous public search", async () => {
    const search = createPublicSearch(async () => ({
      url: "https://html.duckduckgo.com/html/",
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: `<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">Example article</a><span class="result__snippet">A useful public result.</span></div>`,
    }));

    await expect(search("example")).resolves.toMatchObject([
      {
        title: "Example article",
        url: "https://example.com/article",
        snippet: "A useful public result.",
      },
    ]);
  });

  it("discovers only feeds declared by a public site", async () => {
    const discoverFeeds = createFeedDiscoverer(async () => ({
      url: "https://example.com/",
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Example feed"></head></html>`,
    }));

    await expect(discoverFeeds("https://example.com/")).resolves.toMatchObject([
      { url: "https://example.com/feed.xml", title: "Example feed" },
    ]);
  });

  it("classifies an unavailable adapter through the shared collection contract", () => {
    const adapter: SourceAdapter = {
      id: "future-network",
      state: "coming_later",
      version: "1",
      supports: () => false,
      collect: async () => {
        throw new Error("not available");
      },
    };

    expect(
      failedResult({
        target: {
          id: "target-1",
          adapterId: adapter.id,
          label: "Future network",
          url: "https://example.com/public-feed",
          state: "active",
          createdAt: "2026-08-31T12:00:00.000Z",
          archivedAt: null,
          checkpoint: null,
          lastSuccessfulAt: null,
          conditional: null,
        },
        adapter,
        startedAt: "2026-08-31T12:00:00.000Z",
        finishedAt: "2026-08-31T12:00:01.000Z",
        outcome: "unsupported_capability",
        cause: "This Source Adapter has no approved collection route.",
      }),
    ).toMatchObject({
      kind: "failed",
      outcome: "unsupported_capability",
      items: [],
      checkpoint: null,
      diagnostic: {
        route: "https://example.com/",
        adapterVersion: "1",
        affectedCapabilities: [],
      },
    });
  });
});
