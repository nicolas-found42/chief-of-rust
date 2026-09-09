import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type {
  ConfirmedOwnerReference,
  PersonProfile,
  PersonProfileDependentConfiguration,
  PersonProfileLifecycleState,
  PersonProfileProjection,
  PersonProfileResidualSourceArtifact,
  SourceItem,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { registerPeopleApi } from "../../../apps/server/src/api/people";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { PersonProfileResolver } from "../../../apps/server/src/person-profile/resolver";
import { WorkspacePersonProfileReferences } from "../../../apps/server/src/person-profile/references";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { openRuns } from "../../../apps/server/src/runs";
import { TranscriptCatalogStore } from "../../../apps/server/src/transcript-catalog/store";
import { ContentResearchStore } from "../../../apps/server/src/modules/content-research/store";

/**
 * The product namespace `/api/people/*` (spec #117): the same observable
 * Profile operations the module interface exposes, over a real server and a
 * temporary Workspace. No provider is reachable here — creation and retrieval
 * are Workspace-local operations.
 */
let app: FastifyInstance;
let workspaceDir: string;
let profiles: WorkspacePersonProfiles;
let store: PersonProfileStore;
/** What this Workspace's one consumer registry reports; set per test. */
let references: {
  dependentConfigurations: PersonProfileDependentConfiguration[];
  residualSourceArtifacts: PersonProfileResidualSourceArtifact[];
};

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-people-routes-"));
  store = new PersonProfileStore(workspaceDir);
  references = { dependentConfigurations: [], residualSourceArtifacts: [] };
  profiles = new WorkspacePersonProfiles({
    store,
    now: () => new Date("2026-08-31T16:00:00.000Z"),
    lifecycle: [
      {
        inspect: () => references,
        privacyDelete: () => ({
          aliases: 0,
          candidates: 0,
          mappings: 0,
          decisions: 0,
          activeLinks: 0,
          personSnapshots: 0,
        }),
      },
    ],
  });
  app = fastify();
  registerPeopleApi(app, {
    people: profiles,
    resolver: new PersonProfileResolver({ store, sources: [] }),
  });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function createGrace(): Promise<PersonProfile> {
  const response = await app.inject({
    method: "POST",
    url: "/api/people",
    payload: { fullName: "Grace Hopper", primaryEmail: "grace@example.com" },
  });
  expect(response.statusCode).toBe(201);
  return response.json<PersonProfile>();
}

describe("POST /api/people", () => {
  it("creates a Profile and returns its canonical state with the first revision", async () => {
    const created = await createGrace();
    expect(created.revision).toBe(1);
    expect(created.fullName).toBe("Grace Hopper");
    expect(created.primaryEmail).toBe("grace@example.com");
    expect(created.archivedAt).toBeNull();
  });

  it("classifies invalid identity inputs as 400, naming the problem", async () => {
    const missing = await app.inject({ method: "POST", url: "/api/people", payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "missing-identity-input" });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { primaryEmail: "not-an-email" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "invalid-identity-input" });

    const duplicate = await createGrace();
    const again = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { fullName: "Grace Hopper", primaryEmail: "grace@example.com" },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "duplicate-profile" });
    expect(profiles.get(duplicate.id)?.revision).toBe(1);
  });
});

describe("GET /api/people", () => {
  it("lists Profiles and applies the search query and archive filter", async () => {
    const created = await createGrace();
    const listed = await app.inject({ url: "/api/people" });
    expect(listed.json<PersonProfile[]>()).toHaveLength(1);

    const missed = await app.inject({ url: "/api/people?query=nobody" });
    expect(missed.json<PersonProfile[]>()).toEqual([]);

    const hit = await app.inject({ url: "/api/people?query=GRACE" });
    expect(hit.json<PersonProfile[]>()).toHaveLength(1);

    // An archived Profile stays out until the caller asks for archived state.
    store.save({ ...profiles.get(created.id)!, archivedAt: "2026-08-31T15:00:00.000Z" });
    const active = await app.inject({ url: "/api/people" });
    expect(active.json<PersonProfile[]>()).toEqual([]);
    const withArchived = await app.inject({ url: "/api/people?includeArchived=true" });
    expect(withArchived.json<PersonProfile[]>()).toHaveLength(1);
  });
});

describe("GET /api/people/:profileId", () => {
  it("returns the current Profile state and 404 for an unknown one", async () => {
    const created = await createGrace();
    const found = await app.inject({ url: `/api/people/${created.id}` });
    expect(found.statusCode).toBe(200);
    expect(found.json<PersonProfile>()).toEqual(created);

    const missing = await app.inject({ url: "/api/people/person_unknown" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "profile-not-found" });
  });
});

const ACTIVE_WATCH: PersonProfileDependentConfiguration = fromPartial({
  id: "watch_grace",
  consumer: "content-research",
  label: "Grace weekly watch",
  state: "active",
  availableActions: ["pause", "repoint"],
});

const RESIDUAL_TRANSCRIPT: PersonProfileResidualSourceArtifact = fromPartial({
  artifactId: "transcript_42",
  kind: "transcript",
  separateDeleteSupported: true,
});

describe("/api/people/:profileId lifecycle", () => {
  it("archives and restores explicitly, with archived Profiles unavailable to new consumers", async () => {
    const created = await createGrace();
    const preview = await app.inject({ url: `/api/people/${created.id}/lifecycle` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      profileId: created.id,
      archivedAt: null,
      dependentConfigurations: [],
    });

    const archived = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/archive`,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ archivedAt: "2026-08-31T16:00:00.000Z" });
    for (const purpose of ["public-safe", "meeting"] as const) {
      const unavailable = await app.inject({
        url: `/api/people/${created.id}/projection?purpose=${purpose}`,
      });
      expect(unavailable.statusCode).toBe(404);
    }
    const archivedPreview = await app.inject({ url: `/api/people/${created.id}/lifecycle` });
    expect(archivedPreview.statusCode).toBe(200);
    expect(archivedPreview.json()).toMatchObject({
      profileId: created.id,
      archivedAt: "2026-08-31T16:00:00.000Z",
    });
    const hidden = await app.inject({ url: "/api/people" });
    expect(hidden.json<PersonProfile[]>()).toEqual([]);
    const disclosed = await app.inject({ url: "/api/people?includeArchived=true" });
    expect(disclosed.json<PersonProfile[]>()).toHaveLength(1);

    const restored = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ archivedAt: null });
    const availableAgain = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=public-safe`,
    });
    expect(availableAgain.statusCode).toBe(200);
    expect(availableAgain.json()).toMatchObject({ profileRevision: created.revision });

    const listedAgain = await app.inject({ url: "/api/people" });
    expect(listedAgain.json<PersonProfile[]>()).toHaveLength(1);
  });

  it("refuses archive and privacy deletion while a dependent configuration is active, naming its actions", async () => {
    const created = await createGrace();
    references.dependentConfigurations = [{ ...ACTIVE_WATCH, profileId: created.id }];

    for (const url of [
      `/api/people/${created.id}/archive`,
      `/api/people/${created.id}/privacy-delete`,
    ]) {
      const refused = await app.inject({
        method: "POST",
        url,
        payload: { confirmation: "DELETE PROFILE" },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: "active-dependencies",
        lifecycle: {
          dependentConfigurations: [
            { id: "watch_grace", state: "active", availableActions: ["pause", "repoint"] },
          ],
        },
      });
    }
    const survivor = await app.inject({ url: `/api/people/${created.id}` });
    expect(survivor.statusCode).toBe(200);
    expect(survivor.json()).toMatchObject({ archivedAt: null });
  });

  it("discloses residual source documents on the confirmation refusal, before anything is deleted", async () => {
    const created = await createGrace();
    references.residualSourceArtifacts = [RESIDUAL_TRANSCRIPT];

    const refused = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/privacy-delete`,
      payload: { confirmation: "archive" },
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: "privacy-confirmation-required",
      lifecycle: {
        residualSourceArtifacts: [
          { artifactId: "transcript_42", kind: "transcript", separateDeleteSupported: true },
        ],
      },
    });
    expect((await app.inject({ url: `/api/people/${created.id}` })).statusCode).toBe(200);
  });

  it("privacy-deletes only after distinct confirmation and returns the residual-source receipt", async () => {
    const created = await createGrace();
    references.residualSourceArtifacts = [RESIDUAL_TRANSCRIPT];

    const deleted = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/privacy-delete`,
      payload: { confirmation: "DELETE PROFILE" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      profileId: created.id,
      remoteProviderOperations: 0,
      removed: { canonicalProfileRecords: 1, revisions: 1 },
      residualSourceArtifacts: [
        { artifactId: "transcript_42", kind: "transcript", separateDeleteSupported: true },
      ],
      tombstone: { profileId: created.id },
    });
    const gone = await app.inject({ url: `/api/people/${created.id}` });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({
      error: "profile-privacy-deleted",
      tombstone: { profileId: created.id },
      receipt: { remoteProviderOperations: 0 },
    });
    /* The tombstone keeps the reference resolvable; it names nobody. */
    expect(JSON.stringify(gone.json().tombstone)).not.toContain("Grace");
  });

  it("performs no remote provider operation while archiving or privacy-deleting", async () => {
    const created = await createGrace();
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return Promise.reject(new Error("no remote provider is reachable from a Profile operation"));
    };
    try {
      const archived = await app.inject({
        method: "POST",
        url: `/api/people/${created.id}/archive`,
      });
      expect(archived.statusCode).toBe(200);
      const deleted = await app.inject({
        method: "POST",
        url: `/api/people/${created.id}/privacy-delete`,
        payload: { confirmation: "DELETE PROFILE" },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ remoteProviderOperations: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual([]);
  });
});

describe("GET /api/people/:profileId/revisions", () => {
  it("lists every revision oldest-first and serves each exact revision", async () => {
    const created = await createGrace();
    const corrected: PersonProfile = {
      ...profiles.get(created.id)!,
      revision: 2,
      role: "Rear Admiral",
      updatedAt: "2026-08-31T17:00:00.000Z",
    };
    store.save(corrected);

    const list = await app.inject({ url: `/api/people/${created.id}/revisions` });
    expect(list.json<PersonProfile[]>().map((p) => p.revision)).toEqual([1, 2]);

    const first = await app.inject({ url: `/api/people/${created.id}/revisions/1` });
    expect(first.statusCode).toBe(200);
    expect(first.json<PersonProfile>().role).toBeNull();

    const second = await app.inject({ url: `/api/people/${created.id}/revisions/2` });
    expect(second.json<PersonProfile>().role).toBe("Rear Admiral");

    const unknown = await app.inject({ url: `/api/people/${created.id}/revisions/3` });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({ url: `/api/people/${created.id}/revisions/two` });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: "invalid-revision" });
  });
});

describe("GET /api/people/:profileId/projection", () => {
  it("serves purpose-specific projections and pins an exact revision on request", async () => {
    const created = await createGrace();

    const meeting = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=meeting`,
    });
    expect(meeting.statusCode).toBe(200);
    expect(meeting.json()).toMatchObject({ purpose: "meeting", projectionVersion: 1 });
    expect(meeting.json().primaryEmail).toBe("grace@example.com");

    const publicSafe = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=public-safe`,
    });
    expect(publicSafe.statusCode).toBe(200);
    const rendered = publicSafe.body;
    expect(rendered).not.toContain("grace@example.com");

    const pinned = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=meeting&revision=1`,
    });
    expect(pinned.json()).toMatchObject({ profileRevision: 1 });

    const badPurpose = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=everything`,
    });
    expect(badPurpose.statusCode).toBe(400);
    expect(badPurpose.json()).toMatchObject({ error: "invalid-purpose" });

    const badRevision = await app.inject({
      url: `/api/people/${created.id}/projection?purpose=meeting&revision=9`,
    });
    expect(badRevision.statusCode).toBe(404);

    const unknownProfile = await app.inject({
      url: "/api/people/person_unknown/projection?purpose=meeting",
    });
    expect(unknownProfile.statusCode).toBe(404);
  });
});
describe("POST /api/people/:profileId/corrections", () => {
  it("appends a correction revision and keeps the superseded snapshot readable", async () => {
    const seeded = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: {
        fullName: "Grace Hopper",
        primaryEmail: "grace@example.com",
        role: "Rear Admiral",
      },
    });
    const created = seeded.json<PersonProfile>();
    const response = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/corrections`,
      payload: { role: "Professor of Computer Science", note: "Teaching at Vassar." },
    });
    expect(response.statusCode).toBe(200);
    const corrected = response.json<PersonProfile>();
    expect(corrected).toMatchObject({ revision: 2, role: "Professor of Computer Science" });
    expect(corrected.invalidations?.[0]).toMatchObject({
      kind: "correction",
      affectedRevision: 1,
      detail: "Teaching at Vassar.",
    });

    const superseded = await app.inject({
      url: `/api/people/${created.id}/revisions/1`,
    });
    expect(superseded.json<PersonProfile>()).toMatchObject({ revision: 1, role: "Rear Admiral" });
  });

  it("classifies failures: unknown Profile, empty correction, and taken email", async () => {
    const created = await createGrace();

    const unknown = await app.inject({
      method: "POST",
      url: "/api/people/person_unknown/corrections",
      payload: { role: "x" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "profile-not-found" });

    const empty = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/corrections`,
      payload: { note: "no facts" },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: "nothing-to-correct" });

    await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { fullName: "Ada Lovelace", primaryEmail: "ada@example.com" },
    });
    const taken = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/corrections`,
      payload: { primaryEmail: "ada@example.com" },
    });
    expect(taken.statusCode).toBe(400);
    expect(taken.json()).toMatchObject({ error: "duplicate-profile" });
  });

  it("accepts explicit nulls to clear false nullable facts", async () => {
    const seeded = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: {
        fullName: "Grace Hopper",
        role: "Rear Admiral",
        currentEmployer: "US Navy",
        background: "Incorrect background",
      },
    });
    const created = seeded.json<PersonProfile>();

    const response = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/corrections`,
      payload: { role: null, currentEmployer: null, background: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<PersonProfile>()).toMatchObject({
      revision: 2,
      role: null,
      currentEmployer: null,
      background: null,
    });
  });

  it("accepts an explicit null to clear a false primary email and its current signal", async () => {
    const seeded = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { fullName: "Grace Hopper", primaryEmail: "wrong@example.com" },
    });
    const created = seeded.json<PersonProfile>();

    const response = await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/corrections`,
      payload: { primaryEmail: null, note: "Wrong person address." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<PersonProfile>()).toMatchObject({
      revision: 2,
      primaryEmail: null,
      emails: [],
      invalidations: [
        {
          kind: "correction",
          affectedRevision: 1,
          affectedRevisions: [1],
          detail: "Wrong person address.",
        },
      ],
    });
    const historical = await app.inject({ url: `/api/people/${created.id}/revisions/1` });
    expect(historical.json<PersonProfile>()).toMatchObject({
      primaryEmail: "wrong@example.com",
      emails: ["wrong@example.com"],
    });
  });
});

describe("identity repair routes", () => {
  async function createSecond(): Promise<PersonProfile> {
    const response = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { fullName: "Grace Hopper" },
    });
    return response.json<PersonProfile>();
  }

  it("POST /:profileId/merges merges a duplicate through an audited decision", async () => {
    const survivor = await createGrace();
    const duplicate = await createSecond();

    const merged = await app.inject({
      method: "POST",
      url: `/api/people/${survivor.id}/merges`,
      payload: { duplicateId: duplicate.id, note: "Duplicate shell; same person." },
    });
    expect(merged.statusCode).toBe(200);
    const body = merged.json<PersonProfile>();
    expect(body.revision).toBe(2);
    expect(body.invalidations?.at(-1)).toMatchObject({
      kind: "merge",
      mergedFrom: duplicate.id,
    });

    // Consumer references to the merged-away id resolve to the redirect, and
    // its superseded revision still discloses the merge.
    const gone = await app.inject({ url: `/api/people/${duplicate.id}` });
    expect(gone.json<PersonProfile>().mergedInto).toBe(survivor.id);
    const pinned = await app.inject({
      url: `/api/people/${duplicate.id}/projection?purpose=meeting&revision=1`,
    });
    expect(pinned.json<PersonProfileProjection>().invalidations?.at(-1)).toMatchObject({
      kind: "merge",
      mergedInto: survivor.id,
      affectedRevision: 1,
    });
  });

  it("POST /:profileId/merges classifies unresolved fact conflicts", async () => {
    const survivor = await createGrace();
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/people",
      payload: { fullName: "Grace Brewster Hopper", role: "Rear Admiral" },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/people/${survivor.id}/merges`,
      payload: { duplicateId: duplicate.json<PersonProfile>().id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "merge-conflict" });
  });

  it("POST /:profileId/detachments splits wrongly attached evidence to the correct Profile", async () => {
    const wrong = await createGrace();
    const correct = await createSecond();
    const wronglyAttributed = {
      id: "ev_mention",
      source: "public-web",
      kind: "mention" as const,
      title: "A news story",
      summary: "Someone was profiled.",
      url: "https://news.example.com/story",
      identitySignals: {
        emails: [],
        fullNames: [],
        handles: {},
        profileUrls: [],
        employerHints: [],
      },
      claims: {},
      matchConfidence: "medium" as const,
      matchedSignals: ["fullName:grace hopper"],
      observedAt: "2026-08-30T08:00:00.000Z",
    };
    store.save({
      ...store.get(wrong.id)!,
      mentions: [wronglyAttributed],
      evidence: [wronglyAttributed],
    });

    const split = await app.inject({
      method: "POST",
      url: `/api/people/${wrong.id}/detachments`,
      payload: { evidenceId: "ev_mention", toProfileId: correct.id, note: "Wrong person." },
    });
    expect(split.statusCode).toBe(200);
    const body = split.json<{ from: PersonProfile; to: PersonProfile }>();
    expect(body.from.mentions).toEqual([]);
    expect(body.from.evidence).toEqual([]);
    expect(body.from.invalidations?.at(-1)).toMatchObject({
      kind: "evidence-detached",
      evidenceId: "ev_mention",
      movedTo: correct.id,
    });
    expect(body.to.mentions[0]).toMatchObject({ id: "ev_mention", source: "public-web" });
    expect(body.to.evidence[0]).toMatchObject({ id: "ev_mention", source: "public-web" });
    expect(body.to.invalidations?.at(-1)).toMatchObject({
      kind: "evidence-detached",
      movedFrom: wrong.id,
    });
    // The old attribution survives only as disclosed history.
    const superseded = await app.inject({ url: `/api/people/${wrong.id}/revisions/1` });
    expect(superseded.json<PersonProfile>().mentions).toHaveLength(1);
  });

  it("GET /:profileId/invalidations exposes the append-only log for consumers", async () => {
    const created = await createGrace();
    await app.inject({
      method: "POST",
      url: `/api/people/${created.id}/corrections`,
      payload: { role: "Professor of Computer Science" },
    });

    const log = await app.inject({ url: `/api/people/${created.id}/invalidations` });
    expect(log.statusCode).toBe(200);
    expect(log.json()).toHaveLength(1);
    expect(log.json()[0]).toMatchObject({ kind: "correction", affectedRevision: 1 });

    const unknown = await app.inject({ url: "/api/people/person_unknown/invalidations" });
    expect(unknown.statusCode).toBe(404);
  });
});

/**
 * The same lifecycle routes over the PRODUCTION reference registry — the real
 * `WorkspacePersonProfileReferences` wired to the real stores it reads at the
 * composition roots (Runs, the Transcript Catalog, Content Research items,
 * and the confirmed owner reference). A refusal or receipt here can only be
 * satisfied by disclosures the registry actually derives from Workspace
 * state, not by test doubles.
 */
describe("/api/people/:profileId lifecycle over the production registry", () => {
  let registryApp: FastifyInstance;
  let registryStore: PersonProfileStore;
  let registryProfiles: WorkspacePersonProfiles;
  let catalog: TranscriptCatalogStore;
  let research: ContentResearchStore;
  /** The confirmed owner reference; the registry reads it through its port. */
  let confirmedOwner: ConfirmedOwnerReference | null;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "cos-people-routes-real-"));
    registryStore = new PersonProfileStore(workspaceDir);
    catalog = new TranscriptCatalogStore(workspaceDir);
    research = new ContentResearchStore(workspaceDir, () => new Date("2026-08-31T16:00:00.000Z"));
    confirmedOwner = null;
    const registry = new WorkspacePersonProfileReferences(openRuns(workspaceDir), {
      ownerReference: () => confirmedOwner,
      transcripts: () => catalog.listTranscripts(),
      publicItems: () => research.listAllItems(),
    });
    registryProfiles = new WorkspacePersonProfiles({
      store: registryStore,
      now: () => new Date("2026-08-31T16:00:00.000Z"),
      lifecycle: [registry],
    });
    registryApp = fastify();
    registerPeopleApi(registryApp, {
      people: registryProfiles,
      resolver: new PersonProfileResolver({ store: registryStore, sources: [] }),
    });
    return registryApp.ready();
  });

  afterEach(async () => {
    await registryApp.close();
  });

  async function createAda(): Promise<PersonProfile> {
    const response = await registryApp.inject({
      method: "POST",
      url: "/api/people",
      payload: { fullName: "Ada Lovelace", primaryEmail: "ada@example.com" },
    });
    expect(response.statusCode).toBe(201);
    return response.json<PersonProfile>();
  }

  function seedTranscript(id: string, text: string): void {
    const record: TranscriptRecord = {
      id,
      source: {
        sourceSystem: "drive",
        externalFileId: id,
        fileName: `${id}.md`,
        sourceUrl: null,
        checksum: "a".repeat(64),
        observedRevision: 1,
        modifiedAt: null,
      },
      ingestedAt: "2026-08-31T12:00:00.000Z",
      extractorVersion: 1,
      normalizedText: text,
      meetingDate: null,
      occurrence: null,
      speakers: [],
      speakerIdentityMappings: [],
      roster: [],
      meetingId: null,
    };
    catalog.saveTranscript(record);
  }

  function seedItem(id: string, title: string, body: string, canonicalUrl: string): void {
    const item: SourceItem = {
      id,
      externalId: id,
      targetId: "target_1",
      adapterId: "rss",
      canonicalUrl,
      author: null,
      title,
      body,
      description: null,
      publishedAt: "2026-08-30T10:00:00.000Z",
      discoveredAt: "2026-08-30T12:00:00.000Z",
      media: [],
      transcript: null,
      comments: [],
      evidence: [{ route: canonicalUrl, retrievedAt: "2026-08-30T12:00:00.000Z" }],
      completeness: {
        title: "available",
        body: "available",
        description: "unavailable",
        transcript: "unsupported",
        comments: "unsupported",
        media: "unavailable",
      },
    };
    research.storeItems([{ canonicalUrl: item.canonicalUrl, payload: JSON.stringify(item) }]);
  }

  it("refuses archive and privacy deletion while the confirmed owner reference pins the Profile, naming it", async () => {
    const created = await createAda();
    confirmedOwner = {
      profileId: created.id,
      profileRevision: created.revision,
      confirmedAt: "2026-08-31T15:00:00.000Z",
      confirmedForGoogleEmail: "ada@example.com",
    };

    for (const url of [
      `/api/people/${created.id}/archive`,
      `/api/people/${created.id}/privacy-delete`,
    ]) {
      const refused = await registryApp.inject({
        method: "POST",
        url,
        payload: { confirmation: "DELETE PROFILE" },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: "active-dependencies",
        lifecycle: {
          dependentConfigurations: [
            {
              consumer: "owner-onboarding",
              state: "active",
              availableActions: ["repoint"],
              profileId: created.id,
            },
          ],
        },
      });
    }

    /* Re-pointing the owner reference resolves the refusal explicitly. */
    confirmedOwner = null;
    const archived = await registryApp.inject({
      method: "POST",
      url: `/api/people/${created.id}/archive`,
    });
    expect(archived.statusCode).toBe(200);
  });

  it("derives residual source artifacts from catalogued transcripts and public items naming the person", async () => {
    const created = await createAda();
    seedTranscript("transcript_ada_1", "Ada Lovelace: the engine is ready for the demonstration.");
    seedTranscript("transcript_other", "Unrelated: nothing here names her email.");
    seedItem(
      "item_ada_1",
      "Ada Lovelace publishes notes on the engine",
      "Wide-ranging commentary.",
      "https://notes.example/ada-engine-notes",
    );
    seedItem(
      "item_other",
      "Quarterly results",
      "No person of interest appears here.",
      "https://quarterly.example/results",
    );

    const preview = await registryApp.inject({ url: `/api/people/${created.id}/lifecycle` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      dependentConfigurations: [],
      residualSourceArtifacts: expect.arrayContaining([
        { artifactId: "transcript_ada_1", kind: "transcript", separateDeleteSupported: false },
        { artifactId: "item_ada_1", kind: "public-source", separateDeleteSupported: false },
      ]),
    });
    const artifacts = preview.json<PersonProfileLifecycleState>().residualSourceArtifacts;
    expect(artifacts.map((a) => a.artifactId)).not.toContain("transcript_other");
    expect(artifacts.map((a) => a.artifactId)).not.toContain("item_other");

    /* The confirmation refusal and the receipt disclose the same documents. */
    const refused = await registryApp.inject({
      method: "POST",
      url: `/api/people/${created.id}/privacy-delete`,
      payload: { confirmation: "archive" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      lifecycle: {
        residualSourceArtifacts: expect.arrayContaining([
          {
            artifactId: "transcript_ada_1",
            kind: "transcript",
            separateDeleteSupported: false,
          },
          { artifactId: "item_ada_1", kind: "public-source", separateDeleteSupported: false },
        ]),
      },
    });

    const deleted = await registryApp.inject({
      method: "POST",
      url: `/api/people/${created.id}/privacy-delete`,
      payload: { confirmation: "DELETE PROFILE" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      residualSourceArtifacts: [
        { artifactId: "transcript_ada_1", kind: "transcript", separateDeleteSupported: false },
        { artifactId: "item_ada_1", kind: "public-source", separateDeleteSupported: false },
      ],
      remoteProviderOperations: 0,
    });
  });
});
