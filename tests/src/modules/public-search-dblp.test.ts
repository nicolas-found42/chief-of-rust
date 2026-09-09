import { describe, expect, it } from "vitest";
import { createDblpProvider } from "../../../apps/server/src/source-adapters/providers/dblp";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";

const io = {
  timeoutMs: 5_000,
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
};

function respondWith(status: number, body: string, calls: { url: string }[] = []) {
  return async (url: string): Promise<PublicHttpResponse> => {
    calls.push({ url });
    return {
      url,
      status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    };
  };
}

describe("createDblpProvider", () => {
  it("maps the publication fixture to normalized results", async () => {
    const body = JSON.stringify({
      result: {
        hits: {
          hit: [
            {
              info: {
                title: "Go To Statement Considered Harmful",
                url: "https://dblp.org/rec/journals/cacm/Dijkstra68.html",
                venue: "CACM",
                year: "1968",
              },
            },
            {
              info: { title: "A Note on Two Problems", url: "https://dblp.org/rec/x.html" },
            },
          ],
        },
      },
    });
    const provider = createDblpProvider({ fetch: respondWith(200, body) });
    await expect(provider.search("dijkstra", io)).resolves.toEqual([
      {
        title: "Go To Statement Considered Harmful",
        url: "https://dblp.org/rec/journals/cacm/Dijkstra68.html",
        snippet: "CACM, 1968",
      },
      {
        title: "A Note on Two Problems",
        url: "https://dblp.org/rec/x.html",
        snippet: "",
      },
    ]);
  });

  it("queries the JSON publication API with a hit cap", async () => {
    const calls: { url: string }[] = [];
    const provider = createDblpProvider({
      fetch: respondWith(200, JSON.stringify({ result: {} }), calls),
    });
    await provider.search("dijkstra", io);
    expect(calls[0]?.url).toBe("https://dblp.org/search/publ/api?q=dijkstra&format=json&h=8");
  });

  it("treats an absent hits object as empty, not a refusal", async () => {
    const provider = createDblpProvider({
      fetch: respondWith(200, JSON.stringify({ result: {} })),
    });
    await expect(provider.search("nothing here", io)).resolves.toEqual([]);
  });

  it("refuses a 429 as rate-limited", async () => {
    const provider = createDblpProvider({ fetch: respondWith(429, "slow down") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("rate-limited");
  });

  it("refuses a 500 as an error", async () => {
    const provider = createDblpProvider({ fetch: respondWith(500, "boom") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 body that is not JSON", async () => {
    const provider = createDblpProvider({ fetch: respondWith(200, "<html>nope</html>") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 with an unexpected top-level shape", async () => {
    const provider = createDblpProvider({ fetch: respondWith(200, JSON.stringify({ meta: 1 })) });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean empty hit list with []", async () => {
    const provider = createDblpProvider({
      fetch: respondWith(200, JSON.stringify({ result: { hits: { hit: [] } } })),
    });
    await expect(provider.search("nothing", io)).resolves.toEqual([]);
  });
});
