import { describe, expect, it } from "vitest";
import { createInternetArchiveProvider } from "../../../apps/server/src/source-adapters/providers/ia-advancedsearch";
import type {
  PublicHttpFetch,
  PublicHttpResponse,
} from "../../../apps/server/src/source-adapters/http";
import { ProviderRefusedError } from "../../../apps/server/src/source-adapters/providers/types";
import type { SearchProviderIo } from "../../../apps/server/src/source-adapters/providers/types";

/**
 * advancedsearch.php answers with the archive.org metadata model, where a
 * scalar field like `title` or `description` can arrive wrapped in a
 * one-element array — the provider joins before slicing, and a document
 * without an identifier is dropped rather than given an invented URL.
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

const FIXTURE = JSON.stringify({
  response: {
    docs: [
      {
        identifier: "example-thesis",
        title: ["A Thesis Title"],
        description: ["Chapter one.", "Chapter two."],
      },
      {
        identifier: "plain-item",
        title: "Plain Title",
        description: "Plain description.",
      },
      { title: "No identifier, no URL" },
    ],
  },
});

describe("createInternetArchiveProvider", () => {
  it("maps documents to archive.org details URLs", async () => {
    const { calls, io } = respondWith(200, FIXTURE);
    const results = await createInternetArchiveProvider().search("surrealism manifestos", io);
    expect(calls).toEqual([
      "https://archive.org/advancedsearch.php?q=surrealism%20manifestos" +
        "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&rows=8&output=json",
    ]);
    expect(results).toEqual([
      {
        title: "A Thesis Title",
        url: "https://archive.org/details/example-thesis",
        snippet: "Chapter one. Chapter two.",
      },
      {
        title: "Plain Title",
        url: "https://archive.org/details/plain-item",
        snippet: "Plain description.",
      },
    ]);
  });

  it("refuses a non-200 answer as an error", async () => {
    const { io } = respondWith(500, "internal error");
    const refusal = createInternetArchiveProvider().search("surrealism manifestos", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("refuses a 200 body that is not JSON", async () => {
    const { io } = respondWith(200, "<html>maintenance</html>");
    const refusal = createInternetArchiveProvider().search("surrealism manifestos", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("refuses a 200 body without a document list", async () => {
    const { io } = respondWith(200, JSON.stringify({ error: "invalid query" }));
    const refusal = createInternetArchiveProvider().search("surrealism manifestos", io);
    await expect(refusal).rejects.toBeInstanceOf(ProviderRefusedError);
    const error = (await refusal.catch(
      (caught: ProviderRefusedError) => caught,
    )) as ProviderRefusedError;
    expect(error.reason).toBe("error");
  });

  it("answers an empty document list with no results", async () => {
    const { io } = respondWith(200, JSON.stringify({ response: { docs: [] } }));
    await expect(
      createInternetArchiveProvider().search("surrealism manifestos", io),
    ).resolves.toEqual([]);
  });
});
