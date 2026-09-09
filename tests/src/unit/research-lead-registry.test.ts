import { describe, expect, it } from "vitest";
import { LeadRegistry } from "../../../apps/server/src/person-profile/research-plan";

/**
 * The lead registry, asked directly.
 *
 * Completion is defined against this registry, and the coverage plan asks it
 * which source families the operation actually investigated (#238), so what a
 * lead records about itself decides what a completed operation may claim.
 */
describe("the lead registry", () => {
  it("classifies a deduplicated URL into the same source family as a fresh one", () => {
    /* A resumed operation re-proposes what an earlier one already read, and
       those come back deduplicated. Losing the family there reported a source
       family that had been investigated as one nothing could be aimed at. */
    const resumed = new LeadRegistry(["https://podcasts.example.com/feed/maya"]);
    expect(
      resumed.add({
        kind: "url",
        target: "https://podcasts.example.com/feed/maya",
        origin: "discovery",
      }),
    ).toBeNull();
    expect(resumed.all()[0]).toMatchObject({
      disposition: "deduplicated",
      family: "spoken-evidence",
    });
    expect(resumed.investigated("spoken-evidence")).toBe(true);
  });

  it("counts a deduplicated lead as investigated but a refused one as not", () => {
    const registry = new LeadRegistry();
    const refused = registry.add({
      kind: "query",
      target: '"Maya Okafor" paper publication doi',
      origin: "expansion",
      family: "published-work",
    })!;
    registry.resolve(refused.id, "inaccessible", "Every provider refused this query.");
    expect(registry.investigated("published-work")).toBe(false);
    expect(registry.investigated()).toBe(false);
  });
});
