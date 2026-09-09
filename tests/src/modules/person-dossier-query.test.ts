import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PersonDossierQueries } from "../../../apps/server/src/person-profile/dossier-queries.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

test("workspace intersections distinguish demonstrated work from self-report and include sparse coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-query-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const dossiers = new PersonDossierStore(root);
    const maya = people.create({ fullName: "Maya" });
    const daniel = people.create({ fullName: "Daniel" });
    people.create({ fullName: "Unknown" });
    for (const [person, demonstrated] of [
      [maya, true],
      [daniel, false],
    ] as const) {
      const source = dossiers.retainSource({
        url: `https://example.com/${person.id}`,
        title: "Deployment",
        author: null,
        publishedAt: null,
        retrievedAt: "2026-09-05",
        text: demonstrated
          ? "Maya deployed the regulated system to 200 sites."
          : "Daniel lists deployment and regulation among his skills.",
        family: "example.com",
        sourceClass: demonstrated ? "primary-artifact" : "self-report",
        visibility: "public",
        completeness: "full",
        access: "retrieved",
        acquisition: "website",
      });
      const claim = {
        id: "c",
        statement: source.text,
        section: "expertise" as const,
        status: demonstrated ? ("supported" as const) : ("claimed" as const),
        nature: "statement" as const,
        matchConfidence: "high" as const,
        effectiveFrom: null,
        effectiveTo: null,
        citations: [{ sourceId: source.id, quote: source.text }],
        supports: [],
        supersedes: [],
        changeReason: null,
      };
      dossiers.publish(person.id, 0, {
        claims: [claim],
        works: demonstrated
          ? [
              {
                id: "work",
                title: "Regulated system",
                kind: "system",
                url: null,
                startedAt: null,
                endedAt: null,
                claimIds: ["c"],
                contribution: { text: "Deployed the system", claimIds: ["c"] },
                teamContribution: null,
                authority: [],
                scale: [
                  {
                    value: 200,
                    unit: "sites",
                    scope: "system deployment",
                    date: null,
                    claimIds: ["c"],
                  },
                ],
                constraints: [],
                outcomes: [],
              },
            ]
          : [],
        expertise: ["deployment", "regulation"].map((category) => ({
          category,
          originalWording: category,
          support: demonstrated ? "demonstrated" : "claimed",
          workIds: demonstrated ? ["work"] : [],
          claimIds: ["c"],
        })),
        connections: [],
        sections: [],
      });
    }
    const queries = new PersonDossierQueries({ people, dossiers });
    const result = queries.search({
      categories: ["deployment", "regulation"],
      visibility: "public",
    });
    expect(result.demonstrated.map((p) => p.profileId)).toEqual([maya.id]);
    expect(result.claimed.map((p) => p.profileId)).toEqual([daniel.id]);
    expect(result.coverage).toEqual({
      activeProfiles: 3,
      researchedProfiles: 2,
      demonstrated: 1,
      claimedOnly: 1,
    });
    expect(result.demonstrated[0]?.citations[0]?.quote).toContain("200 sites");
    people.archive(maya.id);
    expect(
      queries.search({ categories: ["deployment"], visibility: "public" }).demonstrated,
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("category queries keep undocumented-contribution work out of the demonstrated group", () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-contribution-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const dossiers = new PersonDossierStore(root);
    const maya = people.create({ fullName: "Maya" });
    const source = dossiers.retainSource({
      url: "https://example.com/team",
      title: "Team",
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-05",
      text: "The Northline team built its user interface.",
      family: "example.com",
      sourceClass: "independent-account",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "website",
    });
    dossiers.publish(maya.id, 0, {
      claims: [
        {
          id: "team",
          section: "work" as const,
          statement: "The Northline team built its user interface.",
          nature: "statement" as const,
          status: "supported" as const,
          citations: [
            { sourceId: source.id, quote: "The Northline team built its user interface." },
          ],
          matchConfidence: "high" as const,
          effectiveFrom: null,
          effectiveTo: null,
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [
        {
          id: "atlas",
          title: "Atlas",
          kind: "system" as const,
          url: null,
          startedAt: null,
          endedAt: null,
          claimIds: ["team"],
          contribution: null,
          teamContribution: null,
          authority: [],
          scale: [],
          constraints: [],
          outcomes: [],
        },
      ],
      expertise: [
        {
          category: "deployment",
          originalWording: "deployment",
          support: "demonstrated" as const,
          workIds: ["atlas"],
          claimIds: ["team"],
        },
      ],
      connections: [],
      sections: [],
    });
    const result = new PersonDossierQueries({ people, dossiers }).search({
      categories: ["deployment"],
      visibility: "public",
    });
    expect(result.demonstrated).toEqual([]);
    expect(result.claimed.map((match) => match.profileId)).toEqual([maya.id]);
    expect(result.claimed[0]?.gaps).toContain(
      "Individual contribution is undocumented for some work.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observed activity and repeated collaboration count distinct work rather than mirrored records", () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-activity-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ fullName: "Maya" });
    const dossiers = new PersonDossierStore(root);
    const source = dossiers.retainSource({
      url: "https://example.com/work",
      title: "Work",
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-05",
      text: "Maya and Daniel co-authored Atlas and Nova in 2024.",
      family: "example.com",
      sourceClass: "primary-artifact",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "website",
    });
    dossiers.publish(person.id, 0, {
      claims: [
        {
          id: "c",
          section: "connections",
          statement: source.text,
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: "2024",
          effectiveTo: null,
          citations: [{ sourceId: source.id, quote: source.text }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: ["atlas", "atlas-mirror", "nova"].map((id) => ({
        id,
        title: id.startsWith("atlas") ? "Atlas" : "Nova",
        url: id.startsWith("atlas") ? "https://example.com/atlas" : "https://example.com/nova",
        kind: "paper",
        startedAt: "2024-02-01",
        endedAt: null,
        claimIds: ["c"],
        contribution: null,
        teamContribution: null,
        authority: [],
        scale: [],
        constraints: [],
        outcomes: [],
      })),
      connections: [
        {
          id: "daniel",
          counterparty: "Daniel",
          profileId: null,
          kind: "co-authored",
          direction: "undirected",
          from: "2024",
          to: null,
          workIds: ["atlas", "atlas-mirror", "nova"],
          claimIds: ["c"],
        },
      ],
      expertise: [],
      sections: [],
    });
    const analysis = new PersonDossierQueries({ people, dossiers }).analyse(person.id, "public")!;
    expect(analysis.activity).toEqual([{ period: "2024-02", kind: "paper", count: 2 }]);
    expect(analysis.collaborations[0]?.distinctWorks).toBe(2);
    expect(analysis.quality.singleSourceClaims).toBe(1);
    const current = dossiers.get(person.id)!;
    dossiers.publish(person.id, current.revision, {
      ...current,
      connections: [
        ...current.connections,
        { ...current.connections[0], id: "different-daniel", from: "2025", workIds: ["nova"] },
      ],
    });
    const separated = new PersonDossierQueries({ people, dossiers }).analyse(person.id, "public")!;
    expect(separated.collaborations).toHaveLength(2);
    expect(separated.collaborations.map((entry) => entry.distinctWorks)).toEqual([2, 1]);
    dossiers.detach(person.id, source.id);
    const detached = new PersonDossierQueries({ people, dossiers }).analyse(person.id, "public")!;
    expect(detached.collaborations).toEqual([]);
    expect(detached.activity).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("connection paths use dated supported edges and disappear when an intermediate Profile is archived", () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-path-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const dossiers = new PersonDossierStore(root);
    const [maya, daniel, alex] = ["Maya", "Daniel", "Alex"].map((fullName) =>
      people.create({ fullName }),
    );
    for (const [from, to] of [
      [maya, daniel],
      [daniel, alex],
    ]) {
      const source = dossiers.retainSource({
        url: `https://example.com/${from.id}`,
        title: "Collaboration",
        author: null,
        publishedAt: "2024",
        retrievedAt: "2026-09-05",
        text: `${from.fullName} and ${to.fullName} co-authored Atlas.`,
        family: "example.com",
        sourceClass: "primary-artifact",
        visibility: "public",
        completeness: "full",
        access: "retrieved",
        acquisition: "website",
      });
      dossiers.publish(from.id, 0, {
        claims: [
          {
            id: "c",
            section: "connections",
            statement: source.text,
            status: "supported",
            nature: "statement",
            matchConfidence: "high",
            effectiveFrom: "2024",
            effectiveTo: null,
            citations: [{ sourceId: source.id, quote: source.text }],
            supports: [],
            supersedes: [],
            changeReason: null,
          },
        ],
        works: [],
        expertise: [],
        sections: [],
        connections: [
          {
            id: "edge",
            counterparty: to.fullName!,
            profileId: to.id,
            kind: "co-authored",
            direction: "undirected",
            from: "2024",
            to: null,
            workIds: [],
            claimIds: ["c"],
          },
        ],
      });
    }
    const queries = new PersonDossierQueries({ people, dossiers });
    const path = queries.connectionPath(maya.id, alex.id, "public");
    expect(path).toHaveLength(2);
    expect(path[0]?.kind).toBe("co-authored");
    expect(path[0]?.citations[0]?.quote).toContain("co-authored Atlas");
    people.archive(daniel.id);
    expect(queries.connectionPath(maya.id, alex.id, "public")).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
