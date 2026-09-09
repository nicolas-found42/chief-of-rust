import { describe, expect, it } from "vitest";
import {
  createPublicSearch,
  PublicSearchUnavailableError,
} from "../../../apps/server/src/source-adapters/search";
import { createPublicWebPersonProfileSource } from "../../../apps/server/src/person-profile/sources";

/**
 * A refused search must not read as a search that found nothing: the second is
 * evidence that a person has no public footprint, and the first is evidence of
 * nothing at all. The HTML route answers 200 with results and 202 with an
 * anti-bot challenge page.
 */
const SIGNALS = {
  emails: ["ada@example.com"],
  fullNames: [],
  handles: {},
  profileUrls: [],
  employerHints: [],
};

function respondWith(status: number, body: string) {
  return async (url: string) => ({
    url,
    status,
    contentType: "text/html",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
  });
}

const CHALLENGE = "<html><body>Please complete the following challenge</body></html>";

describe("createPublicSearch", () => {
  it("refuses a 202 challenge rather than reporting no results", async () => {
    const search = createPublicSearch(respondWith(202, CHALLENGE));
    await expect(search("anything")).rejects.toBeInstanceOf(PublicSearchUnavailableError);
  });

  it("still reports a genuine 200 with no matches as no results", async () => {
    const search = createPublicSearch(respondWith(200, "<html><body>no hits</body></html>"));
    await expect(search("anything")).resolves.toEqual([]);
  });
});

describe("the person source's diagnostic", () => {
  it("classifies a blocked search as failed, not empty", async () => {
    const source = createPublicWebPersonProfileSource({
      search: createPublicSearch(respondWith(202, CHALLENGE)),
      discoverFeeds: async () => [],
    });

    const result = await source.collect(SIGNALS);

    expect(result.diagnostic.status).toBe("failed");
    expect(result.candidates).toEqual([]);
  });

  it("still classifies a working search that matched nothing as empty", async () => {
    const source = createPublicWebPersonProfileSource({
      search: createPublicSearch(respondWith(200, "<html><body>no hits</body></html>")),
      discoverFeeds: async () => [],
    });

    const result = await source.collect(SIGNALS);

    expect(result.diagnostic.status).toBe("empty");
  });
});
