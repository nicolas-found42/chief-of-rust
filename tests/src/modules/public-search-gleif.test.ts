import { afterEach, describe, expect, it, vi } from "vitest";
import { createGleifProvider } from "../../../apps/server/src/source-adapters/providers/gleif";
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

describe("createGleifProvider", () => {
  it("maps the lei-record fixture to search.gleif.org record URLs", async () => {
    const body = JSON.stringify({
      data: [
        {
          attributes: {
            lei: "HWUPMI0VGYRLO8R7KE11",
            entity: { legalName: { name: "ADIO INTERMEDIA LLC" } },
          },
        },
        {
          attributes: {
            lei: "5493001KJTIIGC8Y1R12",
            entity: { legalName: { name: "APPLE INC." } },
          },
        },
      ],
    });
    const provider = createGleifProvider({ fetch: respondWith(200, body) });
    await expect(provider.search("apple inc", io)).resolves.toEqual([
      {
        title: "ADIO INTERMEDIA LLC",
        url: "https://search.gleif.org/#/record/HWUPMI0VGYRLO8R7KE11",
        snippet: "HWUPMI0VGYRLO8R7KE11",
      },
      {
        title: "APPLE INC.",
        url: "https://search.gleif.org/#/record/5493001KJTIIGC8Y1R12",
        snippet: "5493001KJTIIGC8Y1R12",
      },
    ]);
  });

  it("queries the lei-records endpoint filtered by legal name", async () => {
    const calls: { url: string }[] = [];
    const provider = createGleifProvider({
      fetch: respondWith(200, JSON.stringify({ data: [] }), calls),
    });
    await provider.search("apple inc", io);
    expect(calls[0]?.url).toBe(
      "https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=apple%20inc&page%5Bsize%5D=8",
    );
  });

  it("refuses a 429 as rate-limited", async () => {
    const provider = createGleifProvider({ fetch: respondWith(429, "slow down") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("rate-limited");
  });

  it("refuses a 500 as an error", async () => {
    const provider = createGleifProvider({ fetch: respondWith(500, "boom") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 body that is not JSON", async () => {
    const provider = createGleifProvider({ fetch: respondWith(200, "<html>nope</html>") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 with an unexpected shape", async () => {
    const provider = createGleifProvider({
      fetch: respondWith(200, JSON.stringify({ meta: {} })),
    });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean empty result set with []", async () => {
    const provider = createGleifProvider({ fetch: respondWith(200, JSON.stringify({ data: [] })) });
    await expect(provider.search("unknown entity", io)).resolves.toEqual([]);
  });
  // Ride the real curated transport and stub the global fetch it sits on —
  // the injected-fetch pattern alone would bypass the header binding that the
  // live malformed-body diagnosis hinged on.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds a JSON accept to its curated transport", async () => {
    const accepts: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: { headers?: HeadersInit }) => {
        accepts.push(new Headers(init?.headers).get("accept") ?? undefined);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const provider = createGleifProvider();
    await expect(provider.search("unknown entity", io)).resolves.toEqual([]);
    expect(accepts[0]).toBe("application/json");
  });
});
