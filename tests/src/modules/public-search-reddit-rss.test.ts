import { describe, expect, it } from "vitest";
import { createRedditRssProvider } from "../../../apps/server/src/source-adapters/providers/reddit-rss";
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
      contentType: "application/atom+xml",
      etag: null,
      lastModified: null,
      retryAfter,
      body,
    };
    return response;
  };
  return { fetch, urls };
}

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Backpressure in Node streams</title>
    <link href="https://www.reddit.com/r/node/comments/abc1/backpressure_in_node_streams/"/>
    <content type="html">&lt;p&gt;How do I handle slow consumers?&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Second post</title>
    <link href="https://www.reddit.com/r/typescript/comments/def2/second_post/"/>
  </entry>
</feed>`;

describe("createRedditRssProvider", () => {
  it("maps Atom entries to results, stripping content markup into the snippet", async () => {
    const { fetch, urls } = fetchAnswering(200, ATOM_FIXTURE);
    const results = await createRedditRssProvider().search("node streams", {
      fetch,
      timeoutMs: 5_000,
    } satisfies SearchProviderIo);
    expect(urls).toEqual(["https://www.reddit.com/search.rss?q=node%20streams&sort=new"]);
    expect(results).toEqual([
      {
        title: "Backpressure in Node streams",
        url: "https://www.reddit.com/r/node/comments/abc1/backpressure_in_node_streams/",
        snippet: "How do I handle slow consumers?",
      },
      {
        title: "Second post",
        url: "https://www.reddit.com/r/typescript/comments/def2/second_post/",
        snippet: "",
      },
    ]);
  });

  it("refuses HTTP 403 as rate-limited and honors Retry-After", async () => {
    const { fetch } = fetchAnswering(403, "", "30");
    const error = await refused(createRedditRssProvider().search("q", { fetch, timeoutMs: 5_000 }));
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAfterMs).toBe(30_000);
  });

  it("refuses HTTP 429 as rate-limited too", async () => {
    const { fetch } = fetchAnswering(429, "");
    const error = await refused(createRedditRssProvider().search("q", { fetch, timeoutMs: 5_000 }));
    expect(error.reason).toBe("rate-limited");
  });

  it("refuses other non-200 answers as errors", async () => {
    const { fetch } = fetchAnswering(500, "boom");
    const error = await refused(createRedditRssProvider().search("q", { fetch, timeoutMs: 5_000 }));
    expect(error.reason).toBe("error");
  });

  it("refuses a 200 that is not a parsable feed", async () => {
    const { fetch } = fetchAnswering(200, "<html>please solve this captcha</html>");
    const error = await refused(createRedditRssProvider().search("q", { fetch, timeoutMs: 5_000 }));
    expect(error.reason).toBe("error");
  });

  it("answers a feed with no entries with []", async () => {
    const { fetch } = fetchAnswering(
      200,
      `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
    );
    await expect(
      createRedditRssProvider().search("q", { fetch, timeoutMs: 5_000 }),
    ).resolves.toEqual([]);
  });
});
