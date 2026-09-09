import { describe, expect, it } from "vitest";
import { createWikidataProvider } from "../../../apps/server/src/source-adapters/providers/wikidata";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";

const IO = {
  timeoutMs: 10_000,
  fetch: async () => {
    throw new Error("io.fetch is not used by this provider under test");
  },
};

function respondWith(status: number, body: string) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
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
  return { fetch, calls };
}

const FIXTURE = {
  search: [
    {
      label: "Ada Lovelace",
      description: "English mathematician",
      concepturi: "https://www.wikidata.org/wiki/Q7259",
    },
    { label: "Ada County", description: "county in Idaho", concepturi: "relative/only" },
    { label: "No URI", description: "no concepturi at all" },
  ],
};

describe("createWikidataProvider", () => {
  it("maps label/description/concepturi and drops entities without a usable URL", async () => {
    const { fetch } = respondWith(200, JSON.stringify(FIXTURE));
    const provider = createWikidataProvider({ fetch });

    const results = await provider.search("ada", IO);

    expect(results).toEqual([
      {
        title: "Ada Lovelace",
        url: "https://www.wikidata.org/wiki/Q7259",
        snippet: "English mathematician",
      },
    ]);
  });

  it("requests wbsearchentities with the encoded query", async () => {
    const { fetch, calls } = respondWith(200, JSON.stringify({ search: [] }));
    const provider = createWikidataProvider({ fetch });

    await provider.search("cold fusion", IO);

    expect(calls).toEqual([
      "https://www.wikidata.org/w/api.php?action=wbsearchentities&search=cold%20fusion&language=en&format=json&limit=8",
    ]);
  });

  it("classifies a non-200 as an error refusal", async () => {
    const { fetch } = respondWith(503, "upstream error");
    const provider = createWikidataProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it("classifies an unparseable 200 body as an error refusal", async () => {
    const { fetch } = respondWith(200, "not json");
    const provider = createWikidataProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it("classifies a 200 body without search[] as an error refusal", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ error: "unexpected shape" }));
    const provider = createWikidataProvider({ fetch });

    const error = await provider.search("ada", IO).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRefusedError);
    expect((error as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean 200 with no matches as []", async () => {
    const { fetch } = respondWith(200, JSON.stringify({ search: [] }));
    const provider = createWikidataProvider({ fetch });

    await expect(provider.search("nothing", IO)).resolves.toEqual([]);
  });
});
