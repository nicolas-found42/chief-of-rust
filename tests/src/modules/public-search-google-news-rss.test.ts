import { describe, expect, it } from "vitest";
import { createGoogleNewsProvider } from "../../../apps/server/src/source-adapters/providers/google-news-rss";
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
      contentType: "application/atom+xml",
      etag: null,
      lastModified: null,
      retryAfter: headers.retryAfter ?? null,
      body,
    };
  };
  return { fetch, calls };
}

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ada lovelace - Google News</title>
  <entry>
    <title>Keynote names Ada Lovelace</title>
    <link href="https://news.google.com/rss/articles/CBMiKGtleW5vdGU?oc=5" />
    <id>https://news.google.com/rss/articles/CBMiKGtleW5vdGU?oc=5</id>
  </entry>
  <entry>
    <title>Second story</title>
    <link href="https://news.google.com/rss/articles/CBMiKHNlY29uZA?oc=5" />
    <id>https://news.google.com/rss/articles/CBMiKHNlY29uZA?oc=5</id>
    <content>Second story body.</content>
  </entry>
  <entry>
    <title>No usable link</title>
    <id>urn:uuid:not-a-url</id>
  </entry>
</feed>`;

const IO: SearchProviderIo = {
  fetch: async () => {
    throw new Error("test transport should not be called");
  },
  timeoutMs: 10_000,
};

describe("createGoogleNewsProvider", () => {
  it("maps the Atom entries and keeps redirect-wrapped links as-is", async () => {
    const { fetch } = respondWith(200, FIXTURE);
    const provider = createGoogleNewsProvider();

    const results = await provider.search("ada lovelace", { ...IO, fetch });

    expect(results).toEqual([
      {
        title: "Keynote names Ada Lovelace",
        url: "https://news.google.com/rss/articles/CBMiKGtleW5vdGU?oc=5",
        snippet: "",
      },
      {
        title: "Second story",
        url: "https://news.google.com/rss/articles/CBMiKHNlY29uZA?oc=5",
        snippet: "Second story body.",
      },
    ]);
  });

  it("requests the Atom search route with the encoded query and US edition params", async () => {
    const { fetch, calls } = respondWith(200, FIXTURE);
    const provider = createGoogleNewsProvider();

    await provider.search("ada lovelace", { ...IO, fetch });

    expect(calls[0]?.url).toBe(
      "https://news.google.com/rss/search?q=ada%20lovelace&hl=en-US&gl=US&ceid=US:en",
    );
  });

  it("caps the feed at eight entries", async () => {
    const entries = Array.from(
      { length: 12 },
      (_, index) =>
        `<entry><title>Story ${String(index)}</title><link href="https://news.google.com/rss/articles/${String(index)}" /></entry>`,
    ).join("");
    const { fetch } = respondWith(
      200,
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>news</title>${entries}</feed>`,
    );
    const provider = createGoogleNewsProvider();

    const results = await provider.search("ada", { ...IO, fetch });

    expect(results).toHaveLength(8);
  });

  it("classifies a non-200 as an error refusal", async () => {
    const { fetch } = respondWith(500, "server error");
    const provider = createGoogleNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "error",
    });
  });

  it("classifies a 429 as rate-limited and carries Retry-After", async () => {
    const { fetch } = respondWith(429, "slow down", { retryAfter: "30" });
    const provider = createGoogleNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "rate-limited",
      retryAfterMs: 30_000,
    });
  });

  it("classifies a 200 HTML challenge page as an error refusal", async () => {
    // A 200 anti-bot challenge page is not XML; refusing keeps it from
    // reading as a clean empty pass.
    const { fetch } = respondWith(200, "<html><body>unusual traffic</body></html>");
    const provider = createGoogleNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toBeInstanceOf(
      ProviderRefusedError,
    );
    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      reason: "error",
    });
  });

  it("answers a feed with no entries as []", async () => {
    const { fetch } = respondWith(
      200,
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>news</title></feed>`,
    );
    const provider = createGoogleNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).resolves.toEqual([]);
  });
});
