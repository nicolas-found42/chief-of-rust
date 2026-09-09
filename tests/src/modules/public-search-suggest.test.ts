import { describe, expect, it } from "vitest";
import { fetchSuggestions } from "../../../apps/server/src/source-adapters/providers/suggest";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http";

const TIMEOUT_MS = 5_000;

function ioFrom(
  respond: (url: string) => { status: number; body: string } | Promise<never>,
): SearchProviderIo {
  const fetch = async (url: string): Promise<PublicHttpResponse> => {
    const answer = await respond(url);
    return {
      url,
      status: answer.status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: answer.body,
    };
  };
  return { fetch, timeoutMs: TIMEOUT_MS };
}

function suggestBody(suggestions: string[]): string {
  return JSON.stringify(["anything", suggestions]);
}

describe("fetchSuggestions", () => {
  it("merges unique suggestions from all three endpoints, preserving order and excluding the original query", async () => {
    const requested: string[] = [];
    const io = ioFrom((url) => {
      requested.push(url);
      if (url.startsWith("https://suggestqueries.google.com/")) {
        return { status: 200, body: suggestBody(["ada lovelace biography", "ada lovelace"]) };
      }
      if (url.startsWith("https://duckduckgo.com/ac")) {
        return {
          status: 200,
          body: suggestBody(["ada lovelace", "ada lovelace quotes", "anything"]),
        };
      }
      return { status: 200, body: suggestBody(["ada lovelace facts"]) };
    });

    await expect(fetchSuggestions("anything", io)).resolves.toEqual([
      "ada lovelace biography",
      "ada lovelace",
      "ada lovelace quotes",
      "ada lovelace facts",
    ]);
    // All three documented endpoints fired with the encoded query.
    expect(requested).toEqual([
      "https://suggestqueries.google.com/complete/search?client=firefox&q=anything",
      "https://duckduckgo.com/ac/?q=anything&type=list",
      "https://api.bing.com/osjson.aspx?query=anything",
    ]);
  });

  it("caps the merged suggestions at 6", async () => {
    const io = ioFrom(() => ({
      status: 200,
      body: suggestBody(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]),
    }));
    await expect(fetchSuggestions("anything", io)).resolves.toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
    ]);
  });

  it("ignores one failing endpoint and answers from the others", async () => {
    const io = ioFrom((url) => {
      if (url.startsWith("https://duckduckgo.com/ac")) return { status: 500, body: "nope" };
      return { status: 200, body: suggestBody(["only from google"]) };
    });
    await expect(fetchSuggestions("anything", io)).resolves.toEqual(["only from google"]);
  });

  it("ignores an endpoint whose body is not the [query, [suggestions]] shape", async () => {
    const io = ioFrom((url) => {
      if (url.startsWith("https://api.bing.com/")) return { status: 200, body: '{"weird": true}' };
      return { status: 200, body: suggestBody(["kept suggestion"]) };
    });
    await expect(fetchSuggestions("anything", io)).resolves.toEqual(["kept suggestion"]);
  });

  it("resolves [] when every endpoint fails — expansion never throws", async () => {
    const io = ioFrom(() => ({ status: 503, body: "down" }));
    await expect(fetchSuggestions("anything", io)).resolves.toEqual([]);
  });
});
