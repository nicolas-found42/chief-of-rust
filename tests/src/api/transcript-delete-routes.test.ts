import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRANSCRIPT_DELETE_CONFIRMATION } from "@chief-of-staff-demo/shared";
import { registerTranscriptDeletionApi } from "../../../apps/server/src/api/transcript-delete";
import { TranscriptCatalog } from "../../../apps/server/src/transcript-catalog/catalog";
import { TranscriptDeletionService } from "../../../apps/server/src/transcript-catalog/deletion";
import { TranscriptIdentityService } from "../../../apps/server/src/transcript-catalog/identity";
import { TranscriptIdentityStore } from "../../../apps/server/src/transcript-catalog/identity-store";
import { TranscriptRelevanceStore } from "../../../apps/server/src/transcript-catalog/relevance-store";
import { TranscriptCatalogStore } from "../../../apps/server/src/transcript-catalog/store";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { WorkspacePersonProfileTranscriptEvidence } from "../../../apps/server/src/person-profile/transcript-evidence";
import type { TranscriptCatalogSource } from "../../../apps/server/src/transcript-catalog/catalog";

const NOW = () => new Date("2026-08-31T12:00:00.000Z");

const SYNC_TEXT = `[00:00] Grace Hopper: Quick update on the Nimbus rollout.
[00:12] Sam: Email questions to grace@example.com before Friday.`;

const BOARD_TEXT = `[00:00] Jordan: Board prep — the investor update draft is due Thursday.`;

function sourceOf(files: Record<string, { name: string; body: string }>): TranscriptCatalogSource {
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
      if (!(externalFileId in files)) return null;
      return Buffer.from(files[externalFileId].body, "utf8");
    },
  };
}

let app: FastifyInstance;
let workspaceDir: string;
let catalogStore: TranscriptCatalogStore;
let deletion: TranscriptDeletionService;

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-transcript-delete-"));
  catalogStore = new TranscriptCatalogStore(workspaceDir);
  const peopleStore = new PersonProfileStore(workspaceDir);
  const people = new WorkspacePersonProfiles({ store: peopleStore, now: NOW, lifecycle: [] });
  const identity = new TranscriptIdentityService({
    store: new TranscriptIdentityStore(workspaceDir),
    people,
    now: NOW,
  });
  const files = {
    fileA: { name: "Weekly sync - 2026-08-17T13-00-00.000Z.md", body: SYNC_TEXT },
    fileB: { name: "Board prep - 2026-08-19T10-00-00.000Z.md", body: BOARD_TEXT },
  };
  const catalog = new TranscriptCatalog({
    workspaceDir,
    source: sourceOf(files),
    disclosure: () => ({ provider: "test-provider", model: "test-model" }),
    identity,
    now: NOW,
  });
  await catalog.grantConsent();
  await catalog.whenIdle();
  deletion = new TranscriptDeletionService({
    catalog: catalogStore,
    identity: new TranscriptIdentityStore(workspaceDir),
    relevance: new TranscriptRelevanceStore(workspaceDir),
    registries: [new WorkspacePersonProfileTranscriptEvidence(peopleStore)],
    now: NOW,
  });
  app = fastify();
  registerTranscriptDeletionApi(app, { catalog: catalogStore, deletion });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/transcripts", () => {
  it("lists every retained transcript as metadata without any transcript text", async () => {
    const response = await app.inject({ url: "/api/transcripts" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ transcripts: Array<Record<string, unknown>> }>();
    expect(body.transcripts.map((t) => t.id).sort()).toEqual(["drive_fileA_r1", "drive_fileB_r1"]);
    for (const transcript of body.transcripts) {
      expect(transcript).toEqual({
        id: transcript.id,
        externalFileId: transcript.externalFileId,
        fileName: transcript.fileName,
        sourceUrl: null,
        meetingDate: transcript.meetingDate,
        ingestedAt: "2026-08-31T12:00:00.000Z",
      });
    }
    expect(JSON.stringify(body)).not.toContain("Nimbus");
    expect(JSON.stringify(body)).not.toContain("grace@example.com");
  });
});

describe("GET /api/transcripts/:id", () => {
  it("serves one retained transcript's metadata", async () => {
    const response = await app.inject({ url: "/api/transcripts/drive_fileA_r1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "drive_fileA_r1",
      fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
      externalFileId: "fileA",
    });
    expect(JSON.stringify(response.json())).not.toContain("normalizedText");
  });

  it("answers 410 with the content-free tombstone and receipt once deleted", async () => {
    await app.inject({
      method: "POST",
      url: "/api/transcripts/drive_fileA_r1/delete",
      payload: { confirmation: TRANSCRIPT_DELETE_CONFIRMATION },
    });

    const gone = await app.inject({ url: "/api/transcripts/drive_fileA_r1" });
    expect(gone.statusCode).toBe(410);
    const body = gone.json();
    expect(body.error).toBe("transcript-deleted");
    expect(body.tombstone).toEqual({
      sourceSystem: "drive",
      externalFileId: "fileA",
      checksum: body.tombstone.checksum,
      deletedAt: "2026-08-31T12:00:00.000Z",
      policy: "do-not-reingest",
    });
    expect(JSON.stringify(body.tombstone)).not.toContain("Grace");
    expect(body.receipt.remoteProviderOperations).toBe(0);
  });

  it("answers 404 for an unknown transcript", async () => {
    const response = await app.inject({ url: "/api/transcripts/drive_nope_r1" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "transcript-not-found" });
  });
});

describe("GET /api/transcripts/:id/deletion-preview", () => {
  it("discloses the consumer records deletion would remove, before anything is removed", async () => {
    const response = await app.inject({ url: "/api/transcripts/drive_fileA_r1/deletion-preview" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      transcript: expect.objectContaining({ id: "drive_fileA_r1" }),
      consumerRecords: [
        {
          consumer: "person-profiles",
          label: "Transcript-origin Person Evidence held on Person Profiles",
          recordCount: 0,
        },
      ],
    });
  });
});

describe("POST /api/transcripts/:id/delete", () => {
  it("refuses without the exact confirmation and removes nothing", async () => {
    const refused = await app.inject({
      method: "POST",
      url: "/api/transcripts/drive_fileA_r1/delete",
      payload: { confirmation: "yes please" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "confirmation-required" });
    expect((await app.inject({ url: "/api/transcripts/drive_fileA_r1" })).statusCode).toBe(200);
  });

  it("deletes with the confirmation and returns the audited receipt", async () => {
    const deleted = await app.inject({
      method: "POST",
      url: "/api/transcripts/drive_fileA_r1/delete",
      payload: { confirmation: TRANSCRIPT_DELETE_CONFIRMATION },
    });
    expect(deleted.statusCode).toBe(200);
    const body = deleted.json();
    expect(body).toMatchObject({
      transcriptId: "drive_fileA_r1",
      externalFileId: "fileA",
      tombstone: { externalFileId: "fileA", policy: "do-not-reingest" },
      remoteProviderOperations: 0,
    });
    expect(body.removed.transcriptRecords).toBe(1);
    expect((await app.inject({ url: "/api/transcripts/drive_fileA_r1" })).statusCode).toBe(410);
  });

  it("answers 410 with the standing tombstone when asked to delete again", async () => {
    await app.inject({
      method: "POST",
      url: "/api/transcripts/drive_fileA_r1/delete",
      payload: { confirmation: TRANSCRIPT_DELETE_CONFIRMATION },
    });
    const again = await app.inject({
      method: "POST",
      url: "/api/transcripts/drive_fileA_r1/delete",
      payload: { confirmation: TRANSCRIPT_DELETE_CONFIRMATION },
    });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({
      error: "transcript-already-deleted",
      tombstone: { externalFileId: "fileA" },
    });
  });

  it("answers 404 for an unknown transcript", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/transcripts/drive_nope_r1/delete",
      payload: { confirmation: TRANSCRIPT_DELETE_CONFIRMATION },
    });
    expect(response.statusCode).toBe(404);
  });

  it("performs no remote provider operation", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return Promise.reject(
        new Error("no remote provider is reachable from a transcript deletion"),
      );
    };
    try {
      const deleted = await app.inject({
        method: "POST",
        url: "/api/transcripts/drive_fileA_r1/delete",
        payload: { confirmation: TRANSCRIPT_DELETE_CONFIRMATION },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ remoteProviderOperations: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual([]);
  });
});

describe("GET /api/transcripts/tombstones and restore", () => {
  it("lists standing tombstones and answers 404 for an unknown restore", async () => {
    expect((await app.inject({ url: "/api/transcripts/tombstones" })).json()).toEqual({
      tombstones: [],
    });
    await app.inject({
      method: "POST",
      url: "/api/transcripts/drive_fileA_r1/delete",
      payload: { confirmation: TRANSCRIPT_DELETE_CONFIRMATION },
    });
    const listed = await app.inject({ url: "/api/transcripts/tombstones" });
    expect(listed.json().tombstones).toHaveLength(1);
    expect(JSON.stringify(listed.json())).not.toContain("Grace");

    const unknown = await app.inject({
      method: "POST",
      url: "/api/transcripts/tombstones/no-such-file/restore",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("restores processing permission and clears the tombstone", async () => {
    await app.inject({
      method: "POST",
      url: "/api/transcripts/drive_fileA_r1/delete",
      payload: { confirmation: TRANSCRIPT_DELETE_CONFIRMATION },
    });
    const restored = await app.inject({
      method: "POST",
      url: "/api/transcripts/tombstones/fileA/restore",
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ tombstone: { externalFileId: "fileA" } });
    expect((await app.inject({ url: "/api/transcripts/tombstones" })).json().tombstones).toEqual(
      [],
    );
    /* The deletion receipt stays readable as the audit record. */
    expect((await app.inject({ url: "/api/transcripts/drive_fileA_r1" })).statusCode).toBe(404);
  });
});
