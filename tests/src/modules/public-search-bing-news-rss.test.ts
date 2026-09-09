import { describe, expect, it } from "vitest";
import { createBingNewsProvider } from "../../../apps/server/src/source-adapters/providers/bing-news-rss";
import {
  ProviderRefusedError,
  type SearchProviderIo,
} from "../../../apps/server/src/source-adapters/providers/types";

type RecordedCall = { url: string; timeoutMs: number | undefined };

function respondWith(status: number, body: string, headers: { retryAfter?: string } = {}) {
  const calls: RecordedCall[] = [];
  const fetch = async (url: string, options?: { timeoutMs?: number }) => {
    calls.push({ url, timeoutMs: options?.timeoutMs });
    return {
      url,
      status,
      contentType: "application/rss+xml",
      etag: null,
      lastModified: null,
      retryAfter: headers.retryAfter ?? null,
      body,
    };
  };
  return { fetch, calls };
}

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>ada lovelace - News</title>
    <item>
      <title>Keynote names Ada Lovelace</title>
      <link>https://example.com/news/keynote</link>
      <guid>https://example.com/news/keynote</guid>
      <description>A keynote cited &lt;b&gt;Ada Lovelace&lt;/b&gt; twice.</description>
    </item>
    <item>
      <title>Guid-only entry</title>
      <guid>https://example.com/news/guid-only</guid>
      <description>Second story body.</description>
    </item>
    <item>
      <title>No usable link</title>
      <link>relative/not-a-url</link>
      <description>Dropped entry.</description>
    </item>
  </channel>
</rss>`;

const IO: SearchProviderIo = {
  fetch: async () => {
    throw new Error("test transport should not be called");
  },
  timeoutMs: 10_000,
};

describe("createBingNewsProvider", () => {
  it("maps the RSS items, falls back to the guid, and strips snippet markup", async () => {
    const { fetch } = respondWith(200, FIXTURE);
    const provider = createBingNewsProvider();

    const results = await provider.search("ada lovelace", { ...IO, fetch });

    expect(results).toEqual([
      {
        title: "Keynote names Ada Lovelace",
        url: "https://example.com/news/keynote",
        snippet: "A keynote cited Ada Lovelace twice.",
      },
      {
        title: "Guid-only entry",
        url: "https://example.com/news/guid-only",
        snippet: "Second story body.",
      },
    ]);
  });

  it("requests the RSS route with the encoded query", async () => {
    const { fetch, calls } = respondWith(200, FIXTURE);
    const provider = createBingNewsProvider();

    await provider.search("ada lovelace", { ...IO, fetch });

    expect(calls[0]?.url).toBe("https://www.bing.com/news/search?q=ada%20lovelace&format=RSS");
  });

  it("caps the feed at eight items", async () => {
    const items = Array.from(
      { length: 12 },
      (_, index) =>
        `<item><title>Story ${String(index)}</title><link>https://example.com/${String(index)}</link></item>`,
    ).join("");
    const { fetch } = respondWith(
      200,
      `<?xml version="1.0"?><rss version="2.0"><channel><title>news</title>${items}</channel></rss>`,
    );
    const provider = createBingNewsProvider();

    const results = await provider.search("ada", { ...IO, fetch });

    expect(results).toHaveLength(8);
  });

  it("classifies a non-200 as an error refusal", async () => {
    const { fetch } = respondWith(500, "server error");
    const provider = createBingNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "error",
    });
  });

  it("classifies a 503 as rate-limited and carries Retry-After", async () => {
    const { fetch } = respondWith(503, "slow down", { retryAfter: "120" });
    const provider = createBingNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "rate-limited",
      retryAfterMs: 120_000,
    });
  });

  it("classifies a 200 HTML challenge page as an error refusal", async () => {
    // A 200 anti-bot challenge page is not XML; refusing keeps it from
    // reading as a clean empty pass.
    const { fetch } = respondWith(200, "<html><body>verify you are human</body></html>");
    const provider = createBingNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toBeInstanceOf(
      ProviderRefusedError,
    );
    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      reason: "error",
    });
  });

  it("answers a feed with no items as []", async () => {
    const { fetch } = respondWith(
      200,
      `<?xml version="1.0"?><rss version="2.0"><channel><title>news</title></channel></rss>`,
    );
    const provider = createBingNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).resolves.toEqual([]);
  });
});
