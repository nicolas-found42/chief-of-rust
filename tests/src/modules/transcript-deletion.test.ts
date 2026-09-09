import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersonEvidence, TranscriptRelevanceDecision } from "@chief-of-staff-demo/shared";
import { openRuns } from "../../../apps/server/src/runs";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { WorkspacePersonProfileTranscriptEvidence } from "../../../apps/server/src/person-profile/transcript-evidence";
import { TranscriptCatalog } from "../../../apps/server/src/transcript-catalog/catalog";
import type { TranscriptCatalogSource } from "../../../apps/server/src/transcript-catalog/catalog";
import { TranscriptDeletionService } from "../../../apps/server/src/transcript-catalog/deletion";
import { TranscriptIdentityService } from "../../../apps/server/src/transcript-catalog/identity";
import { TranscriptIdentityStore } from "../../../apps/server/src/transcript-catalog/identity-store";
import { TranscriptRelevanceService } from "../../../apps/server/src/transcript-catalog/relevance";
import { TranscriptRelevanceStore } from "../../../apps/server/src/transcript-catalog/relevance-store";
import { TranscriptCatalogStore } from "../../../apps/server/src/transcript-catalog/store";
import {
  TRANSCRIPT_DELETE_CONFIRMATION,
  type TranscriptDeletionReceipt,
} from "@chief-of-staff-demo/shared";

const NOW = () => new Date("2026-08-31T12:00:00.000Z");

const SYNC_TEXT = `[00:00] Grace Hopper: Quick update on the Nimbus rollout.
[00:12] Sam: Email questions to grace@example.com before Friday.`;

const BOARD_TEXT = `[00:00] Jordan: Board prep — the investor update draft is due Thursday.`;

interface FakeFile {
  name: string;
  body: string;
}

interface CountingSource extends TranscriptCatalogSource {
  fetchCount(externalFileId: string): number;
}

function fakeSource(files: Record<string, FakeFile>): CountingSource {
  const fetches: Record<string, number> = {};
  return {
    async folder() {
      return { folderId: "folder-1", folderName: "Transcripts" };
    },
    async listFiles() {
      return Object.entries(files).map(([externalFileId, file]) => ({
        externalFileId,
        fileName: file.name,
        sizeBytes: Buffer.byteLength(file.body),
        modifiedAt: null,
        sourceUrl: null,
      }));
    },
    async fetch(externalFileId) {
      fetches[externalFileId] = (fetches[externalFileId] ?? 0) + 1;
      if (!(externalFileId in files)) return null;
      return Buffer.from(files[externalFileId].body, "utf8");
    },
    fetchCount(externalFileId) {
      return fetches[externalFileId] ?? 0;
    },
  };
}

interface Harness {
  workspaceDir: string;
  catalog: TranscriptCatalog;
  catalogStore: TranscriptCatalogStore;
  identityStore: TranscriptIdentityStore;
  relevanceStore: TranscriptRelevanceStore;
  relevance: TranscriptRelevanceService;
  identity: TranscriptIdentityService;
  people: WorkspacePersonProfiles;
  peopleStore: PersonProfileStore;
  deletion: TranscriptDeletionService;
  source: CountingSource;
}

function makeHarness(
  files: Record<string, FakeFile> = {
    fileA: { name: "Weekly sync - 2026-08-17T13-00-00.000Z.md", body: SYNC_TEXT },
    fileB: { name: "Board prep - 2026-08-19T10-00-00.000Z.md", body: BOARD_TEXT },
  },
): Harness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "transcript-deletion-"));
  const catalogStore = new TranscriptCatalogStore(workspaceDir);
  const identityStore = new TranscriptIdentityStore(workspaceDir);
  const relevanceStore = new TranscriptRelevanceStore(workspaceDir);
  const peopleStore = new PersonProfileStore(workspaceDir);
  const people = new WorkspacePersonProfiles({
    store: peopleStore,
    now: NOW,
    lifecycle: [],
  });
  const identity = new TranscriptIdentityService({
    store: identityStore,
    people,
    now: NOW,
  });
  const source = fakeSource(files);
  const catalog = new TranscriptCatalog({
    workspaceDir,
    source,
    disclosure: () => ({ provider: "test-provider", model: "test-model" }),
    identity,
    now: NOW,
    log: () => {},
  });
  const relevance = new TranscriptRelevanceService({
    corpus: catalog,
    store: relevanceStore,
    now: NOW,
  });
  const deletion = new TranscriptDeletionService({
    catalog: catalogStore,
    identity: identityStore,
    relevance: relevanceStore,
    registries: [new WorkspacePersonProfileTranscriptEvidence(peopleStore)],
    now: NOW,
    log: () => {},
  });
  return {
    workspaceDir,
    catalog,
    catalogStore,
    identityStore,
    relevanceStore,
    relevance,
    identity,
    people,
    peopleStore,
    deletion,
    source,
  };
}

/** Consent, then a settled processing pass over the whole folder. */
async function ingest(h: Harness): Promise<void> {
  await h.catalog.grantConsent();
  await h.catalog.whenIdle();
}

describe("Transcript deletion tombstone (issue #128)", () => {
  it("removes the transcript record and leaves a content-free tombstone with only source identity, checksum, deletion time, and policy", async () => {
    const h = makeHarness();
    await ingest(h);
    expect(h.catalog.getTranscript("drive_fileA_r1")).not.toBeNull();

    const receipt: TranscriptDeletionReceipt = h.deletion.delete("drive_fileA_r1", {
      confirmation: TRANSCRIPT_DELETE_CONFIRMATION,
    });

    expect(h.catalog.getTranscript("drive_fileA_r1")).toBeNull();
    expect(h.catalog.getTranscript("drive_fileB_r1")).not.toBeNull();
    expect(receipt.tombstone).toEqual({
      sourceSystem: "drive",
      externalFileId: "fileA",
      checksum: receipt.tombstone.checksum,
      deletedAt: "2026-08-31T12:00:00.000Z",
      policy: "do-not-reingest",
    });
    /* Content-free by construction: no text, no file name, no participants. */
    const serialized = JSON.stringify(receipt.tombstone);
    expect(serialized).not.toContain("Grace");
    expect(serialized).not.toContain("Nimbus");
    expect(serialized).not.toContain("grace@example.com");
    expect(serialized).not.toContain("Weekly sync");
    expect(receipt.remoteProviderOperations).toBe(0);
  });

  it("requires the exact deletion confirmation and deletes nothing without it", async () => {
    const h = makeHarness();
    await ingest(h);

    expect(() =>
      h.deletion.delete("drive_fileA_r1", { confirmation: "delete transcript" }),
    ).toThrowError(/DELETE TRANSCRIPT/);
    expect(h.catalog.getTranscript("drive_fileA_r1")).not.toBeNull();
    expect(h.catalogStore.listTombstones()).toEqual([]);
  });

  it("refuses to delete an unknown transcript", () => {
    const h = makeHarness();
    expect(() =>
      h.deletion.delete("drive_nope_r1", { confirmation: TRANSCRIPT_DELETE_CONFIRMATION }),
    ).toThrowError(/Unknown transcript/);
  });

  it("continuous processing respects the tombstone across a restart and never even fetches the file", async () => {
    const h = makeHarness();
    await ingest(h);
    h.deletion.delete("drive_fileA_r1", { confirmation: TRANSCRIPT_DELETE_CONFIRMATION });
    const fetchesBeforeRestart = h.source.fetchCount("fileA");
    /* A restarted Catalog over the same Workspace: fresh object, same stores. */
    const restarted = new TranscriptCatalog({
      workspaceDir: h.workspaceDir,
      source: h.source,
      disclosure: () => ({ provider: "test-provider", model: "test-model" }),
      identity: new TranscriptIdentityService({
        store: h.identityStore,
        people: h.people,
        now: NOW,
      }),
      now: NOW,
      log: () => {},
    });
    const pass = await restarted.processAvailable();

    expect(pass.skipped).toBe(1);
    expect(pass.unchanged).toBe(1);
    expect(h.source.fetchCount("fileA")).toBe(fetchesBeforeRestart);
    expect(h.catalog.getTranscript("drive_fileA_r1")).toBeNull();
    expect(h.catalogStore.listTombstones()).toHaveLength(1);
  });

  it("restore-permission is explicit, clears the tombstone, and lets the next pass reingest", async () => {
    const h = makeHarness();
    await ingest(h);
    h.deletion.delete("drive_fileA_r1", { confirmation: TRANSCRIPT_DELETE_CONFIRMATION });

    expect(h.deletion.restoreProcessingPermission("no-such-file")).toBeNull();
    const restored = h.deletion.restoreProcessingPermission("fileA");
    expect(restored?.tombstone.policy).toBe("do-not-reingest");
    expect(h.catalogStore.listTombstones()).toEqual([]);

    const pass = await h.catalog.processAvailable();
    expect(pass.processed).toBe(1);
    expect(h.catalog.getTranscript("drive_fileA_r1")).not.toBeNull();
    expect(h.source.fetchCount("fileA")).toBe(2); /* once at ingest, once after restore */
  });

  it("deleting an already-deleted transcript is a typed refusal that changes nothing", async () => {
    const h = makeHarness();
    await ingest(h);
    const first = h.deletion.delete("drive_fileA_r1", {
      confirmation: TRANSCRIPT_DELETE_CONFIRMATION,
    });
    const tombstoneBefore = h.catalogStore.readTombstone("fileA");

    expect(() =>
      h.deletion.delete("drive_fileA_r1", { confirmation: TRANSCRIPT_DELETE_CONFIRMATION }),
    ).toThrowError(/already deleted/);
    expect(h.catalogStore.readTombstone("fileA")).toEqual(tombstoneBefore);
    expect(h.catalogStore.listTranscripts()).toHaveLength(1);
    expect(first.tombstone).toEqual(tombstoneBefore);
  });

  it("a crash after the tombstone write leaves reingestion blocked; re-deleting completes the cascade", async () => {
    const h = makeHarness();
    await ingest(h);
    const record = h.catalog.getTranscript("drive_fileA_r1")!;
    /* Simulate the crash window: the tombstone stands while the record and
       every cascade output still exist. */
    h.catalogStore.writeTombstone({
      sourceSystem: "drive",
      externalFileId: "fileA",
      checksum: record.source.checksum,
      deletedAt: NOW().toISOString(),
      policy: "do-not-reingest",
    });

    /* Reingestion stays blocked at every crash point: the restarted Catalog
       skips the file even though the record (text) is still on disk. */
    const restarted = new TranscriptCatalog({
      workspaceDir: h.workspaceDir,
      source: h.source,
      disclosure: () => ({ provider: "test-provider", model: "test-model" }),
      identity: new TranscriptIdentityService({
        store: h.identityStore,
        people: h.people,
        now: NOW,
      }),
      now: NOW,
      log: () => {},
    });
    const blocked = await restarted.processAvailable();
    expect(blocked.skipped).toBe(1);
    expect(h.catalog.getTranscript("drive_fileA_r1")).not.toBeNull();

    /* Re-deleting completes the interrupted cascade instead of refusing. */
    const receipt = h.deletion.delete("drive_fileA_r1", {
      confirmation: TRANSCRIPT_DELETE_CONFIRMATION,
    });
    expect(receipt.removed.transcriptRecords).toBe(1);
    expect(receipt.removed.identityMentions).toBeGreaterThan(0);
    expect(h.catalog.getTranscript("drive_fileA_r1")).toBeNull();
    expect(h.catalogStore.readTombstone("fileA")?.checksum).toBe(record.source.checksum);
    const still = await restarted.processAvailable();
    expect(still.skipped).toBe(1);
  });

  it("keeps the deletion receipt readable after the tombstone is restored", async () => {
    const h = makeHarness();
    await ingest(h);
    const receipt = h.deletion.delete("drive_fileA_r1", {
      confirmation: TRANSCRIPT_DELETE_CONFIRMATION,
    });
    h.deletion.restoreProcessingPermission("fileA");

    expect(h.deletion.deletionReceipt("drive_fileA_r1")).toEqual(receipt);
  });
});

describe("Transcript deletion cascade (issue #128)", () => {
  async function ingestWithIdentityAndRelevance(h: Harness): Promise<void> {
    /* A Profile whose exact stable identifier matches a mention: mining
       produces a candidate and a policy-made confirmed decision for it. */
    h.people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });
    await ingest(h);
    /* Semantic relevance: discovery over the retained corpus, then an owner
       decision — the transcript-derived record deletion must also carry. */
    await h.relevance.search({ text: "Nimbus rollout" });
    const candidate = h.relevanceStore
      .readCandidates()
      .find((c) => c.transcriptId === "drive_fileA_r1");
    if (candidate) h.relevance.decide({ candidateId: candidate.id, action: "confirm" });
  }

  it("cascades through mentions, organizations, candidates, identity decisions, extraction ledger, and relevance records for the deleted transcript only", async () => {
    const h = makeHarness();
    await ingestWithIdentityAndRelevance(h);

    const mentionsBefore = h.identityStore.readMentions();
    expect(mentionsBefore.some((m) => m.provenance.transcriptId === "drive_fileA_r1")).toBe(true);
    expect(mentionsBefore.some((m) => m.provenance.transcriptId === "drive_fileB_r1")).toBe(true);
    expect(h.identityStore.readDecisions().some((d) => d.transcriptId === "drive_fileA_r1")).toBe(
      true,
    );
    expect(h.relevanceStore.readDecisions().some((d) => d.transcriptId === "drive_fileA_r1")).toBe(
      true,
    );
    expect(h.relevanceStore.readCandidates().some((c) => c.transcriptId === "drive_fileA_r1")).toBe(
      true,
    );

    const receipt = h.deletion.delete("drive_fileA_r1", {
      confirmation: TRANSCRIPT_DELETE_CONFIRMATION,
    });

    expect(receipt.removed.identityMentions).toBeGreaterThan(0);
    expect(receipt.removed.identityDecisions).toBeGreaterThan(0);
    expect(receipt.removed.relevanceCandidates).toBeGreaterThan(0);
    expect(receipt.removed.relevanceDecisions).toBe(1);

    expect(
      h.identityStore.readMentions().some((m) => m.provenance.transcriptId === "drive_fileA_r1"),
    ).toBe(false);
    expect(
      h.identityStore.readMentions().some((m) => m.provenance.transcriptId === "drive_fileB_r1"),
    ).toBe(true);
    expect(h.identityStore.readCandidates().some((c) => c.transcriptId === "drive_fileA_r1")).toBe(
      false,
    );
    expect(h.identityStore.readDecisions().some((d) => d.transcriptId === "drive_fileA_r1")).toBe(
      false,
    );
    /* The extraction ledger is consistent: the deleted record's processing
       entry is gone; the surviving record's is intact. */
    expect(
      h.identityStore
        .readProcessingLedger()
        .some((entry) => entry.transcriptId === "drive_fileA_r1"),
    ).toBe(false);
    expect(
      h.identityStore
        .readProcessingLedger()
        .some((entry) => entry.transcriptId === "drive_fileB_r1"),
    ).toBe(true);
    expect(h.relevanceStore.readCandidates().some((c) => c.transcriptId === "drive_fileA_r1")).toBe(
      false,
    );
    expect(h.relevanceStore.readDecisions().some((d) => d.transcriptId === "drive_fileA_r1")).toBe(
      false,
    );
    expect(
      h.relevanceStore
        .readDecisions()
        .every((d: TranscriptRelevanceDecision) => d.transcriptId !== "drive_fileA_r1"),
    ).toBe(true);
    /* The relevance index is derived on read over the retained corpus: the
       deleted record cannot be found again. */
    await h.relevance.search({ text: "Nimbus rollout" });
    expect(h.relevanceStore.readCandidates().some((c) => c.transcriptId === "drive_fileA_r1")).toBe(
      false,
    );
  });

  it("removes transcript-scoped remembered mappings with the transcript and keeps workspace-scoped owner authority", async () => {
    const h = makeHarness();
    await ingestWithIdentityAndRelevance(h);

    const mention = h.identityStore
      .readMentions()
      .find((m) => m.provenance.transcriptId === "drive_fileA_r1" && m.kind === "person");
    if (mention === undefined) throw new Error("expected a person mention in the sync transcript");
    h.identity.decide({
      mentionId: mention.id,
      action: "remember-mapping",
      profileId: h.people.search({ query: "grace" })[0].id,
      scope: "transcript",
    });
    const fileBMappingTarget = h.identityStore
      .readMentions()
      .find((m) => m.provenance.transcriptId === "drive_fileB_r1" && m.kind === "person");
    if (fileBMappingTarget === undefined)
      throw new Error("expected a person mention in the board transcript");
    h.identity.decide({
      mentionId: fileBMappingTarget.id,
      action: "remember-mapping",
      profileId: h.people.search({ query: "grace" })[0].id,
      scope: "workspace",
    });
    expect(h.identityStore.readMappings().filter((m) => m.scope === "transcript")).toHaveLength(1);
    expect(h.identityStore.readMappings().filter((m) => m.scope === "workspace")).toHaveLength(1);

    h.deletion.delete("drive_fileA_r1", { confirmation: TRANSCRIPT_DELETE_CONFIRMATION });

    expect(h.identityStore.readMappings().filter((m) => m.scope === "transcript")).toHaveLength(0);
    expect(h.identityStore.readMappings().filter((m) => m.scope === "workspace")).toHaveLength(1);
  });

  it("purges transcript-origin Person Evidence through the registered consumer cascade while independently supported Profile facts and the Profile itself survive", async () => {
    const h = makeHarness();
    await ingestWithIdentityAndRelevance(h);
    const profile = h.people.search({ query: "grace" })[0];
    const transcriptOrigin: PersonEvidence = {
      id: "ev_transcript_origin",
      source: "transcript-catalog",
      kind: "mention",
      title: "Said in the Weekly sync",
      summary: "Quick update on the Nimbus rollout.",
      url: "drive_fileA_r1",
      identitySignals: {
        emails: [],
        fullNames: ["Grace Hopper"],
        handles: {},
        profileUrls: [],
        employerHints: [],
      },
      claims: {},
      matchConfidence: "high",
      matchedSignals: [],
      observedAt: "2026-08-31T12:00:00.000Z",
    };
    const independent: PersonEvidence = {
      id: "ev_public_web",
      source: "public-web",
      kind: "website",
      title: "Grace Hopper's own site",
      summary: "An independently supported fact.",
      url: "https://example.com/grace",
      identitySignals: {
        emails: [],
        fullNames: ["Grace Hopper"],
        handles: {},
        profileUrls: [],
        employerHints: [],
      },
      claims: {},
      matchConfidence: "high",
      matchedSignals: [],
      observedAt: "2026-08-31T12:00:00.000Z",
    };
    /* The resolver mirrors evidence into mentions/publications; identity
       repair treats all three as evidence locations, so the cascade must
       purge transcript-origin records from each. */
    const mirroredMention: PersonEvidence = {
      ...transcriptOrigin,
      id: "ev_transcript_origin_mention",
    };
    h.peopleStore.save({
      ...profile,
      evidence: [...profile.evidence, transcriptOrigin, independent],
      mentions: [...profile.mentions, mirroredMention],
    });

    const preview = h.deletion.preview("drive_fileA_r1");
    expect(preview.consumerRecords).toEqual([
      {
        consumer: "person-profiles",
        label: "Transcript-origin Person Evidence held on Person Profiles",
        recordCount: 2,
      },
    ]);

    const receipt = h.deletion.delete("drive_fileA_r1", {
      confirmation: TRANSCRIPT_DELETE_CONFIRMATION,
    });
    expect(receipt.removed.consumerRecords).toBe(2);

    const after = h.peopleStore.get(profile.id)!;
    expect(after.evidence.some((e) => e.id === "ev_transcript_origin")).toBe(false);
    expect(after.evidence.some((e) => e.id === "ev_public_web")).toBe(true);
    /* The mirrored evidence location is purged with the same discipline. */
    expect(after.mentions.some((e) => e.id === "ev_transcript_origin_mention")).toBe(false);
    /* Transcript-origin evidence copies do not survive inside revisions
       either — in the canonical store or the mirrored arrays. */
    for (const revision of h.peopleStore.listRevisions(profile.id)) {
      expect(revision.evidence.some((e) => e.id === "ev_transcript_origin")).toBe(false);
      expect(revision.mentions.some((e) => e.id === "ev_transcript_origin_mention")).toBe(false);
    }
  });

  it("deletion never touches unrelated Runs", async () => {
    const h = makeHarness();
    await ingest(h);
    const runs = openRuns(h.workspaceDir);
    const run = runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "calendar",
      sourceUrl: null,
      externalId: "evt_unrelated",
    });
    run.writeArtifact("result.json", '{"unrelated": true}\n');

    h.deletion.delete("drive_fileA_r1", { confirmation: TRANSCRIPT_DELETE_CONFIRMATION });

    expect(runs.open(run.id)!.readArtifact("result.json")).toBe('{"unrelated": true}\n');
    expect(runs.list().runs).toHaveLength(1);
  });

  it("is idempotent: repeating the cascade over an empty store appends nothing", async () => {
    const h = makeHarness();
    await ingestWithIdentityAndRelevance(h);
    h.deletion.delete("drive_fileA_r1", { confirmation: TRANSCRIPT_DELETE_CONFIRMATION });
    const tombstoneBefore = h.catalogStore.readTombstone("fileA");
    const decisionsBefore = h.identityStore.readDecisions().length;

    /* A second delete attempt is refused (nothing is left to delete) — and
       even a direct repeated purge over the emptied stores changes nothing. */
    h.identityStore.forgetTranscript("drive_fileA_r1");
    h.relevanceStore.forgetTranscript("drive_fileA_r1");
    expect(h.catalogStore.readTombstone("fileA")).toEqual(tombstoneBefore);
    expect(h.identityStore.readDecisions().length).toBe(decisionsBefore);
    expect(
      h.identityStore.readMentions().filter((m) => m.provenance.transcriptId === "drive_fileA_r1"),
    ).toHaveLength(0);
  });

  it("performs no remote provider call during deletion", async () => {
    const h = makeHarness();
    await ingest(h);
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return Promise.reject(
        new Error("no remote provider is reachable from a transcript deletion"),
      );
    };
    try {
      const receipt = h.deletion.delete("drive_fileA_r1", {
        confirmation: TRANSCRIPT_DELETE_CONFIRMATION,
      });
      expect(receipt.remoteProviderOperations).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual([]);
  });
});
