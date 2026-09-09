import { describe, expect, it } from "vitest";
import { createIaTvNewsProvider } from "../../../apps/server/src/source-adapters/providers/ia-tvnews";
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
  response: {
    numFound: 2,
    docs: [
      {
        identifier: "example-broadcast-1970",
        title: ["Evening Broadcast — 1970-03-05"],
        description: ["Segment mentioning the person.", "Second caption line."],
      },
      { identifier: "second-broadcast", title: "Morning News", description: "One caption line." },
      { title: "No identifier, dropped" },
    ],
  },
});

const IO: SearchProviderIo = {
  fetch: async () => {
    throw new Error("test transport should not be called");
  },
  timeoutMs: 10_000,
};

describe("createIaTvNewsProvider", () => {
  it("scopes the query to the tvarchive collection and maps the documents", async () => {
    const { fetch, calls } = respondWith(200, FIXTURE);
    const provider = createIaTvNewsProvider();

    const results = await provider.search("ada lovelace", { ...IO, fetch });

    expect(calls[0]?.url).toBe(
      "https://archive.org/advancedsearch.php?q=collection%3A%22tvarchive%22+AND+%22ada%20lovelace%22" +
        "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&rows=8&output=json",
    );
    // The archive.org metadata model wraps scalar fields in a one-element
    // array, so text fields arrive array-joined.
    expect(results).toEqual([
      {
        title: "Evening Broadcast — 1970-03-05",
        url: "https://archive.org/details/example-broadcast-1970",
        snippet: "Segment mentioning the person. Second caption line.",
      },
      {
        title: "Morning News",
        url: "https://archive.org/details/second-broadcast",
        snippet: "One caption line.",
      },
    ]);
  });

  it("caps the document list at eight results", async () => {
    const docs = Array.from({ length: 12 }, (_, index) => ({
      identifier: `broadcast-${String(index)}`,
      title: `Broadcast ${String(index)}`,
    }));
    const { fetch } = respondWith(200, JSON.stringify({ response: { docs } }));
    const provider = createIaTvNewsProvider();

    const results = await provider.search("ada", { ...IO, fetch });

    expect(results).toHaveLength(8);
  });

  it("classifies a non-200 as an error refusal", async () => {
    const { fetch } = respondWith(500, "server error");
    const provider = createIaTvNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "error",
    });
  });

  it("classifies a 503 as rate-limited and carries Retry-After", async () => {
    const { fetch } = respondWith(503, "slow down", { retryAfter: "60" });
    const provider = createIaTvNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "rate-limited",
      retryAfterMs: 60_000,
    });
  });

  it("classifies an unparseable 200 body as an error refusal", async () => {
    const { fetch } = respondWith(200, "<not json");
    const provider = createIaTvNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toBeInstanceOf(
      ProviderRefusedError,
    );
    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      reason: "error",
    });
  });

  it("classifies a 200 body without the document list as an error refusal", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ response: {} }));
    const provider = createIaTvNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).rejects.toMatchObject({
      reason: "error",
    });
  });

  it("answers a clean 200 with no documents as []", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ response: { docs: [] } }));
    const provider = createIaTvNewsProvider();

    await expect(provider.search("ada", { ...IO, fetch })).resolves.toEqual([]);
  });
  it("sends co-mention boolean queries verbatim instead of re-wrapping them", async () => {
    const { fetch, calls } = respondWith(
      200,
      JSON.stringify({ response: { numFound: 0, docs: [] } }),
    );
    const provider = createIaTvNewsProvider();

    await provider.search('"Grace Hopper" interview OR podcast', { ...IO, fetch });

    expect(calls[0]?.url).toBe(
      "https://archive.org/advancedsearch.php?q=collection%3A%22tvarchive%22+AND+%22Grace%20Hopper%22%20interview%20OR%20podcast" +
        "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&rows=8&output=json",
    );
  });
});
