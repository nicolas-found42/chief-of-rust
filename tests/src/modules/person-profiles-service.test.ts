import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type {
  PersonEvidence,
  PersonProfile,
  PersonProfileDependentConfiguration,
  PersonProfileResidualSourceArtifact,
} from "@chief-of-staff-demo/shared";
import { invalidationAffectsRevision } from "@chief-of-staff-demo/shared";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import {
  PersonProfileValidationError,
  WorkspacePersonProfiles,
  type PersonProfileLifecycleRegistry,
  type PersonProfileRegistryDeletionCounts,
} from "../../../apps/server/src/person-profile/profiles";

/**
 * The Person Profiles deep interface (spec #117, Deep interfaces item 1): its
 * observable operations — search, explicit creation, current/exact-revision
 * retrieval, and purpose-specific projections — are the test surface. Matching
 * indexes, revision writes, and provenance bookkeeping stay behind it.
 */
const NOW = new Date("2026-08-31T16:00:00.000Z");

function makeService(dir = mkdtempSync(join(tmpdir(), "person-profiles-svc-"))) {
  return new WorkspacePersonProfiles({
    store: new PersonProfileStore(dir),
    now: () => NOW,
    lifecycle: [],
  });
}

function validationCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PersonProfileValidationError);
    return (error as PersonProfileValidationError).code;
  }
  throw new Error("expected a PersonProfileValidationError");
}

function evidence(overrides: Partial<PersonEvidence>): PersonEvidence {
  return {
    id: "ev_1",
    source: "public-web",
    kind: "publication",
    title: "A published talk",
    summary: "Spoke about evidence-backed identity.",
    url: "https://example.com/talks/identity",
    identitySignals: { emails: [], fullNames: [], handles: {}, profileUrls: [], employerHints: [] },
    claims: {},
    matchConfidence: "high",
    matchedSignals: ["fullName:ada lovelace"],
    observedAt: "2026-08-30T08:00:00.000Z",
    ...overrides,
  };
}

function richProfile(overrides: Partial<PersonProfile> = {}): PersonProfile {
  return {
    id: "person_ada",
    revision: 2,
    createdAt: "2026-08-29T08:00:00.000Z",
    updatedAt: "2026-08-30T08:00:00.000Z",
    fullName: "Ada Lovelace",
    primaryEmail: "ada@example.com",
    emails: ["ada@example.com"],
    handles: { bluesky: ["ada"] },
    profileUrls: ["https://example.com/~ada"],
    employerHints: ["Analytical Engines Ltd"],
    role: "Engineer",
    background: "Writes about computation.",
    currentEmployer: "Analytical Engines Ltd",
    socialProfiles: [{ platform: "bluesky", handle: "ada", url: "https://bsky.app/profile/ada" }],
    websites: ["https://example.com/~ada"],
    feeds: [{ url: "https://example.com/~ada/feed.xml", title: "Ada's notes" }],
    publications: [evidence({})],
    mentions: [
      evidence({
        id: "ev_mention",
        kind: "mention",
        url: "https://news.example.com/ada-profile",
        title: "Someone wrote about Ada",
      }),
    ],
    evidence: [
      evidence({}),
      evidence({
        id: "ev_identity",
        kind: "identity",
        source: "hubspot",
        title: "CRM contact record",
        url: "https://app.hubspot.com/contacts/1",
        identitySignals: {
          emails: ["ada@example.com"],
          fullNames: [],
          handles: {},
          profileUrls: [],
          employerHints: [],
        },
      }),
    ],
    sourceDiagnostics: [{ source: "public-web", status: "completed", detail: "3 results" }],
    archivedAt: null,
    ...overrides,
  };
}

describe("WorkspacePersonProfiles.search", () => {
  it("finds active profiles by name, email, and employer, case-insensitively", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
      currentEmployer: "US Navy",
    });
    expect(profiles.search({ query: "grace hopper" }).map((p) => p.id)).toEqual([created.id]);
    expect(profiles.search({ query: "GRACE@EXAMPLE.COM" }).map((p) => p.id)).toEqual([created.id]);
    expect(profiles.search({ query: "navy" }).map((p) => p.id)).toEqual([created.id]);
    expect(profiles.search({ query: "nobody" })).toEqual([]);
  });

  it("searches archived Profiles only when the caller asks for them", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-arch-")));
    store.save(richProfile({ id: "person_ada", archivedAt: "2026-08-30T09:00:00.000Z" }));
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });

    expect(profiles.search({ query: "ada" })).toEqual([]);
    const found = profiles.search({ query: "ada", includeArchived: true });
    expect(found).toHaveLength(1);
    expect(found[0].archivedAt).toBe("2026-08-30T09:00:00.000Z");
  });
});

/**
 * One local Workspace holder of Profile references. Every lifecycle test states
 * exactly what it registers; nothing is inferred from a default.
 */
function registry(
  entries: Partial<{
    dependentConfigurations: PersonProfileDependentConfiguration[];
    residualSourceArtifacts: PersonProfileResidualSourceArtifact[];
    removed: Partial<PersonProfileRegistryDeletionCounts>;
    purged: string[];
  }> = {},
): PersonProfileLifecycleRegistry {
  return {
    inspect: () => ({
      dependentConfigurations: entries.dependentConfigurations ?? [],
      residualSourceArtifacts: entries.residualSourceArtifacts ?? [],
    }),
    privacyDelete: (profileId) => {
      entries.purged?.push(profileId);
      return {
        aliases: 0,
        candidates: 0,
        mappings: 0,
        decisions: 0,
        activeLinks: 0,
        personSnapshots: 0,
        ...entries.removed,
      };
    },
  };
}

const ACTIVE_WATCH: PersonProfileDependentConfiguration = fromPartial({
  id: "watch_ada",
  consumer: "content-research",
  label: "Ada weekly watch",
  state: "active",
  availableActions: ["pause", "repoint"],
});

const RESIDUAL_SOURCES: PersonProfileResidualSourceArtifact[] = [
  fromPartial({ artifactId: "transcript_42", kind: "transcript", separateDeleteSupported: true }),
  fromPartial({
    artifactId: "source_item_7",
    kind: "public-source",
    separateDeleteSupported: false,
  }),
];

describe("WorkspacePersonProfiles archive lifecycle", () => {
  it("archives and restores a Profile while preventing every new consumer projection", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });

    const archived = profiles.archive(created.id);

    expect(archived.archivedAt).toBe(NOW.toISOString());
    expect(profiles.search()).toEqual([]);
    expect(profiles.project("public-safe", created.id)).toBeNull();
    expect(profiles.project("meeting", created.id, { revision: created.revision })).toBeNull();
    expect(
      validationCode(() => profiles.ensureCalendarAttendeeProfile({ email: "grace@example.com" })),
    ).toBe("conflicting-identity");
    /* Archive is lifecycle state, not erasure: the factual history it was
       archived with stays exactly readable. */
    expect(profiles.getRevision(created.id, created.revision)?.fullName).toBe("Grace Hopper");

    const restored = profiles.restore(created.id);

    expect(restored.archivedAt).toBeNull();
    expect(profiles.project("public-safe", created.id)?.profileRevision).toBe(created.revision);
    expect(profiles.search().map((profile) => profile.id)).toEqual([created.id]);
  });

  it("refuses to archive over active dependent configuration and names the pause or re-point actions", () => {
    const dir = mkdtempSync(join(tmpdir(), "person-profiles-dependencies-"));
    const profiles = new WorkspacePersonProfiles({
      store: new PersonProfileStore(dir),
      now: () => NOW,
      lifecycle: [registry({ dependentConfigurations: [ACTIVE_WATCH] })],
    });
    const created = profiles.create({ fullName: "Ada Lovelace" });

    expect(profiles.lifecycle(created.id).dependentConfigurations).toEqual([
      expect.objectContaining({
        id: "watch_ada",
        consumer: "content-research",
        state: "active",
        availableActions: ["pause", "repoint"],
      }),
    ]);
    expect(validationCode(() => profiles.archive(created.id))).toBe("active-dependencies");
    expect(profiles.get(created.id)?.archivedAt).toBeNull();
  });
});

describe("WorkspacePersonProfiles privacy deletion", () => {
  function deletable(registries: PersonProfileLifecycleRegistry[]): WorkspacePersonProfiles {
    const dir = mkdtempSync(join(tmpdir(), "person-profiles-privacy-delete-"));
    const store = new PersonProfileStore(dir);
    store.save(richProfile({ revision: 1 }));
    store.save(richProfile({ revision: 2 }));
    return new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: registries });
  }

  it("requires separate confirmation and purges structured local identity behind one seam", () => {
    const purged: string[] = [];
    const profiles = deletable([
      registry({
        residualSourceArtifacts: RESIDUAL_SOURCES,
        removed: { aliases: 3, candidates: 2, mappings: 1, decisions: 4 },
        purged,
      }),
      registry({ removed: { activeLinks: 2, personSnapshots: 2 }, purged }),
    ]);

    expect(
      validationCode(() => profiles.privacyDelete("person_ada", { confirmation: "archive" })),
    ).toBe("privacy-confirmation-required");
    expect(profiles.get("person_ada")?.fullName).toBe("Ada Lovelace");
    expect(purged).toEqual([]);

    const receipt = profiles.privacyDelete("person_ada", { confirmation: "DELETE PROFILE" });

    /* Every registered holder of Profile references is asked, and the receipt
       accounts for all of them together. */
    expect(purged).toEqual(["person_ada", "person_ada"]);
    expect(receipt.removed).toEqual({
      canonicalProfileRecords: 1,
      revisions: 2,
      evidence: 3,
      aliases: 3,
      candidates: 2,
      mappings: 1,
      decisions: 4,
      activeLinks: 2,
      personSnapshots: 2,
    });
    expect(receipt.remoteProviderOperations).toBe(0);
    expect(profiles.get("person_ada")).toBeNull();
    expect(profiles.revisions("person_ada")).toEqual([]);
    expect(profiles.project("meeting", "person_ada", { revision: 1 })).toBeNull();
  });

  it("discloses the immutable source documents that outlive the Profile", () => {
    const profiles = deletable([registry({ residualSourceArtifacts: RESIDUAL_SOURCES })]);

    /* The same disclosure backs the confirmation surface and the receipt. */
    expect(profiles.lifecycle("person_ada").residualSourceArtifacts).toEqual(RESIDUAL_SOURCES);

    const receipt = profiles.privacyDelete("person_ada", { confirmation: "DELETE PROFILE" });

    expect(receipt.residualSourceArtifacts).toEqual([
      { artifactId: "transcript_42", kind: "transcript", separateDeleteSupported: true },
      { artifactId: "source_item_7", kind: "public-source", separateDeleteSupported: false },
    ]);
  });

  it("refuses to privacy-delete over active dependent configuration", () => {
    const purged: string[] = [];
    const profiles = deletable([registry({ dependentConfigurations: [ACTIVE_WATCH], purged })]);

    expect(
      validationCode(() =>
        profiles.privacyDelete("person_ada", { confirmation: "DELETE PROFILE" }),
      ),
    ).toBe("active-dependencies");
    expect(purged).toEqual([]);
    expect(profiles.get("person_ada")?.fullName).toBe("Ada Lovelace");
    expect(profiles.tombstone("person_ada")).toBeNull();
  });

  it("leaves a tombstone and a persisted receipt that carry no identity content", () => {
    const profiles = deletable([registry({ residualSourceArtifacts: RESIDUAL_SOURCES })]);

    profiles.privacyDelete("person_ada", { confirmation: "DELETE PROFILE" });

    expect(profiles.tombstone("person_ada")).toEqual({
      profileId: "person_ada",
      deletedAt: NOW.toISOString(),
    });
    /* Shape only — an id, a time, counts, kinds and flags. No name, address,
       claim, evidence text, or source title survives at rest. */
    expect(Object.keys(profiles.tombstone("person_ada")!)).toEqual(["profileId", "deletedAt"]);
    const atRest = JSON.stringify({
      tombstone: profiles.tombstone("person_ada"),
      receipt: profiles.deletionReceipt("person_ada"),
    });
    for (const content of [
      "Ada Lovelace",
      "ada@example.com",
      "Analytical Engines",
      "Engineer",
      "Writes about computation.",
      "A published talk",
      "Spoke about evidence-backed identity.",
      "example.com/~ada",
    ])
      expect(atRest).not.toContain(content);
  });

  it("reaches no remote provider for any Profile lifecycle operation", () => {
    const profiles = deletable([registry({ residualSourceArtifacts: RESIDUAL_SOURCES })]);
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (input) => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return Promise.reject(new Error("no remote provider is reachable from a Profile operation"));
    };

    try {
      profiles.lifecycle("person_ada");
      profiles.archive("person_ada");
      profiles.restore("person_ada");
      const receipt = profiles.privacyDelete("person_ada", { confirmation: "DELETE PROFILE" });
      /* Local deletion never claims to have deleted anything remote. */
      expect(receipt.remoteProviderOperations).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toEqual([]);
  });
});

describe("WorkspacePersonProfiles.create", () => {
  it("creates a canonical Profile with an auditable first revision", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
      role: "Rear Admiral",
      currentEmployer: "US Navy",
    });

    expect(created.revision).toBe(1);
    expect(created.createdAt).toBe(NOW.toISOString());
    expect(created.updatedAt).toBe(NOW.toISOString());
    expect(created.fullName).toBe("Grace Hopper");
    expect(created.primaryEmail).toBe("grace@example.com");
    expect(created.emails).toEqual(["grace@example.com"]);
    expect(created.archivedAt).toBeNull();
    // The first revision is on disk exactly as returned, so the audit trail
    // starts at the creation moment itself.
    expect(profiles.getRevision(created.id, 1)).toEqual(created);
  });

  it("validates identity inputs and names the problem", () => {
    const profiles = makeService();

    expect(() => profiles.create({})).toThrow(PersonProfileValidationError);
    try {
      profiles.create({});
    } catch (error) {
      expect((error as PersonProfileValidationError).code).toBe("missing-identity-input");
    }
    try {
      profiles.create({ primaryEmail: "not-an-email" });
    } catch (error) {
      expect((error as PersonProfileValidationError).code).toBe("invalid-identity-input");
    }
    try {
      profiles.create({ fullName: "   " });
    } catch (error) {
      expect((error as PersonProfileValidationError).code).toBe("missing-identity-input");
    }
  });

  it("refuses to overwrite an existing canonical identity", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
    });
    const reread = profiles.get(created.id)!;

    expect(() =>
      profiles.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" }),
    ).toThrow(PersonProfileValidationError);
    // The refusal is durable: the stored profile was never touched.
    expect(profiles.get(created.id)).toEqual(reread);
    expect(profiles.getRevision(created.id, 2)).toBeNull();
  });

  it("lets two same-named people exist when a name is the only signal", () => {
    // A name alone is review material (spec #117), never an automatic identity collision.
    const profiles = makeService();
    const first = profiles.create({ fullName: "Alex Chen" });
    const second = profiles.create({ fullName: "Alex Chen" });
    expect(second.id).not.toBe(first.id);
    expect(profiles.search({ query: "alex chen" })).toHaveLength(2);
  });
});

describe("WorkspacePersonProfiles revision retrieval", () => {
  it("returns the current revision and any exact historical revision", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-rev-")));
    store.save(richProfile({ revision: 1, currentEmployer: "Analytical Engines Ltd" }));
    const current = richProfile({ revision: 2, currentEmployer: "Analytical Engines Co" });
    store.save(current);
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });

    expect(profiles.get("person_ada")).toEqual(current);
    expect(profiles.getRevision("person_ada", 1)?.currentEmployer).toBe("Analytical Engines Ltd");
    expect(profiles.getRevision("person_ada", 2)?.currentEmployer).toBe("Analytical Engines Co");
    expect(profiles.getRevision("person_ada", 3)).toBeNull();
    expect(profiles.get("person_unknown")).toBeNull();

    expect(profiles.revisions("person_ada").map((p) => p.revision)).toEqual([1, 2]);
    expect(profiles.revisions("person_unknown")).toEqual([]);
  });

  it("serves Profiles persisted before revisioned storage kept only current.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "person-profiles-legacy-"));
    const root = join(dir, "person-profiles", "person_legacy");
    mkdirSync(root, { recursive: true });
    const legacy = richProfile({ revision: 3 });
    writeFileSync(join(root, "current.json"), `${JSON.stringify(legacy, null, 2)}\n`);
    const profiles = new WorkspacePersonProfiles({
      store: new PersonProfileStore(dir),
      now: () => NOW,
      lifecycle: [],
    });

    expect(profiles.revisions("person_legacy").map((p) => p.revision)).toEqual([3]);
    expect(profiles.getRevision("person_legacy", 3)).toEqual(legacy);
    expect(profiles.project("public-safe", "person_legacy")?.profileRevision).toBe(3);
  });
});

describe("WorkspacePersonProfiles projections", () => {
  it("public-safe projection carries public facts and publishing surfaces only", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-pub-")));
    store.save(richProfile());
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });

    const projection = profiles.project("public-safe", "person_ada");
    expect(projection?.projectionVersion).toBe(1);
    expect(projection?.profileId).toBe("person_ada");
    expect(projection?.profileRevision).toBe(2);
    if (projection?.purpose !== "public-safe") throw new Error("expected public-safe projection");
    expect(projection.fullName).toBe("Ada Lovelace");
    expect(projection.role).toBe("Engineer");
    expect(projection.currentEmployer).toBe("Analytical Engines Ltd");
    expect(projection.background).toBe("Writes about computation.");
    expect(projection.socialProfiles).toHaveLength(1);
    expect(projection.websites).toEqual(["https://example.com/~ada"]);
    expect(projection.feeds).toEqual([
      { url: "https://example.com/~ada/feed.xml", title: "Ada's notes" },
    ]);
    expect(projection.publications).toHaveLength(1);
    // Provenance and confidence survive; the private payload around them does not.
    expect(projection.publications[0]).toMatchObject({
      source: "public-web",
      url: "https://example.com/talks/identity",
      matchConfidence: "high",
    });
    const rendered = JSON.stringify(projection);
    expect(rendered).not.toContain("ada@example.com");
    expect(rendered).not.toContain("hubspot");
    expect(rendered).not.toContain("CRM contact record");
    expect(rendered).not.toContain("news.example.com");
    expect(rendered).not.toContain('public-web", "status"');
  });

  it("meeting projection carries contact and evidence but not enrichment plumbing", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-meet-")));
    store.save(richProfile());
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });

    const projection = profiles.project("meeting", "person_ada");
    if (projection?.purpose !== "meeting") throw new Error("expected meeting projection");
    expect(projection.projectionVersion).toBe(1);
    expect(projection.primaryEmail).toBe("ada@example.com");
    expect(projection.emails).toEqual(["ada@example.com"]);
    expect(projection.mentions).toHaveLength(1);
    expect(projection.evidence.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["publication", "identity"]),
    );
    expect(projection.evidence[0].matchConfidence).toBe("high");
    const rendered = JSON.stringify(projection);
    expect(rendered).not.toContain("status"); // source diagnostics stay behind the interface
    expect(rendered).not.toContain("employerHints");
  });

  it("pins an exact historical revision and returns null for unknown profiles", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-pin-")));
    store.save(richProfile({ revision: 1, role: "Mathematician" }));
    store.save(richProfile({ revision: 2, role: "Engineer" }));
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });

    const pinned = profiles.project("public-safe", "person_ada", { revision: 1 });
    expect(pinned?.profileRevision).toBe(1);
    if (pinned?.purpose !== "public-safe") throw new Error("expected public-safe projection");
    expect(pinned.role).toBe("Mathematician");

    expect(profiles.project("public-safe", "person_unknown")).toBeNull();
    expect(profiles.project("meeting", "person_ada", { revision: 9 })).toBeNull();
  });
});
describe("WorkspacePersonProfiles.correct", () => {
  it("appends a revision for an ordinary factual correction and keeps the superseded snapshot readable", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "grace@example.com",
      role: "Rear Admiral",
    });

    const corrected = profiles.correct(created.id, {
      role: "Professor of Computer Science",
      note: "She was teaching at Vassar, not serving.",
    });

    expect(corrected.revision).toBe(2);
    expect(corrected.role).toBe("Professor of Computer Science");
    expect(corrected.fullName).toBe("Grace Hopper");
    expect(corrected.primaryEmail).toBe("grace@example.com");
    // The superseded snapshot is unchanged and exactly retrievable.
    expect(profiles.getRevision(created.id, 1)?.role).toBe("Rear Admiral");
    expect(profiles.revisions(created.id).map((p) => p.revision)).toEqual([1, 2]);
    // The correction is an audited invalidation of the superseded revision.
    expect(corrected.invalidations).toEqual([
      {
        id: "inv_1",
        kind: "correction",
        affectedRevision: 1,
        affectedRevisions: [1],
        occurredAt: NOW.toISOString(),
        detail: "She was teaching at Vassar, not serving.",
      },
    ]);
    expect(profiles.get(created.id)).toEqual(corrected);
  });

  it("names the problem for a missing Profile, an empty correction, a bad email, or a taken email", () => {
    const profiles = makeService();
    const created = profiles.create({ fullName: "Grace Hopper" });
    profiles.create({ fullName: "Ada Lovelace", primaryEmail: "ada@example.com" });

    expect(validationCode(() => profiles.correct("person_unknown", { role: "x" }))).toBe(
      "profile-not-found",
    );
    expect(validationCode(() => profiles.correct(created.id, {}))).toBe("nothing-to-correct");
    expect(
      validationCode(() => profiles.correct(created.id, { primaryEmail: "not-an-email" })),
    ).toBe("invalid-identity-input");
    expect(
      validationCode(() => profiles.correct(created.id, { primaryEmail: "ada@example.com" })),
    ).toBe("duplicate-profile");
    // Refusals are durable: no revision was appended.
    expect(profiles.revisions(created.id).map((p) => p.revision)).toEqual([1]);
  });

  it("generates an audit detail when the owner records none", () => {
    const profiles = makeService();
    const created = profiles.create({ fullName: "Grace Hopper", role: "Rear Admiral" });
    const corrected = profiles.correct(created.id, { role: "Professor of Computer Science" });
    expect(corrected.invalidations?.[0]?.detail).toContain("superseded");
  });

  it("explicitly clears false nullable facts while preserving the superseded snapshot", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      role: "Rear Admiral",
      currentEmployer: "US Navy",
      background: "Incorrect background",
    });

    const corrected = profiles.correct(created.id, {
      role: null,
      currentEmployer: null,
      background: null,
      note: "These claims belonged to another person.",
    });

    expect(corrected).toMatchObject({
      revision: 2,
      role: null,
      currentEmployer: null,
      background: null,
    });
    expect(profiles.getRevision(created.id, 1)).toMatchObject({
      role: "Rear Admiral",
      currentEmployer: "US Navy",
      background: "Incorrect background",
    });
    expect(corrected.invalidations?.at(-1)?.detail).toBe(
      "These claims belonged to another person.",
    );
  });

  it("removes a false primary email from current identity signals while preserving history", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "wrong@example.com",
    });

    const cleared = profiles.correct(created.id, {
      primaryEmail: null,
      note: "That address belongs to a different Grace Hopper.",
    });

    expect(cleared).toMatchObject({ revision: 2, primaryEmail: null, emails: [] });
    expect(profiles.getRevision(created.id, 1)).toMatchObject({
      primaryEmail: "wrong@example.com",
      emails: ["wrong@example.com"],
    });
    expect(cleared.invalidations?.at(-1)?.detail).toBe(
      "That address belongs to a different Grace Hopper.",
    );
    const actualOwner = profiles.create({
      fullName: "Grace Hopper II",
      primaryEmail: "wrong@example.com",
    });
    expect(actualOwner.primaryEmail).toBe("wrong@example.com");
  });

  it("replaces a false primary email without retaining the old address as a current signal", () => {
    const profiles = makeService();
    const created = profiles.create({
      fullName: "Grace Hopper",
      primaryEmail: "wrong@example.com",
    });

    const corrected = profiles.correct(created.id, { primaryEmail: "grace@example.com" });

    expect(corrected.primaryEmail).toBe("grace@example.com");
    expect(corrected.emails).toEqual(["grace@example.com"]);
    expect(profiles.getRevision(created.id, 1)?.emails).toEqual(["wrong@example.com"]);
  });
});
describe("WorkspacePersonProfiles.merge", () => {
  function seedPair(duplicateOverrides: Partial<PersonProfile> = {}) {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-merge-")));
    store.save(richProfile());
    const duplicate = richProfile({
      id: "person_ada2",
      revision: 1,
      primaryEmail: null,
      emails: [],
      role: null,
      currentEmployer: null,
      handles: {},
      profileUrls: [],
      socialProfiles: [],
      websites: ["https://ada.example.org"],
      employerHints: ["Ada Lovelace Institute"],
      background: null,
      publications: [
        evidence({
          id: "ev_dup_pub",
          title: "Notes on the Analytical Engine",
          url: "https://example.org/notes",
        }),
      ],
      evidence: [],
      mentions: [],
      ...duplicateOverrides,
    });
    store.save(duplicate);
    return {
      profiles: new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] }),
      duplicate,
    };
  }

  it("merges a duplicate through an audited decision without losing provenance or signals", () => {
    const { profiles } = seedPair();

    const merged = profiles.merge("person_ada", {
      duplicateId: "person_ada2",
      note: "Duplicate shell; same person.",
    });

    expect(merged.revision).toBe(3);
    // The duplicate's evidence arrives with its original provenance intact.
    expect(merged.publications.map((item) => item.id)).toEqual(["ev_1", "ev_dup_pub"]);
    expect(merged.publications[1]).toMatchObject({
      source: "public-web",
      url: "https://example.org/notes",
      observedAt: "2026-08-30T08:00:00.000Z",
    });
    expect(merged.evidence.map((item) => item.id)).toEqual(["ev_1", "ev_identity"]);
    // Identity signals and sites union; nothing is dropped.
    expect(merged.websites).toEqual(["https://example.com/~ada", "https://ada.example.org"]);
    expect(merged.employerHints).toEqual(["Analytical Engines Ltd", "Ada Lovelace Institute"]);
    expect(merged.fullName).toBe("Ada Lovelace");
    // The merge decision is audited on the survivor.
    expect(merged.invalidations?.at(-1)).toMatchObject({
      kind: "merge",
      affectedRevision: 2,
      mergedFrom: "person_ada2",
      detail: "Duplicate shell; same person.",
    });
    // Consumer references to the merged-away id resolve to the redirect.
    const gone = profiles.get("person_ada2")!;
    expect(gone.mergedInto).toBe("person_ada");
    expect(gone.invalidations?.at(-1)).toMatchObject({
      kind: "merge",
      affectedRevision: 1,
      mergedInto: "person_ada",
    });
    // The merged-away Profile's history remains readable, but it no longer
    // serves a current projection.
    expect(profiles.getRevision("person_ada2", 1)?.websites).toEqual(["https://ada.example.org"]);
    expect(profiles.project("meeting", "person_ada2")).toBeNull();
  });

  it("refuses a merge that leaves conflicting facts unresolved, then applies explicit resolutions", () => {
    const { profiles } = seedPair({ role: "Countess of Lovelace" });

    expect(() => profiles.merge("person_ada", { duplicateId: "person_ada2" })).toThrow(
      PersonProfileValidationError,
    );
    try {
      profiles.merge("person_ada", { duplicateId: "person_ada2" });
    } catch (error) {
      expect((error as PersonProfileValidationError).code).toBe("merge-conflict");
    }
    // The refusal is durable on both sides.
    expect(profiles.get("person_ada")?.revision).toBe(2);
    expect(profiles.get("person_ada2")?.revision).toBe(1);

    const merged = profiles.merge("person_ada", {
      duplicateId: "person_ada2",
      resolutions: { role: "Countess of Lovelace" },
    });
    expect(merged.role).toBe("Countess of Lovelace");
    expect(merged.revision).toBe(3);
  });

  it("names the problem for unknown, self, and already-merged targets", () => {
    const { profiles } = seedPair();
    expect(
      validationCode(() => profiles.merge("person_ada", { duplicateId: "person_unknown" })),
    ).toBe("profile-not-found");
    expect(validationCode(() => profiles.merge("person_ada", { duplicateId: "person_ada" }))).toBe(
      "self-merge",
    );
    profiles.merge("person_ada", { duplicateId: "person_ada2" });
    expect(validationCode(() => profiles.merge("person_ada", { duplicateId: "person_ada2" }))).toBe(
      "profile-merged",
    );
  });
});
describe("WorkspacePersonProfiles.detachEvidence", () => {
  function seedWronglyAttributed() {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-detach-")));
    const wrong = richProfile();
    store.save(wrong);
    const correct = richProfile({
      id: "person_babbage",
      revision: 1,
      fullName: "Charles Babbage",
      primaryEmail: null,
      emails: [],
      handles: {},
      profileUrls: [],
      socialProfiles: [],
      websites: [],
      feeds: [],
      publications: [],
      mentions: [],
      evidence: [],
      employerHints: [],
      role: "Mathematician",
      background: null,
      currentEmployer: null,
    });
    store.save(correct);
    return {
      profiles: new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] }),
      wrong,
      correct,
    };
  }

  it("splits wrongly attached evidence to the correct Profile without keeping the old attribution as fact", () => {
    const { profiles, wrong } = seedWronglyAttributed();

    const split = profiles.detachEvidence(wrong.id, {
      evidenceId: "ev_mention",
      toProfileId: "person_babbage",
      note: "The news story is about Charles, not Ada.",
    });

    // The wrong Profile loses the evidence now; a revision records the change.
    expect(split.from.revision).toBe(3);
    expect(split.from.mentions).toEqual([]);
    // The old attribution is marked invalid, never silently erased...
    expect(split.from.invalidations?.at(-1)).toMatchObject({
      kind: "evidence-detached",
      affectedRevision: 2,
      evidenceId: "ev_mention",
      movedTo: "person_babbage",
      detail: "The news story is about Charles, not Ada.",
    });
    // ...and the historical revision still shows what was once believed.
    expect(profiles.getRevision(wrong.id, 2)?.mentions.map((item) => item.id)).toEqual([
      "ev_mention",
    ]);
    // The evidence moves with its provenance intact.
    expect(split.to?.revision).toBe(2);
    expect(split.to?.mentions.map((item) => item.id)).toEqual(["ev_mention"]);
    expect(split.to?.mentions[0]).toMatchObject({
      source: "public-web",
      url: "https://news.example.com/ada-profile",
    });
    expect(split.to?.invalidations?.at(-1)).toMatchObject({
      kind: "evidence-detached",
      affectedRevision: 1,
      evidenceId: "ev_mention",
      movedFrom: "person_ada",
    });
  });

  it("detaches evidence without a target and names the failures", () => {
    const { profiles, wrong } = seedWronglyAttributed();

    const detached = profiles.detachEvidence(wrong.id, {
      evidenceId: "ev_mention",
      note: "Not evidence about anyone in the workspace.",
    });
    expect(detached.to).toBeNull();
    expect(detached.from.mentions).toEqual([]);
    expect(detached.from.revision).toBe(3);
    expect(detached.from.invalidations?.at(-1)).toMatchObject({
      kind: "evidence-detached",
      evidenceId: "ev_mention",
    });

    expect(
      validationCode(() => profiles.detachEvidence("person_unknown", { evidenceId: "x" })),
    ).toBe("profile-not-found");
    expect(validationCode(() => profiles.detachEvidence(wrong.id, { evidenceId: "nope" }))).toBe(
      "evidence-not-found",
    );
    expect(
      validationCode(() =>
        profiles.detachEvidence(wrong.id, { evidenceId: "ev_mention", toProfileId: "unknown" }),
      ),
    ).toBe("profile-not-found");
    // Refusals are durable: no revision was appended for the failed detach.
    expect(profiles.get(wrong.id)?.revision).toBe(3);
  });

  it.each(["publications", "mentions"] as const)(
    "removes and re-attributes resolver-shaped %s duplicated in general evidence",
    (collection) => {
      const store = new PersonProfileStore(
        mkdtempSync(join(tmpdir(), "person-profiles-resolver-detach-")),
      );
      const duplicated = evidence({
        id: `ev_resolver_${collection}`,
        kind: collection === "publications" ? "publication" : "mention",
      });
      store.save(
        richProfile({
          [collection]: [duplicated],
          evidence: [duplicated],
        }),
      );
      store.save(
        richProfile({
          id: "person_correct",
          revision: 1,
          primaryEmail: null,
          emails: [],
          publications: [],
          mentions: [],
          evidence: [],
        }),
      );
      const profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });

      const split = profiles.detachEvidence("person_ada", {
        evidenceId: duplicated.id,
        toProfileId: "person_correct",
      });

      expect(split.from[collection]).toEqual([]);
      expect(split.from.evidence).toEqual([]);
      expect(split.to?.[collection].map((item) => item.id)).toEqual([duplicated.id]);
      expect(split.to?.evidence.map((item) => item.id)).toEqual([duplicated.id]);
      const publicProjection = profiles.project("public-safe", "person_ada");
      const meetingProjection = profiles.project("meeting", "person_ada");
      expect(
        publicProjection?.purpose === "public-safe"
          ? publicProjection.publications.map((item) => item.id)
          : [],
      ).not.toContain(duplicated.id);
      expect(
        meetingProjection?.purpose === "meeting"
          ? [
              ...meetingProjection.publications,
              ...meetingProjection.mentions,
              ...meetingProjection.evidence,
            ].map((item) => item.id)
          : [],
      ).not.toContain(duplicated.id);
    },
  );
});
describe("WorkspacePersonProfiles invalidation disclosure", () => {
  it("uses one compatibility rule for legacy and multi-revision invalidations", () => {
    const legacy = {
      id: "inv_legacy",
      kind: "correction" as const,
      affectedRevision: 2,
      occurredAt: NOW.toISOString(),
      detail: "Legacy repair",
    };
    const current = { ...legacy, id: "inv_current", affectedRevisions: [1, 2] };

    expect(invalidationAffectsRevision(legacy, 1)).toBe(false);
    expect(invalidationAffectsRevision(legacy, 2)).toBe(true);
    expect(invalidationAffectsRevision(current, 1)).toBe(true);
    expect(invalidationAffectsRevision(current, 3)).toBe(false);
  });

  function supersededStore() {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-inval-")));
    store.save(richProfile({ revision: 1, role: "Mathematician" }));
    store.save(richProfile({ revision: 2, role: "Engineer" }));
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });
    profiles.correct("person_ada", { role: "Countess of Lovelace", note: "She was a countess." });
    return profiles;
  }

  it("discloses on an exact-revision projection that its facts have since been superseded", () => {
    const profiles = supersededStore();

    // The current projection is clean: its facts are the ones to hold.
    const current = profiles.project("public-safe", "person_ada");
    expect(current?.invalidations).toBeUndefined();

    // The superseded revision stays readable and says so.
    const pinned = profiles.project("public-safe", "person_ada", { revision: 2 });
    expect(pinned?.invalidations).toHaveLength(1);
    expect(pinned?.invalidations?.[0]).toMatchObject({
      kind: "correction",
      affectedRevision: 2,
      detail: "She was a countess.",
    });
  });

  it("marks an affected pinned consumer revision for explicit refresh", () => {
    const profiles = makeService();
    const created = profiles.create({ fullName: "Grace Hopper", role: "Rear Admiral" });

    expect(profiles.consumerState(created.id, 1)).toMatchObject({
      profileId: created.id,
      profileRevision: 1,
      currentProfileId: created.id,
      currentProfileRevision: 1,
      refreshRequired: false,
      invalidations: [],
    });

    profiles.correct(created.id, { role: "Professor" });

    expect(profiles.consumerState(created.id, 1)).toMatchObject({
      profileId: created.id,
      profileRevision: 1,
      currentProfileId: created.id,
      currentProfileRevision: 2,
      refreshRequired: true,
      invalidations: [{ kind: "correction", affectedRevision: 1 }],
    });
    expect(profiles.consumerState(created.id, 9)).toBeNull();
  });

  it("invalidates every historical revision whose claims may survive a later correction", () => {
    const profiles = makeService();
    const created = profiles.create({ fullName: "Grace Hopper", role: "Rear Admiral" });
    profiles.correct(created.id, { background: "Computer pioneer" });
    profiles.correct(created.id, { role: "Professor" });

    expect(profiles.consumerState(created.id, 1)).toMatchObject({
      refreshRequired: true,
      invalidations: [
        { kind: "correction", affectedRevision: 1 },
        { kind: "correction", affectedRevision: 2, affectedRevisions: [1, 2] },
      ],
    });
    expect(profiles.consumerState(created.id, 2)).toMatchObject({
      refreshRequired: true,
      invalidations: [{ kind: "correction", affectedRevision: 2, affectedRevisions: [1, 2] }],
    });
  });

  it("invalidates older consumer pins after a later merge and detach", () => {
    const store = new PersonProfileStore(mkdtempSync(join(tmpdir(), "person-profiles-history-")));
    store.save(richProfile({ revision: 1 }));
    store.save(richProfile({ revision: 2, background: "Second revision" }));
    store.save(
      richProfile({
        id: "person_duplicate",
        revision: 1,
        primaryEmail: null,
        emails: [],
        publications: [],
        mentions: [],
        evidence: [],
      }),
    );
    const profiles = new WorkspacePersonProfiles({ store, now: () => NOW, lifecycle: [] });

    profiles.merge("person_ada", {
      duplicateId: "person_duplicate",
      resolutions: { background: "Second revision" },
    });
    expect(profiles.consumerState("person_ada", 1)?.invalidations).toContainEqual(
      expect.objectContaining({
        kind: "merge",
        affectedRevision: 2,
        affectedRevisions: [1, 2],
        mergedFrom: "person_duplicate",
      }),
    );

    profiles.detachEvidence("person_ada", { evidenceId: "ev_mention" });
    expect(profiles.consumerState("person_ada", 1)?.invalidations).toContainEqual(
      expect.objectContaining({
        kind: "evidence-detached",
        affectedRevision: 3,
        affectedRevisions: [1, 2, 3],
        evidenceId: "ev_mention",
      }),
    );
  });

  it("redirects a merged-away consumer pin to the surviving Profile for refresh", () => {
    const profiles = makeService();
    const survivor = profiles.create({ fullName: "Grace Hopper" });
    const duplicate = profiles.create({ fullName: "Grace Hopper" });

    profiles.merge(survivor.id, { duplicateId: duplicate.id });

    expect(profiles.consumerState(duplicate.id, 1)).toMatchObject({
      profileId: duplicate.id,
      profileRevision: 1,
      currentProfileId: survivor.id,
      currentProfileRevision: 2,
      refreshRequired: true,
      invalidations: [{ kind: "merge", mergedInto: survivor.id, affectedRevision: 1 }],
    });
  });

  it("exposes the append-only invalidation log for consumers polling for refresh", () => {
    const profiles = supersededStore();
    const duplicate = profiles.create({ fullName: "Ada Lovelace" });
    profiles.merge("person_ada", { duplicateId: duplicate.id, note: "One person." });

    expect(profiles.invalidations("person_ada").map((record) => record.kind)).toEqual([
      "correction",
      "merge",
    ]);
    expect(profiles.invalidations("person_unknown")).toEqual([]);
  });
});
