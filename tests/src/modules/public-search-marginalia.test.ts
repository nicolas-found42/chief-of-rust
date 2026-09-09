import { describe, expect, it } from "vitest";
import { createMarginaliaProvider } from "../../../apps/server/src/source-adapters/providers/marginalia";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";

/**
 * Marginalia's shared `public` key saturates its QPM regularly (the research
 * doc's live probe got "QPM Limit Exceeded" while the service was up), so a
 * 503 is normal operation — a rate-limit refusal, never a hard failure.
 */
function respondWith(status: number, body: string, retryAfter: string | null = null) {
  const calls: string[] = [];
  const fetch: PublicHttpFetch = async (url: string) => {
    calls.push(url);
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
  return { fetch, calls };
}

const IO: SearchProviderIo = { fetch: async () => ({}) as PublicHttpResponse, timeoutMs: 5_000 };

const FIXTURE = JSON.stringify([
  {
    url: "https://example.com/surreal/",
    title: "Surrealism index",
    description: "A catalogue of surrealist texts.",
  },
  {
    url: "https://example.com/small-web/",
    title: "The small web",
    description: "Pages the big indexes never crawl.",
  },
]);

describe("createMarginaliaProvider", () => {
  it("maps a result array to normalized public search results", async () => {
    const { fetch, calls } = respondWith(200, FIXTURE);
    const results = await createMarginaliaProvider({ fetch }).search("surrealism", IO);
    expect(calls).toEqual(["https://api2.marginalia-search.com/search?query=surrealism&count=8"]);
    expect(results).toEqual([
      {
        title: "Surrealism index",
        url: "https://example.com/surreal/",
        snippet: "A catalogue of surrealist texts.",
      },
      {
        title: "The small web",
        url: "https://example.com/small-web/",
        snippet: "Pages the big indexes never crawl.",
      },
    ]);
  });

  it("drops entries without an absolute http(s) URL instead of inventing one", async () => {
    const { fetch } = respondWith(
      200,
      JSON.stringify([
        { url: "gopher://example.com/1", title: "Gopher hole", description: "Not web." },
        { url: "https://example.com/kept/", title: "Kept", description: "Web." },
      ]),
    );
    const results = await createMarginaliaProvider({ fetch }).search("anything", IO);
    expect(results).toEqual([{ title: "Kept", url: "https://example.com/kept/", snippet: "Web." }]);
  });

  it("refuses a saturated shared key as rate-limited", async () => {
    const { fetch } = respondWith(503, "QPM Limit Exceeded", "3600");
    const refusal = createMarginaliaProvider({ fetch }).search("surrealism", IO);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAfterMs).toBe(3_600_000);
  });

  it("refuses a 200 body that is not JSON", async () => {
    const { fetch } = respondWith(200, "<html>QPM Limit Exceeded</html>");
    const refusal = createMarginaliaProvider({ fetch }).search("surrealism", IO);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("refuses a 200 body that is JSON but not the documented array", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ error: "bad query" }));
    const refusal = createMarginaliaProvider({ fetch }).search("surrealism", IO);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("answers an empty result array with no results", async () => {
    const { fetch } = respondWith(200, "[]");
    await expect(createMarginaliaProvider({ fetch }).search("surrealism", IO)).resolves.toEqual([]);
  });
});
