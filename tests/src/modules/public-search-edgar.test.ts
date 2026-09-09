import { afterEach, describe, expect, it, vi } from "vitest";
import { createEdgarProvider } from "../../../apps/server/src/source-adapters/providers/edgar";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";

const io = {
  timeoutMs: 5_000,
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
};

// The declared-contact UA is the provider's whole access model, so these tests
// ride the real curated transport (createHttpFetch) and stub the global fetch
// it sits on — the injected-fetch pattern alone would bypass the header binding.
type CapturedRequest = { url: string; userAgent: string | undefined; accept: string | undefined };

function stubGlobalFetch(status: number, body: string) {
  const captured: CapturedRequest[] = [];
  const stub = vi.fn(async (input: string | URL, init?: { headers?: HeadersInit }) => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: typeof input === "string" ? input : input.toString(),
      userAgent: headers.get("user-agent") ?? undefined,
      accept: headers.get("accept") ?? undefined,
    });
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return captured;
}

function respondWith(status: number, body: string) {
  return async (url: string): Promise<PublicHttpResponse> => ({
    url,
    status,
    contentType: "application/json",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createEdgarProvider", () => {
  it("sends the declared-contact user agent from the contract", async () => {
    const captured = stubGlobalFetch(200, JSON.stringify({ hits: { hits: [] } }));
    const provider = createEdgarProvider();
    await provider.search("apple inc", io);
    expect(captured[0]?.url).toBe(
      "https://efts.sec.gov/LATEST/search-index?q=%22apple%20inc%22&forms=10-K",
    );
    expect(captured[0]?.userAgent).toBe(
      "Found42-Content-Scout/1.0 (public-source-monitor; contact: owner@found42.local)",
    );
    expect(captured[0]?.accept).toBe("application/json");
  });

  it("maps the Elasticsearch-shaped fixture to filing results", async () => {
    const body = JSON.stringify({
      hits: {
        hits: [
          {
            _id: "0000320193-24-000123:aapl-20240928.htm",
            _source: {
              display_names: ["Apple Inc.", "AAPL", "0000320193"],
              biz_locations: ["CUPERTINO, CA 95014"],
            },
          },
          {
            _id: "0000320193-23-000106:aapl-20230930.htm",
            _source: { display_names: ["Apple Inc."], biz_locations: [] },
          },
        ],
      },
    });
    const provider = createEdgarProvider({ fetch: respondWith(200, body) });
    await expect(provider.search("apple", io)).resolves.toEqual([
      {
        title: "Apple Inc.",
        url: "https://www.sec.gov/Archives/edgar/data/000032019324000123/aapl-20240928.htm",
        snippet: "AAPL; 0000320193; CUPERTINO, CA 95014",
      },
      {
        title: "Apple Inc.",
        snippet: "",
        url: "https://www.sec.gov/Archives/edgar/data/000032019323000106/aapl-20230930.htm",
      },
    ]);
  });

  it("refuses a 403 as an error — EDGAR 403s generic user agents", async () => {
    stubGlobalFetch(403, "Access denied");
    const provider = createEdgarProvider();
    const refusal = await provider.search("apple", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 429 as rate-limited and carries Retry-After", async () => {
    const provider = createEdgarProvider({
      fetch: async (url) => ({
        url,
        status: 429,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: "120",
        body: "slow down",
      }),
    });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("rate-limited");
    expect((refusal as ProviderRefusedError).retryAfterMs).toBe(120_000);
  });

  it("refuses a 200 body that is not JSON", async () => {
    const provider = createEdgarProvider({ fetch: respondWith(200, "<html>nope</html>") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 with an unexpected shape", async () => {
    const provider = createEdgarProvider({
      fetch: respondWith(200, JSON.stringify({ status: 0 })),
    });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean empty hit list with []", async () => {
    const provider = createEdgarProvider({
      fetch: respondWith(200, JSON.stringify({ hits: { hits: [] } })),
    });
    await expect(provider.search("unknown company", io)).resolves.toEqual([]);
  });

  it("drops entries without a filing URL instead of inventing one", async () => {
    const body = JSON.stringify({
      hits: { hits: [{ _source: { display_names: ["No Id Inc."] } }] },
    });
    const provider = createEdgarProvider({ fetch: respondWith(200, body) });
    await expect(provider.search("x", io)).resolves.toEqual([]);
  });
});
