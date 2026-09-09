import { describe, expect, it } from "vitest";
import { createDuckDuckGoProvider } from "../../../apps/server/src/source-adapters/providers/duckduckgo";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";

type RecordedCall = {
  url: string;
  timeoutMs: number | undefined;
  method: string | undefined;
  body: string | undefined;
};

function respondWith(status: number, body: string) {
  const calls: RecordedCall[] = [];
  const fetch = async (
    url: string,
    options?: { timeoutMs?: number; method?: string; body?: string },
  ): Promise<PublicHttpResponse> => {
    calls.push({
      url,
      timeoutMs: options?.timeoutMs,
      method: options?.method,
      body: options?.body,
    });
    return {
      url,
      status,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    };
  };
  return { fetch, calls };
}

const RESULT_PAGE = `<html><body>
<div class="result">
  <a class="result__a" href="https://example.com/ada">Ada Lovelace</a>
  <a class="result__snippet">Pioneer of computing.</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fredirected">Redirected</a>
  <a class="result__snippet">Unwrapped from the uddg hop.</a>
</div>
</body></html>`;

const IO: SearchProviderIo = {
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
  timeoutMs: 10_000,
};

describe("createDuckDuckGoProvider", () => {
  it("posts the query to the html route and unwraps result links", async () => {
    const { fetch, calls } = respondWith(200, RESULT_PAGE);
    const provider = createDuckDuckGoProvider({ fetch });

    const results = await provider.search("ada lovelace", IO);

    expect(calls[0]?.url).toBe("https://html.duckduckgo.com/html/");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe("q=ada+lovelace");
    expect(results).toEqual([
      { title: "Ada Lovelace", url: "https://example.com/ada", snippet: "Pioneer of computing." },
      {
        title: "Redirected",
        url: "https://example.com/redirected",
        snippet: "Unwrapped from the uddg hop.",
      },
    ]);
  });

  it("posts to a custom endpoint while the query still rides the body", async () => {
    const { fetch, calls } = respondWith(200, RESULT_PAGE);
    const provider = createDuckDuckGoProvider({
      fetch,
      endpoint: (query) => `https://ddg.test/search?q=${encodeURIComponent(query)}`,
    });

    await provider.search("custom query", IO);

    expect(calls[0]?.url).toBe("https://ddg.test/search?q=custom%20query");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe("q=custom+query");
  });

  it("classifies a 202 as a captcha refusal", async () => {
    const { fetch } = respondWith(202, "challenge page");
    const provider = createDuckDuckGoProvider({ fetch });
    const refusal = await provider.search("x", IO).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("captcha");
  });

  it("classifies a 429 as rate-limited and carries Retry-After", async () => {
    const calls: RecordedCall[] = [];
    const fetch = async (url: string): Promise<PublicHttpResponse> => {
      calls.push({ url, timeoutMs: undefined, method: undefined, body: undefined });
      return {
        url,
        status: 429,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: "120",
        body: "slow down",
      };
    };
    const provider = createDuckDuckGoProvider({ fetch });
    const refusal = await provider.search("x", IO).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("rate-limited");
    expect((refusal as ProviderRefusedError).retryAfterMs).toBe(120_000);
  });
});
