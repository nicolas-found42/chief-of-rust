import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { composePersonProfiles } from "../../../apps/server/src/person-profile/composition";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus";
import { evaluateCollection } from "../../../apps/server/src/person-benchmark/collection";

it("reports a supported capability intersection with the full selected population and sparse coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-collection-"));
  try {
    const people = composePersonProfiles({
      workspaceDir: root,
      search: async () => [],
      complete: () => async () => ({}),
      confirmedTranscripts: () => [],
      transcriptStillConfirmed: () => false,
      researchEnabled: () => false,
    });
    const bong = people.profiles.create({ fullName: "Bong Joon-ho" });
    const other = people.profiles.create({ fullName: "Unresearched benchmark person" });
    const text = "Bong directed Barking Dogs Never Bite and co-wrote Phantom: The Submarine.";
    const source = people.dossiers.retainSource({
      url: "https://example.com/controlled-film-credit",
      title: "Controlled evaluator fixture",
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-06",
      text,
      family: "controlled-fixture",
      sourceClass: "independent-account",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "fixture",
    });
    people.dossiers.publish(bong.id, 0, {
      claims: [
        {
          id: "credit",
          section: "work",
          statement: text,
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: source.id, quote: text }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [
        {
          id: "film",
          title: "Credited film work",
          kind: "other",
          url: null,
          startedAt: null,
          endedAt: null,
          claimIds: ["credit"],
          contribution: { text: "Directed and co-wrote", claimIds: ["credit"] },
          teamContribution: null,
          authority: [],
          scale: [],
          constraints: [],
          outcomes: [],
        },
      ],
      expertise: ["directing", "screenwriting"].map((category) => ({
        category,
        originalWording: category,
        support: "demonstrated" as const,
        workIds: ["film"],
        claimIds: ["credit"],
      })),
      connections: [],
      sections: [],
    });
    const references = loadCorpus(
      fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
    ).people;
    const reference = references.find((person) => person.slug === "bong-joon-ho")!;
    const assessment = {
      verdict: "supported",
      rationale: "Both credited contributions are documented.",
      evidence: ["directing", "screenwriting"].map((category, i) => {
        const fact = reference.facts.find(
          (fact) => fact.id === (i === 0 ? "debut" : "shared-screenplay"),
        )!;
        return {
          category,
          claimId: "credit",
          quote: text,
          referenceFactId: fact.id,
          referenceQuote: fact.support[0].quote,
        };
      }),
    };
    const judge = async () => assessment;
    const reports = await evaluateCollection(
      people,
      [
        { slug: "bong-joon-ho", profileId: bong.id },
        { slug: "other", profileId: other.id },
      ],
      [
        {
          id: "film-intersection",
          categories: ["directing", "screenwriting"],
          expected: [{ slug: "bong-joon-ho", factIds: ["debut", "shared-screenplay"] }],
          rationale: "Controlled evaluator fixture; real references are loaded separately.",
        },
      ],
      { references, judge },
    );
    expect(reports[0]).toMatchObject({
      requirement: "r18",
      expectedMatches: ["bong-joon-ho"],
      recoveredMatches: ["bong-joon-ho"],
      missingMatches: [],
      coverage: { activeProfiles: 2, researchedProfiles: 1, demonstrated: 1, claimedOnly: 0 },
    });
    expect(reports[0]?.demonstrated[0]).toMatchObject({
      slug: "bong-joon-ho",
      citations: [{ sourceId: source.id, quote: text }],
    });
    const scenario = {
      id: "film-intersection",
      categories: ["directing", "screenwriting"],
      expected: [{ slug: "bong-joon-ho", factIds: ["debut", "shared-screenplay"] }],
      rationale: "Controlled fixture.",
    };
    const population = [
      { slug: "bong-joon-ho", profileId: bong.id },
      { slug: "other", profileId: other.id },
    ];
    const carriedJudge = async (): Promise<never> => {
      throw new Error("Completed scenario must stay frozen.");
    };
    const carried = new Map([[scenario.id, reports[0]]]);
    expect(
      await evaluateCollection(people, population, [scenario], {
        references,
        judge: carriedJudge,
        carried,
      }),
    ).toEqual(reports);
    await expect(
      evaluateCollection(
        people,
        population,
        [{ ...scenario, categories: ["unmatched-category"] }],
        { references, judge: carriedJudge, carried },
      ),
    ).rejects.toThrow("recomputed query");
    const rejected = await evaluateCollection(
      people,
      [
        { slug: "bong-joon-ho", profileId: bong.id },
        { slug: "other", profileId: other.id },
      ],
      [
        {
          id: "film-intersection",
          categories: ["directing", "screenwriting"],
          expected: [{ slug: "bong-joon-ho", factIds: ["debut", "shared-screenplay"] }],
          rationale: "Controlled fixture.",
        },
      ],
      {
        references,
        judge: async () => ({
          ...assessment,
          verdict: "unsupported",
          rationale: "The supplied evidence does not justify the intersection.",
        }),
      },
    );
    expect(rejected[0]?.recoveredMatches).toEqual([]);
    expect(rejected[0]?.demonstrated).toHaveLength(1);
    expect(rejected[0]?.assessmentStatus).toBe("completed");
    const failedJudge = await evaluateCollection(
      people,
      [
        { slug: "bong-joon-ho", profileId: bong.id },
        { slug: "other", profileId: other.id },
      ],
      [
        {
          id: "film-intersection",
          categories: ["directing", "screenwriting"],
          expected: [{ slug: "bong-joon-ho", factIds: ["debut", "shared-screenplay"] }],
          rationale: "Controlled fixture.",
        },
      ],
      {
        references,
        judge: async () => {
          throw new Error("Judge unavailable");
        },
      },
    );
    expect(failedJudge[0]?.assessmentStatus).toBe("failed");
    expect(failedJudge[0]?.recoveredMatches).toEqual([]);
    expect(failedJudge[0]?.assessments[0]?.verdict).toBe("ambiguous");
    people.dossiers.detach(bong.id, source.id);
    const after = await evaluateCollection(
      people,
      [
        { slug: "bong-joon-ho", profileId: bong.id },
        { slug: "other", profileId: other.id },
      ],
      [
        {
          id: "film-intersection",
          categories: ["directing", "screenwriting"],
          expected: [{ slug: "bong-joon-ho", factIds: ["debut", "shared-screenplay"] }],
          rationale: "Controlled fixture.",
        },
      ],
      { references, judge },
    );
    expect(after[0]?.recoveredMatches).toEqual([]);
    expect(after[0]?.missingMatches).toEqual(["bong-joon-ho"]);
    expect(after[0]?.coverage.activeProfiles).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("loads evidence-linked real collection scenarios as part of the immutable reference version", async () => {
  const { loadCorpus } = await import("../../../apps/server/src/person-benchmark/corpus");
  const corpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  expect(corpus.rejected).toEqual([]);
  expect(corpus.scenarios).toContainEqual(
    expect.objectContaining({
      id: "directing-and-screenwriting",
      categories: ["directing", "screenwriting"],
      expected: [{ slug: "bong-joon-ho", factIds: ["debut", "shared-screenplay"] }],
    }),
  );
});

it("rejects unknown scenario support and changes the reference version when its expectation changes", async () => {
  const { loadCorpus } = await import("../../../apps/server/src/person-benchmark/corpus");
  const real = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const root = mkdtempSync(join(tmpdir(), "benchmark-scenario-version-"));
  try {
    const directory = join(root, "people");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "bong.json"),
      JSON.stringify(real.people.find((person) => person.slug === "bong-joon-ho")),
    );
    const path = join(root, "collection-scenarios.json");
    const scenario = real.scenarios[0];
    writeFileSync(path, JSON.stringify([scenario]));
    const before = loadCorpus(directory);
    expect(before.rejected).toEqual([]);
    writeFileSync(
      path,
      JSON.stringify([{ ...scenario, categories: ["screenwriting", "film directing"] }]),
    );
    expect(loadCorpus(directory).version).not.toBe(before.version);
    writeFileSync(
      path,
      JSON.stringify([
        { ...scenario, expected: [{ slug: "bong-joon-ho", factIds: ["invented-credit"] }] },
      ]),
    );
    expect(loadCorpus(directory).rejected).toContainEqual(
      expect.objectContaining({
        reason: expect.stringContaining("unknown person or reference fact"),
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects duplicate person slugs instead of silently evaluating one copy", async () => {
  const { loadCorpus } = await import("../../../apps/server/src/person-benchmark/corpus");
  const real = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const root = mkdtempSync(join(tmpdir(), "benchmark-duplicate-slug-"));
  try {
    const directory = join(root, "people");
    mkdirSync(directory);
    const person = real.people.find((entry) => entry.slug === "bong-joon-ho");
    writeFileSync(join(directory, "bong-a.json"), JSON.stringify(person));
    writeFileSync(join(directory, "bong-b.json"), JSON.stringify(person));
    const corpus = loadCorpus(directory);
    expect(corpus.people.map((entry) => entry.slug)).toEqual(["bong-joon-ho"]);
    expect(corpus.rejected).toContainEqual(
      expect.objectContaining({ reason: expect.stringMatching(/duplicate person slug/i) }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
