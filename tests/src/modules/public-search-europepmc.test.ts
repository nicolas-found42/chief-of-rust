import { describe, expect, it } from "vitest";
import { createEuropePmcProvider } from "../../../apps/server/src/source-adapters/providers/europepmc";
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

const FIXTURE = JSON.stringify({
  hitCount: 2,
  resultList: {
    result: [
      {
        title: "Off-target effects of CRISPR",
        doi: "10.1038/s41586-021-03819-2",
        id: "33767454",
        source: "MED",
        abstractText: "We review the mechanisms behind off-target cleavage.",
      },
      { title: "A preprint without a DOI", id: "PMC8887777", source: "PPR" },
    ],
  },
});

describe("createEuropePmcProvider", () => {
  it("maps hits to results, preferring the DOI route and using abstractText as the snippet", async () => {
    const { fetch, urls } = fetchAnswering(200, FIXTURE);
    const results = await createEuropePmcProvider().search("crispr off-target effects", {
      fetch,
      timeoutMs: 5_000,
    } satisfies SearchProviderIo);
    expect(urls).toEqual([
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=crispr%20off-target%20effects&format=json&pageSize=8",
    ]);
    expect(results).toEqual([
      {
        title: "Off-target effects of CRISPR",
        url: "https://doi.org/10.1038/s41586-021-03819-2",
        snippet: "We review the mechanisms behind off-target cleavage.",
      },
      {
        title: "A preprint without a DOI",
        url: "https://europepmc.org/article/PPR/PMC8887777",
        snippet: "",
      },
    ]);
  });

  it("refuses HTTP 429 as rate-limited", async () => {
    const { fetch } = fetchAnswering(429, "");
    const error = await refused(createEuropePmcProvider().search("q", { fetch, timeoutMs: 5_000 }));
    expect(error.reason).toBe("rate-limited");
  });

  it("refuses other non-200 answers as errors", async () => {
    const { fetch } = fetchAnswering(500, "boom");
    const error = await refused(createEuropePmcProvider().search("q", { fetch, timeoutMs: 5_000 }));
    expect(error.reason).toBe("error");
  });

  it("refuses a 200 that is not the resultList shape", async () => {
    const { fetch } = fetchAnswering(200, "<html>not json</html>");
    const error = await refused(createEuropePmcProvider().search("q", { fetch, timeoutMs: 5_000 }));
    expect(error.reason).toBe("error");
  });

  it("answers a clean empty search with []", async () => {
    const { fetch } = fetchAnswering(
      200,
      JSON.stringify({ hitCount: 0, resultList: { result: [] } }),
    );
    await expect(
      createEuropePmcProvider().search("q", { fetch, timeoutMs: 5_000 }),
    ).resolves.toEqual([]);
  });
});
