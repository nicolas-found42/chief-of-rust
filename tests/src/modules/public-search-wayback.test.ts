import { describe, expect, it } from "vitest";
import { createWaybackProvider } from "../../../apps/server/src/source-adapters/providers/wayback";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";
import type { PublicHttpFetch } from "../../../apps/server/src/source-adapters/http";

const PAGE_URL = "https://example.com/page";

function ioFrom(fetch: PublicHttpFetch): SearchProviderIo {
  return { fetch, timeoutMs: 5_000 };
}

function respondWith(status: number, body: string): PublicHttpFetch {
  return async (url: string) => ({
    url,
    status,
    contentType: "application/json",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
  });
}

function availabilityBody(url: string, timestamp: string): string {
  return JSON.stringify({ archived_snapshots: { closest: { url, timestamp, status: "200" } } });
}

describe("the wayback provider", () => {
  it("maps a closest snapshot to exactly one archived-snapshot result", async () => {
    const snapshotUrl = "https://web.archive.org/web/20260616000000/https://example.com/page";
    let requested = "";
    const io = ioFrom(async (url) => {
      requested = url;
      const response = respondWith(200, availabilityBody(snapshotUrl, "20260616000000"))(url);
      return await response;
    });

    await expect(createWaybackProvider().search(PAGE_URL, io)).resolves.toEqual([
      {
        title: "Archived snapshot 20260616000000",
        url: snapshotUrl,
        snippet: `Wayback Machine copy of ${PAGE_URL}, captured 20260616000000.`,
      },
    ]);
    expect(requested).toBe(
      `https://archive.org/wayback/available?url=${encodeURIComponent(PAGE_URL)}`,
    );
  });

  it("returns [] for a non-URL query without firing a request", async () => {
    let fired = false;
    const io = ioFrom(async (url) => {
      fired = true;
      return respondWith(200, "{}")(url);
    });

    await expect(createWaybackProvider().search("ada lovelace", io)).resolves.toEqual([]);
    expect(fired).toBe(false);
  });

  it("returns [] for a 200 without a snapshot", async () => {
    const io = ioFrom(respondWith(200, JSON.stringify({ archived_snapshots: {} })));
    await expect(createWaybackProvider().search(PAGE_URL, io)).resolves.toEqual([]);
  });

  it("refuses a non-200 answer as an error", async () => {
    const io = ioFrom(respondWith(500, "boom"));
    await expect(createWaybackProvider().search(PAGE_URL, io)).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "error",
    });
  });

  it("classifies 429 as rate-limited", async () => {
    const io = ioFrom(respondWith(429, "slow down"));
    await expect(createWaybackProvider().search(PAGE_URL, io)).rejects.toMatchObject({
      name: "ProviderRefusedError",
      reason: "rate-limited",
    });
  });

  it("refuses a 200 body that is not the documented shape", async () => {
    const io = ioFrom(respondWith(200, "<html>not json</html>"));
    await expect(createWaybackProvider().search(PAGE_URL, io)).rejects.toBeInstanceOf(
      ProviderRefusedError,
    );
  });
});
