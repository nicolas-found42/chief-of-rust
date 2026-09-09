import { describe, expect, it } from "vitest";
import { createArcticShiftProvider } from "../../../apps/server/src/source-adapters/providers/arctic-shift";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";

async function refused(promise: Promise<unknown>): Promise<ProviderRefusedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderRefusedError) return error;
    throw error;
  }
  throw new Error("expected the provider to refuse");
}

function fetchAnswering(
  status: number,
  body: string,
  retryAfter: string | null = null,
): { fetch: PublicHttpFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: PublicHttpFetch = async (url) => {
    urls.push(url);
    const response: PublicHttpResponse = {
      url,
      status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter,
      body,
    };
    return response;
  };
  return { fetch, urls };
}

describe("createArcticShiftProvider", () => {
  it("searches the subreddit's posts for an r/ query", async () => {
    const body = JSON.stringify({
      data: [
        {
          title: "Stream backpressure",
          permalink: "/r/node/comments/abc1/stream_backpressure/",
          selftext: "How do I handle slow consumers?",
          id: "abc1",
        },
      ],
    });
    const { fetch, urls } = fetchAnswering(200, body);
    const results = await createArcticShiftProvider().search("r/node streams backpressure", {
      fetch,
      timeoutMs: 5_000,
    } satisfies SearchProviderIo);
    expect(urls).toEqual([
      "https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=node&query=streams%20backpressure&limit=8&fields=title,permalink,selftext,id",
    ]);
    expect(results).toEqual([
      {
        title: "Stream backpressure",
        url: "https://www.reddit.com/r/node/comments/abc1/stream_backpressure/",
        snippet: "How do I handle slow consumers?",
      },
    ]);
  });

  it("searches the author's posts for a u/ query, falling back to the id route", async () => {
    const body = JSON.stringify({ data: [{ title: "AMA results", id: "def2" }] });
    const { fetch, urls } = fetchAnswering(200, body);
    const results = await createArcticShiftProvider().search("u/spez ama", {
      fetch,
      timeoutMs: 5_000,
    });
    expect(urls).toEqual([
      "https://arctic-shift.photon-reddit.com/api/posts/search?author=spez&query=ama&limit=8&fields=title,permalink,selftext,id",
    ]);
    expect(results).toEqual([
      { title: "AMA results", url: "https://www.reddit.com/comments/def2", snippet: "" },
    ]);
  });

  it("answers an unscoped query with [] without touching the network", async () => {
    const { fetch, urls } = fetchAnswering(200, JSON.stringify({ data: [] }));
    await expect(
      createArcticShiftProvider().search("just some keywords", { fetch, timeoutMs: 5_000 }),
    ).resolves.toEqual([]);
    expect(urls).toEqual([]);
  });

  it("refuses HTTP 429 as rate-limited", async () => {
    const { fetch } = fetchAnswering(429, "");
    const error = await refused(
      createArcticShiftProvider().search("r/node streams", { fetch, timeoutMs: 5_000 }),
    );
    expect(error.reason).toBe("rate-limited");
  });

  it("refuses a 200 that is not a posts body", async () => {
    const { fetch } = fetchAnswering(200, "not json");
    const error = await refused(
      createArcticShiftProvider().search("r/node streams", { fetch, timeoutMs: 5_000 }),
    );
    expect(error.reason).toBe("error");
  });

  it("answers an empty archive with []", async () => {
    const { fetch } = fetchAnswering(200, JSON.stringify({ data: [] }));
    await expect(
      createArcticShiftProvider().search("r/node streams", { fetch, timeoutMs: 5_000 }),
    ).resolves.toEqual([]);
  });
});
