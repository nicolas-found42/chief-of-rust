import { describe, expect, it } from "vitest";
import { createOrcidProvider } from "../../../apps/server/src/source-adapters/providers/orcid";
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

describe("createOrcidProvider", () => {
  it("maps the expanded-search fixture to registry results", async () => {
    const body = JSON.stringify({
      "expanded-result": [
        {
          "orcid-id": "0000-0002-1825-0097",
          "given-names": "Josiah",
          "family-names": "Carberry",
          "institution-name": ["Brown University"],
        },
        {
          "orcid-id": "0000-0001-5109-3700",
          "given-names": "Ada",
          "family-names": "Lovelace",
          "institution-name": [],
        },
      ],
    });
    const provider = createOrcidProvider({ fetch: respondWith(200, body) });
    await expect(provider.search("carberry", io)).resolves.toEqual([
      {
        title: "Josiah Carberry",
        url: "https://orcid.org/0000-0002-1825-0097",
        snippet: "Brown University",
      },
      { title: "Ada Lovelace", url: "https://orcid.org/0000-0001-5109-3700", snippet: "" },
    ]);
  });

  it("searches the v3 expanded-search endpoint", async () => {
    const calls: { url: string }[] = [];
    const provider = createOrcidProvider({
      fetch: respondWith(200, JSON.stringify({ "expanded-result": [] }), calls),
    });
    await provider.search("ada lovelace", io);
    expect(calls[0]?.url).toBe(
      "https://pub.orcid.org/v3.0/expanded-search?q=ada%20lovelace&rows=8",
    );
  });

  it("refuses a 500 as an error", async () => {
    const provider = createOrcidProvider({ fetch: respondWith(500, "boom") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 body that is not JSON", async () => {
    const provider = createOrcidProvider({ fetch: respondWith(200, "<xml/>") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 with an unexpected shape", async () => {
    const provider = createOrcidProvider({ fetch: respondWith(200, JSON.stringify({ num: 0 })) });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean empty result set with []", async () => {
    const provider = createOrcidProvider({
      fetch: respondWith(200, JSON.stringify({ "expanded-result": [] })),
    });
    await expect(provider.search("nobody", io)).resolves.toEqual([]);
  });
  it("answers the zero-hit null envelope with []", async () => {
    const provider = createOrcidProvider({
      fetch: respondWith(200, JSON.stringify({ "expanded-result": null, "num-found": 0 })),
    });
    await expect(provider.search("nobody", io)).resolves.toEqual([]);
  });
});
