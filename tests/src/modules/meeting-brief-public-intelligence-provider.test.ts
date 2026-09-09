import { describe, expect, it } from "vitest";
import { DuckDuckGoPublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence.js";

describe("bounded public-intelligence adapter — issue #88", () => {
  it("normalizes DuckDuckGo results and honors the requested result bound", async () => {
    const provider = new DuckDuckGoPublicIntelligenceProvider(
      async () =>
        new Response(
          `<html><body>
          <div class="result">
            <a class="result__a" href="https://example.com/news-one">News one</a>
            <a class="result__snippet">First evidence snippet</a>
          </div>
          <div class="result">
            <a class="result__a" href="https://second.example/story">News two</a>
            <a class="result__snippet">Second evidence snippet</a>
          </div>
        </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    );

    const results = await provider.search(
      "Example Corp news",
      { from: "2026-07-28T00:00:00.000Z", to: "2026-08-28T00:00:00.000Z" },
      1,
    );

    expect(results).toEqual([
      {
        title: "News one",
        snippet: "First evidence snippet",
        url: "https://example.com/news-one",
        org: "example.com",
      },
    ]);
  });

  it("classifies outage responses and network failures as provider-wide unavailable (US68)", async () => {
    const outage = new DuckDuckGoPublicIntelligenceProvider(
      async () => new Response("blocked", { status: 502 }),
    );
    await expect(
      outage.search(
        "Example Corp news",
        { from: "2026-07-28T00:00:00.000Z", to: "2026-08-28T00:00:00.000Z" },
        5,
      ),
    ).rejects.toThrow(/unavailable/);

    const offline = new DuckDuckGoPublicIntelligenceProvider(async () => {
      throw new Error("This operation was aborted");
    });
    await expect(
      offline.search(
        "Example Corp news",
        { from: "2026-07-28T00:00:00.000Z", to: "2026-08-28T00:00:00.000Z" },
        5,
      ),
    ).rejects.toThrow(/unavailable/);
  });
});
