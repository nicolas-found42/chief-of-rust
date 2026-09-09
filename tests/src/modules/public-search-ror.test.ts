import { afterEach, describe, expect, it, vi } from "vitest";
import { createRorProvider } from "../../../apps/server/src/source-adapters/providers/ror";
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

describe("createRorProvider", () => {
  it("maps the organization fixture to canonical ror.org results", async () => {
    const body = JSON.stringify({
      items: [
        { id: "https://ror.org/05f448944", name: "Brown University" },
        { id: "https://ror.org/03vek6s52", name: "Harvard University" },
      ],
    });
    const provider = createRorProvider({ fetch: respondWith(200, body) });
    await expect(provider.search("brown university", io)).resolves.toEqual([
      { title: "Brown University", url: "https://ror.org/05f448944", snippet: "" },
      { title: "Harvard University", url: "https://ror.org/03vek6s52", snippet: "" },
    ]);
  });

  it("queries the organizations endpoint", async () => {
    const calls: { url: string }[] = [];
    const provider = createRorProvider({
      fetch: respondWith(200, JSON.stringify({ items: [] }), calls),
    });
    await provider.search("brown university", io);
    expect(calls[0]?.url).toBe("https://api.ror.org/organizations?query=brown%20university");
  });

  it("refuses a 429 as rate-limited and carries Retry-After", async () => {
    const provider = createRorProvider({ fetch: respondWith(429, "slow down", [], "60") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("rate-limited");
    expect((refusal as ProviderRefusedError).retryAfterMs).toBe(60_000);
  });

  it("refuses a 500 as an error", async () => {
    const provider = createRorProvider({ fetch: respondWith(500, "boom") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 body that is not JSON", async () => {
    const provider = createRorProvider({ fetch: respondWith(200, "<html>nope</html>") });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("refuses a 200 with an unexpected shape", async () => {
    const provider = createRorProvider({
      fetch: respondWith(200, JSON.stringify({ number_of_results: 0 })),
    });
    const refusal = await provider.search("x", io).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderRefusedError);
    expect((refusal as ProviderRefusedError).reason).toBe("error");
  });

  it("answers a clean empty result set with []", async () => {
    const provider = createRorProvider({ fetch: respondWith(200, JSON.stringify({ items: [] })) });
    await expect(provider.search("nowhere", io)).resolves.toEqual([]);
  });
  // Ride the real curated transport and stub the global fetch it sits on —
  // the injected-fetch pattern alone would bypass the header binding that the
  // live 406 diagnosis hinged on.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds a JSON accept to its curated transport", async () => {
    const accepts: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: { headers?: HeadersInit }) => {
        accepts.push(new Headers(init?.headers).get("accept") ?? undefined);
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const provider = createRorProvider();
    await expect(provider.search("nowhere", io)).resolves.toEqual([]);
    expect(accepts[0]).toBe("application/json");
  });
});
