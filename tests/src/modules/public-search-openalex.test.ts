import { describe, expect, it } from "vitest";
import { createOpenAlexProvider } from "../../../apps/server/src/source-adapters/providers/openalex";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";

const io = {
  timeoutMs: 5_000,
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
};

function respondWith(
  status: number,
  body: string,
  calls: { url: string }[] = [],
  retryAfter: string | null = null,
) {
  return async (url: string): Promise<PublicHttpResponse> => {
    calls.push({ url });
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
}

describe("createOpenAlexProvider", () => {
  it("maps the authors fixture to normalized results", async () => {
    const body = JSON.stringify({
      results: [
        { id: "https://openalex.org/A5023888391", display_name: "Ada Lovelace" },
        { id: "https://openalex.org/A5006471475", display_name: "Grace Hopper" },
      ],
    });
    const provider = createOpenAlexProvider({ fetch: respondWith(200, body) });
    await expect(provider.search("ada lovelace", io)).resolves.toEqual([
      { title: "Ada Lovelace", url: "https://openalex.org/A5023888391", snippet: "" },
      { title: "Grace Hopper", url: "https://openalex.org/A5006471475", snippet: "" },
    ]);
  });

  it("queries the polite pool with the mailto parameter and a per-page cap", async () => {
    const calls: { url: string }[] = [];
    const provider = createOpenAlexProvider({
      fetch: respondWith(200, JSON.stringify({ results: [] }), calls),
    });
    await provider.search("ada lovelace", io);
    expect(calls[0]?.url).toBe(
      "https://api.openalex.org/authors?search=ada%20lovelace&per-page=8&mailto=owner@found42.local",
    );
  });

  it("refuses a 429 as rate-limited and carries Retry-After", async () => {
    const provider = createOpenAlexProvider({ fetch: respondWith(429, "slow down", [], "30") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("rate-limited");
    expect((refusal as ProviderRefusedError).retryAfterMs).toBe(30_000);
  });

  it("refuses a 500 as an error", async () => {
    const provider = createOpenAlexProvider({ fetch: respondWith(500, "boom") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 body that is not JSON", async () => {
    const provider = createOpenAlexProvider({ fetch: respondWith(200, "<html>nope</html>") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 with an unexpected shape", async () => {
    const provider = createOpenAlexProvider({
      fetch: respondWith(200, JSON.stringify({ meta: {} })),
    });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean empty result set with []", async () => {
    const provider = createOpenAlexProvider({
      fetch: respondWith(200, JSON.stringify({ results: [] })),
    });
    await expect(provider.search("nobody at all", io)).resolves.toEqual([]);
  });

  it("caps results at 8 and clips titles", async () => {
    const results = Array.from({ length: 12 }, (_, index) => ({
      id: `https://openalex.org/A${index}`,
      display_name: "x".repeat(300),
    }));
    const provider = createOpenAlexProvider({
      fetch: respondWith(200, JSON.stringify({ results })),
    });
    const mapped = await provider.search("x", io);
    expect(mapped).toHaveLength(8);
    expect(mapped.every((result) => result.title.length === 200)).toBe(true);
  });
});
