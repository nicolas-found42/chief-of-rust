import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type {
  PersonClaim,
  PersonDossier,
  PersonDossierAnalysis,
} from "@chief-of-staff-demo/shared";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { PersonDossierQueries } from "../../../apps/server/src/person-profile/dossier-queries.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

/* The reviewed acceptance matrix for issue #212: every one of the twenty
   dossier requirements in issue #204 is asserted twice — once where the
   corpus documents it, and once where the corpus does not. The missing case
   is the load-bearing half: a requirement is only met when the dossier can
   also say, without fabricating a value, that it does not know.
   docs/research/person-dossier-acceptance.md reads this table. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  url: string;
  text: string;
  extraction: unknown;
}

interface Corpus {
  dossier: PersonDossier;
  analysis: PersonDossierAnalysis;
  queries: PersonDossierQueries;
  people: WorkspacePersonProfiles;
  profileId: string;
}

function load(name: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/person-dossiers/${name}.json`, import.meta.url), "utf8"),
  ) as Fixture;
}

async function research(name: string, person: { fullName: string; primaryEmail: string }) {
  const fixture = load(name);
  const root = mkdtempSync(join(tmpdir(), "dossier-acceptance-"));
  roots.push(root);
  const dossiers = new PersonDossierStore(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const profile = people.create(person);
  people.create({ fullName: "An unresearched person" });
  await new PersonResearch({
    dossiers,
    search: async () => [{ url: fixture.url, title: "Fictional source", snippet: "" }],
    /* Only the fixture's own URL exists. Continuous research follows the work
       URLs a matched source names, so a mock that answered every URL with the
       same body would extract the corpus several times over. */
    fetch: async (url) => ({
      url,
      status: url === fixture.url ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url === fixture.url ? fixture.text : "",
    }),
    complete: async () => fixture.extraction,
  }).run(profile, researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }));
  const queries = new PersonDossierQueries({ people, dossiers });
  return {
    dossier: dossiers.get(profile.id)!,
    analysis: queries.analyse(profile.id, "public")!,
    queries,
    people,
    profileId: profile.id,
  } satisfies Corpus;
}

const work = (corpus: Corpus, title: string) =>
  corpus.dossier.works.find((record) => record.title === title)!;
const section = (corpus: Corpus, key: PersonClaim["section"]) =>
  corpus.dossier.sections.find((entry) => entry.key === key)!;
const supported = (corpus: Corpus, key: PersonClaim["section"]) =>
  corpus.dossier.claims.filter((claim) => claim.section === key && claim.status === "supported");
const states = (corpus: Corpus, requirement: number) =>
  corpus.dossier.claims.filter((claim) =>
    claim.statement.startsWith(`Requirement ${requirement}:`),
  );

/** Each row is one requirement of #204, asserted where documented and where not. */
const matrix: {
  requirement: number;
  title: string;
  populated: (corpus: Corpus) => void;
  missing: (corpus: Corpus) => void;
}[] = [
  {
    requirement: 1,
    title: "Personal contribution separated from team output",
    populated: (corpus) => {
      const atlas = work(corpus, "Atlas");
      expect(atlas.contribution?.text).toBe("Designed the scheduler");
      expect(atlas.teamContribution?.text).toContain("user interface");
    },
    missing: (corpus) => {
      expect(work(corpus, "Beacon").contribution).toBeNull();
      expect(work(corpus, "Beacon").teamContribution).toBeNull();
    },
  },
  {
    requirement: 2,
    title: "Sourced operating magnitudes with value, unit, scope and dates",
    populated: (corpus) => {
      expect(work(corpus, "Atlas").scale).toContainEqual(
        expect.objectContaining({ value: 200, unit: "sites", scope: "Atlas deployment" }),
      );
      expect(work(corpus, "Atlas").scale.every((scale) => scale.date !== null)).toBe(true);
    },
    missing: (corpus) => expect(work(corpus, "Beacon").scale).toEqual([]),
  },
  {
    requirement: 3,
    title: "Claimed and demonstrated expertise in one taxonomy",
    populated: (corpus) => {
      const support = new Map(
        corpus.dossier.expertise.map((entry) => [entry.category, entry.support]),
      );
      expect(support.get("distributed scheduling")).toBe("demonstrated");
      expect(support.get("rust")).toBe("claimed");
      expect(corpus.dossier.expertise.every((entry) => entry.originalWording.length > 0)).toBe(
        true,
      );
    },
    missing: (corpus) => expect(corpus.dossier.expertise).toEqual([]),
  },
  {
    requirement: 4,
    title: "Named counterparties with relation type, shared work and dates",
    populated: (corpus) => {
      const daniel = corpus.dossier.connections.find(
        (connection) => connection.counterparty === "Daniel Ortiz",
      )!;
      expect(daniel.kind).toBe("co-authored");
      expect(daniel.from).toBe("2023");
      expect(daniel.workIds).toHaveLength(2);
    },
    missing: (corpus) => expect(corpus.dossier.connections).toEqual([]),
  },
  {
    requirement: 5,
    title: "Documented constraint environments",
    populated: (corpus) => expect(work(corpus, "Atlas").constraints[0]?.text).toContain("256 MB"),
    missing: (corpus) => expect(work(corpus, "Beacon").constraints).toEqual([]),
  },
  {
    requirement: 6,
    title: "Work followed after departure",
    populated: (corpus) =>
      expect(
        work(corpus, "Atlas").outcomes.filter((outcome) => outcome.afterDeparture),
      ).toContainEqual(expect.objectContaining({ date: "2025" })),
    missing: (corpus) =>
      expect(work(corpus, "Beacon").outcomes.some((outcome) => outcome.afterDeparture)).toBe(false),
  },
  {
    requirement: 7,
    title: "Dated history of problem areas and focus",
    populated: (corpus) =>
      expect(
        supported(corpus, "career")
          .map((claim) => claim.statement)
          .join(" "),
      ).toContain("2021"),
    missing: (corpus) => {
      expect(work(corpus, "Beacon").startedAt).toBeNull();
      expect(work(corpus, "Beacon").endedAt).toBeNull();
    },
  },
  {
    requirement: 8,
    title: "Writing and presentation kept separate from building",
    populated: (corpus) => {
      expect(work(corpus, "Nova").kind).toBe("paper");
      expect(work(corpus, "Nova").contribution).toBeNull();
      expect(work(corpus, "Atlas").kind).toBe("release");
    },
    missing: (corpus) =>
      expect(
        corpus.dossier.works.some((record) => ["paper", "talk", "post"].includes(record.kind)),
      ).toBe(false),
  },
  {
    requirement: 9,
    title: "Independent verifiers and the exact assertion verified",
    populated: (corpus) =>
      expect(
        supported(corpus, "recognition")
          .map((claim) => claim.statement)
          .join(" "),
      ).toContain("Audit Board"),
    missing: (corpus) => expect(supported(corpus, "recognition")).toEqual([]),
  },
  {
    requirement: 10,
    title: "Every section exposes research freshness and gaps",
    populated: (corpus) => {
      expect(corpus.dossier.sections).toHaveLength(8);
      expect(corpus.dossier.sections.every((entry) => entry.gaps.length > 0)).toBe(true);
      expect(corpus.dossier.sections.every((entry) => entry.state !== "current")).toBe(true);
    },
    missing: (corpus) => {
      expect(section(corpus, "expertise").state).toBe("incomplete");
      expect(section(corpus, "expertise").gaps.length).toBeGreaterThan(0);
    },
  },
  {
    requirement: 11,
    title: "Deciding, recommending and executing distinguished",
    populated: (corpus) =>
      expect(work(corpus, "Atlas").authority.map((entry) => entry.role)).toEqual([
        "recommended",
        "executed",
      ]),
    missing: (corpus) => expect(work(corpus, "Beacon").authority).toEqual([]),
  },
  {
    requirement: 12,
    title: "Unsuccessful work, shutdowns and postmortems",
    populated: (corpus) =>
      expect(work(corpus, "Atlas").outcomes.some((outcome) => outcome.unsuccessful)).toBe(true),
    missing: (corpus) =>
      expect(work(corpus, "Beacon").outcomes.some((outcome) => outcome.unsuccessful)).toBe(false),
  },
  {
    requirement: 13,
    title: "Repeated collaboration derived from distinct shared work",
    populated: (corpus) =>
      expect(corpus.analysis.collaborations).toContainEqual(
        expect.objectContaining({ counterparty: "Daniel Ortiz", distinctWorks: 2 }),
      ),
    missing: (corpus) => expect(corpus.analysis.collaborations).toEqual([]),
  },
  {
    requirement: 14,
    title: "Third-party credit and acknowledgments preserved",
    populated: (corpus) =>
      expect(
        supported(corpus, "recognition")
          .map((claim) => claim.statement)
          .join(" "),
      ).toContain("acknowledgment"),
    missing: (corpus) => expect(states(corpus, 14)).toHaveLength(1),
  },
  {
    requirement: 15,
    title: "Dated governance, funding and advisory relationships",
    populated: (corpus) => {
      expect(
        supported(corpus, "context")
          .map((claim) => claim.statement)
          .join(" "),
      ).toContain("advisory seat");
      expect(corpus.dossier.connections.map((connection) => connection.kind)).toContain("funded");
    },
    missing: (corpus) =>
      expect(
        corpus.dossier.connections.some((connection) =>
          ["board", "funded", "advised", "invested"].includes(connection.kind),
        ),
      ).toBe(false),
  },
  {
    requirement: 16,
    title: "Dated observed artifacts by kind, deduplicated and bounded",
    populated: (corpus) => {
      expect(corpus.analysis.activity).toEqual([
        { period: "2023-02", kind: "release", count: 1 },
        { period: "2024-03", kind: "paper", count: 1 },
      ]);
      expect(corpus.analysis.scope).toContain("total productivity");
    },
    missing: (corpus) => expect(corpus.analysis.activity).toEqual([]),
  },
  {
    requirement: 17,
    title: "Individually dated domain crossings",
    populated: (corpus) =>
      expect(
        supported(corpus, "career")
          .map((claim) => claim.statement)
          .join(" "),
      ).toContain("university research"),
    missing: (corpus) => expect(supported(corpus, "career")).toEqual([]),
  },
  {
    requirement: 18,
    title: "Capability intersections with denominators and coverage",
    populated: (corpus) =>
      expect(
        corpus.queries.search({
          categories: ["distributed scheduling"],
          visibility: "public",
        }).coverage,
      ).toEqual({ activeProfiles: 2, researchedProfiles: 1, demonstrated: 1, claimedOnly: 0 }),
    missing: (corpus) =>
      expect(
        corpus.queries.search({ categories: ["distributed scheduling"], visibility: "public" })
          .coverage,
      ).toEqual({ activeProfiles: 2, researchedProfiles: 1, demonstrated: 0, claimedOnly: 0 }),
  },
  {
    requirement: 19,
    title: "Documented availability constraints, with unknown fields left unknown",
    populated: (corpus) =>
      expect(
        supported(corpus, "context")
          .map((claim) => claim.statement)
          .join(" "),
      ).toContain("IP terms"),
    missing: (corpus) =>
      expect(
        corpus.queries.search({ query: "Beacon", visibility: "public" }).claimed[0]?.gaps,
      ).toEqual([
        "Individual contribution is undocumented for some work.",
        "Operating scale is unmeasured for some work.",
      ]),
  },
  {
    requirement: 20,
    title: "Source composition and single-source dependency per claim",
    populated: (corpus) => {
      expect(corpus.analysis.quality.singleSourceClaims).toBe(corpus.analysis.quality.totalClaims);
      expect(Object.keys(corpus.analysis.quality.composition)).toEqual(["independent-account"]);
    },
    missing: (corpus) => {
      expect(corpus.analysis.quality.unknownClaims).toBe(20);
      expect(corpus.analysis.quality.byClaim.every((entry) => entry.families.length <= 1)).toBe(
        true,
      );
    },
  },
];

test("every dossier requirement is asserted in a populated corpus and in a corpus that lacks it", async () => {
  const populated = await research("comprehensive", {
    fullName: "Maya Chen",
    primaryEmail: "maya@example.com",
  });
  const missing = await research("sparse", {
    fullName: "Rowan Vale",
    primaryEmail: "rowan@example.com",
  });
  expect(matrix.map((row) => row.requirement)).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  for (const row of matrix) {
    row.populated(populated);
    row.missing(missing);
    // The missing corpus states the gap rather than leaving the reader to infer it.
    expect(states(missing, row.requirement).map((claim) => claim.status)).toEqual(["unknown"]);
  }
});

test("a contradicted fact stays contested, keeps both accounts, and never overwrites the Profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-acceptance-conflict-"));
  roots.push(root);
  const dossiers = new PersonDossierStore(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "priya@example.com", role: "Chief Architect" });
  const value = (url: string) => (url.endsWith("registry") ? "Chief Architect" : "Advisor");
  /* Two registries and nothing else: any other URL is absent, so following a
     lead cannot silently re-read one of these two under a different name. */
  const text = (url: string) =>
    /\/(registry|directory)$/.test(url)
      ? `priya@example.com is recorded as ${value(url)} at Larkspur.`
      : "";
  await new PersonResearch({
    people,
    dossiers,
    search: async () =>
      ["registry", "directory"].map((path) => ({
        url: `https://example.com/${path}`,
        title: path,
        snippet: "",
      })),
    fetch: async (url) => ({
      url,
      status: text(url) ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: text(url),
    }),
    complete: async (request) => {
      const url = (JSON.parse(request.user) as { document: { url: string } }).document.url;
      return {
        fullName: null,
        employer: null,
        sourceClass: "independent-account",
        author: null,
        publishedAt: null,
        claims: [
          {
            id: "role",
            section: "context",
            statement: text(url),
            fact: { field: "role", value: value(url) },
            status: "supported",
            nature: "statement",
            matchConfidence: "high",
            effectiveFrom: null,
            effectiveTo: null,
            citations: [{ sourceId: "source", quote: text(url) }],
            supports: [],
            supersedes: [],
            changeReason: null,
          },
        ],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  }).run(person, researchAllowance({ maxModelCalls: 6, maxMilliseconds: 10000 }));
  const dossier = dossiers.get(person.id)!;
  expect(dossier.claims.map((claim) => claim.status)).toEqual(["contested", "contested"]);
  // Both accounts survive with their own passage; neither is resolved away.
  expect(new Set(dossier.claims.map((claim) => claim.fact?.value))).toEqual(
    new Set(["Chief Architect", "Advisor"]),
  );
  expect(
    new Set(dossier.claims.flatMap((claim) => claim.citations.map((p) => p.sourceId))).size,
  ).toBe(2);
  const context = dossier.sections.find((entry) => entry.key === "context")!;
  expect(context.summary.startsWith("Contested account: ")).toBe(true);
  expect(people.get(person.id)?.role).toBe("Chief Architect");
  expect(
    new PersonDossierQueries({ people, dossiers }).analyse(person.id, "public")?.quality
      .contestedClaims,
  ).toBe(2);
});
