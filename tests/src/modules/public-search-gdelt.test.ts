import { describe, expect, it } from "vitest";
import { createGdeltProvider } from "../../../apps/server/src/source-adapters/providers/gdelt";
import {
  ProviderRefusedError,
  type SearchProviderIo,
} from "../../../apps/server/src/source-adapters/providers/types";

type RecordedCall = { url: string; timeoutMs: number | undefined };

function respondWith(status: number, body: string, headers: { retryAfter?: string } = {}) {
  const calls: RecordedCall[] = [];
  const fetch = async (
    url: string,
    options?: { timeoutMs?: number },
  ): Promise<{
    url: string;
    status: number;
    contentType: string | null;
    etag: null;
    lastModified: null;
    retryAfter: string | null;
    body: string;
  }> => {
    calls.push({ url, timeoutMs: options?.timeoutMs });
    return {
      url,
      status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter: headers.retryAfter ?? null,
      body,
    };
  };
  return { fetch, calls };
}

const FIXTURE = JSON.stringify({
  articles: [
    {
      url: "https://example.com/news/ada-mentioned",
      title: "Ada Lovelace named in keynote",
      seendate: "20260901T120000Z",
      domain: "example.com",
      sourcecountry: "US",
    },
    {
      url: "not a url at all",
      title: "unusable entry is dropped",
      seendate: "20260901T120100Z",
      domain: "example.org",
      sourcecountry: "GB",
    },
    {
      url: "https://example.org/second",
      title: "",
      seendate: "20260901T120200Z",
      domain: "example.org",
      sourcecountry: "GB",
    },
  ],
});

const IO: SearchProviderIo = {
  fetch: async () => {
    throw new Error("test transport should not be called");
  },
  timeoutMs: 10_000,
};

describe("createGdeltProvider", () => {
  it("maps the artlist articles and drops URL-less entries", async () => {
    const { fetch } = respondWith(200, FIXTURE);
    const provider = createGdeltProvider();

    const results = await provider.search("ada lovelace", { ...IO, fetch });

    expect(results).toEqual([
      {
        title: "Ada Lovelace named in keynote",
        url: "https://example.com/news/ada-mentioned",
        snippet: "",
      },
      {
        title: "",
        url: "https://example.org/second",
        snippet: "",
      },
    ]);
  });

  it("overrides the composite deadline with the documented 90 s budget", async () => {
    // GDELT answered probes in 15–75 s, past the composite's default deadline.
    const { fetch, calls } = respondWith(200, FIXTURE);
    const provider = createGdeltProvider();

    await provider.search("ada lovelace", { ...IO, fetch });

    expect(calls[0]?.timeoutMs).toBe(90_000);
  });

  it("requests the DOC artlist endpoint with the encoded query", async () => {
    const { fetch, calls } = respondWith(200, FIXTURE);
    const provider = createGdeltProvider();

    await provider.search("ada lovelace", { ...IO, fetch });

    expect(calls[0]?.url).toBe(
      "https://api.gdeltproject.org/api/v2/doc/doc?query=ada%20lovelace&mode=artlist&format=json&maxrecords=25",
    );
  });

  it("caps the merged list at eight results", async () => {
    const articles = Array.from({ length: 12 }, (_, index) => ({
      url: `https://example.com/${String(index)}`,
      title: `Article ${String(index)}`,
    }));
    const { fetch } = respondWith(200, JSON.stringify({ articles }));
    const provider = createGdeltProvider();

    const results = await provider.search("ada", { ...IO, fetch });

    expect(results).toHaveLength(8);
  });

  it("classifies a non-200 as an error refusal", async () => {
    const { fetch } = respondWith(500, "internal error");
    const provider = createGdeltProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "error",
    });
  });

  it("classifies a 429 as rate-limited and carries Retry-After", async () => {
    const { fetch } = respondWith(429, "too fast", { retryAfter: "5" });
    const provider = createGdeltProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "rate-limited",
      retryAfterMs: 5_000,
    });
  });

  it("classifies a 200 plain-text error body as an error refusal", async () => {
    // GDELT answers 200 with a plain-text message on bad input; that must
    // read as a failed query, not as "no coverage found".
    const { fetch } = respondWith(200, "query was too short to process");
    const provider = createGdeltProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toBeInstanceOf(
      ProviderRefusedError,
    );
    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      reason: "error",
    });
  });

  it("classifies a 200 JSON body without the article list as an error refusal", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ unrelated: true }));
    const provider = createGdeltProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      reason: "error",
    });
  });

  it("answers a clean 200 with no articles as []", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ articles: [] }));
    const provider = createGdeltProvider();

    await expect(provider.search("ada", { ...IO, fetch })).resolves.toEqual([]);
  });
});
