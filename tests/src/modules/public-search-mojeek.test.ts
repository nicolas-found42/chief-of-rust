import { describe, expect, it } from "vitest";
import { createMojeekProvider } from "../../../apps/server/src/source-adapters/providers/mojeek";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";

/**
 * Mojeek answers a plain keyless HTML GET (the ddgs engine's selectors:
 * `ul.results > li`, `h2 a`, `p.s`). A 200 page without the results list is
 * a layout change or an interstitial — refusing keeps a broken parse from
 * reading as evidence that nothing exists.
 */
function respondWith(status: number, body: string, retryAfter: string | null = null) {
  const calls: string[] = [];
  const fetch: PublicHttpFetch = async (url: string) => {
    calls.push(url);
    const response: PublicHttpResponse = {
      url,
      status,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter,
      body,
    };
    return response;
  };
  const io: SearchProviderIo = { fetch, timeoutMs: 5_000 };
  return { fetch, calls, io };
}

const FIXTURE = `<html><body><ul class="results">
  <li><h2><a href="https://www.example.com/ada/">Ada Lovelace</a></h2><p class="s">First programmer.</p></li>
  <li><h2><a href="/relative/path">Relative hit</a></h2><p class="s">Resolved against the response URL.</p></li>
</ul></body></html>`;

describe("createMojeekProvider", () => {
  it("parses ul.results rows into normalized public search results", async () => {
    const { calls, io } = respondWith(200, FIXTURE);
    const results = await createMojeekProvider().search("ada lovelace", io);
    expect(calls).toEqual(["https://www.mojeek.com/search?q=ada%20lovelace"]);
    expect(results).toEqual([
      {
        title: "Ada Lovelace",
        url: "https://www.example.com/ada/",
        snippet: "First programmer.",
      },
      {
        title: "Relative hit",
        url: "https://www.mojeek.com/relative/path",
        snippet: "Resolved against the response URL.",
      },
    ]);
  });

  it("refuses a non-200 answer as an error", async () => {
    const { io } = respondWith(500, "upstream error");
    const refusal = createMojeekProvider().search("ada lovelace", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("refuses a 429 as rate-limited, carrying Retry-After", async () => {
    const { io } = respondWith(429, "slow down", "30");
    const refusal = createMojeekProvider().search("ada lovelace", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAfterMs).toBe(30_000);
  });

  it("refuses an anti-bot challenge page as captcha", async () => {
    const { io } = respondWith(200, "<html>Verify you are human to continue.</html>");
    const refusal = createMojeekProvider().search("ada lovelace", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("captcha");
  });

  it("refuses a 200 page without the results list as an error", async () => {
    const { io } = respondWith(200, "<html><body><p>Nothing to parse.</p></body></html>");
    const refusal = createMojeekProvider().search("ada lovelace", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("answers a results list with no rows as no results", async () => {
    const { io } = respondWith(200, '<html><body><ul class="results"></ul></body></html>');
    await expect(createMojeekProvider().search("ada lovelace", io)).resolves.toEqual([]);
  });
});
