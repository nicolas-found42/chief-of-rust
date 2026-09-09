import { describe, expect, it } from "vitest";
import { createSearxngProvider } from "../../../apps/server/src/source-adapters/providers/searxng";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";

const IO = {
  timeoutMs: 10_000,
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
};

function respondWith(status: number, body: string, retryAfter: string | null = null) {
  const calls: Array<{ url: string; options: unknown }> = [];
  const fetch = async (url: string, options?: unknown) => {
    calls.push({ url, options });
    return {
      url,
      status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter,
      body,
    };
  };
  return { fetch, calls };
}

const FIXTURE = {
  query: "solar",
  results: [
    {
      url: "https://en.wikipedia.org/wiki/Solar_power",
      title: "Solar power - Wikipedia",
      content: "Solar power converts sunlight into electricity.",
    },
    { url: "not a url", title: "Dropped", content: "no usable URL" },
    {
      url: "ftp://example.org/file",
      title: "Dropped too",
      content: "non-http URL",
    },
  ],
  unresponsive_engines: [],
};

describe("createSearxngProvider", () => {
  it("maps fixture results and drops entries without a usable http(s) URL", async () => {
    const { fetch } = respondWith(200, JSON.stringify(FIXTURE));
    const provider = createSearxngProvider({ baseUrl: "http://searxng:8080", fetch });

    const results = await provider.search("solar", IO);

    expect(results).toEqual([
      {
        title: "Solar power - Wikipedia",
        url: "https://en.wikipedia.org/wiki/Solar_power",
        snippet: "Solar power converts sunlight into electricity.",
      },
    ]);
  });

  it("requests the configured instance's JSON endpoint through the injected fetch", async () => {
    const { fetch, calls } = respondWith(200, JSON.stringify({ results: [] }));
    const provider = createSearxngProvider({ baseUrl: "http://searxng:8080/", fetch });

    await provider.search("cold fusion", IO);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://searxng:8080/search?q=cold%20fusion&format=json");
    expect(calls[0].options).toEqual({ timeoutMs: IO.timeoutMs });
  });

  it("returns [] even when engines were unresponsive server-side", async () => {
    const { fetch } = respondWith(
      200,
      JSON.stringify({ results: [], unresponsive_engines: ["google", "bing"] }),
    );
    const provider = createSearxngProvider({ baseUrl: "http://searxng:8080", fetch });

    await expect(provider.search("anything", IO)).resolves.toEqual([]);
  });

  it("classifies a 403 (JSON format disabled) as an error refusal", async () => {
    const { fetch } = respondWith(403, "Forbidden");
    const provider = createSearxngProvider({ baseUrl: "http://searxng:8080", fetch });

    await expect(provider.search("anything", IO)).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "error",
    });
  });

  it("classifies an unparseable 200 body as an error refusal", async () => {
    const { fetch } = respondWith(200, "<html>not json</html>");
    const provider = createSearxngProvider({ baseUrl: "http://searxng:8080", fetch });

    const error = await provider.search("anything", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });
});
