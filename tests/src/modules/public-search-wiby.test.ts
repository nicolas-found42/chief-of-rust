import { describe, expect, it } from "vitest";
import { createWibyProvider } from "../../../apps/server/src/source-adapters/providers/wiby";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";

/**
 * Wiby's JSON API answers `wiby.me/json/?q=…` with an array of
 * `{ URL, Title, Snippet }` — the small-web supplement surface for pages
 * the big indexes never crawl.
 */
function respondWith(status: number, body: string) {
  const calls: string[] = [];
  const fetch: PublicHttpFetch = async (url: string) => {
    calls.push(url);
    const response: PublicHttpResponse = {
      url,
      status,
      contentType: "application/json",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    };
    return response;
  };
  const io: SearchProviderIo = { fetch, timeoutMs: 5_000 };
  return { calls, io };
}

const FIXTURE = JSON.stringify([
  {
    URL: "https://example.org/~ada/",
    Title: "Ada's homepage",
    Snippet: "Hand-written HTML since 1999.",
  },
  { URL: "gopher://wiby.me/1", Title: "Gopher hole", Snippet: "Not a web page." },
]);

describe("createWibyProvider", () => {
  it("maps the result array to normalized public search results", async () => {
    const { calls, io } = respondWith(200, FIXTURE);
    const results = await createWibyProvider().search("personal homepage", io);
    expect(calls).toEqual(["https://wiby.me/json/?q=personal%20homepage"]);
    expect(results).toEqual([
      {
        title: "Ada's homepage",
        url: "https://example.org/~ada/",
        snippet: "Hand-written HTML since 1999.",
      },
    ]);
  });

  it("refuses a non-200 answer as an error", async () => {
    const { io } = respondWith(500, "upstream error");
    const refusal = createWibyProvider().search("personal homepage", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("refuses a 200 body that is not JSON", async () => {
    const { io } = respondWith(200, "<html>not the json api</html>");
    const refusal = createWibyProvider().search("personal homepage", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("refuses a 200 body that is JSON but not the documented array", async () => {
    const { io } = respondWith(200, JSON.stringify({ message: "no results format" }));
    const refusal = createWibyProvider().search("personal homepage", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("answers an empty result array with no results", async () => {
    const { io } = respondWith(200, "[]");
    await expect(createWibyProvider().search("personal homepage", io)).resolves.toEqual([]);
  });
});
