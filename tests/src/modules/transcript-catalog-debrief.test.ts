import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptRecord } from "@chief-of-staff-demo/shared";
import {
  TranscriptCatalog,
  type TranscriptCatalogSource,
  type TranscriptDebriefProcessor,
} from "../../../apps/server/src/transcript-catalog/catalog";
import { TranscriptIdentityService } from "../../../apps/server/src/transcript-catalog/identity";
import { TranscriptIdentityStore } from "../../../apps/server/src/transcript-catalog/identity-store";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";

const SYNC_TEXT = `# Weekly sync

Alice: We decided to ship the billing fix on Friday.
Bob: I will own the billing fix follow-up.
Alice: Does anyone have questions about the rollout?
`;

function fakeSource(
  files: Record<string, { name: string; body: string }>,
): TranscriptCatalogSource & {
  fetchCount(externalFileId: string): number;
} {
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

interface RecordingProcessor extends TranscriptDebriefProcessor {
  processed: TranscriptRecord[];
  backfilled: TranscriptRecord[][];
}

function recordingProcessor(): RecordingProcessor {
  const processor: RecordingProcessor = {
    processed: [],
    backfilled: [],
    async process(record) {
      processor.processed.push(record);
    },
    async backfill(records) {
      processor.backfilled.push([...records]);
    },
  };
  return processor;
}

function makeCatalog(
  source: TranscriptCatalogSource,
  workspaceDir: string = mkdtempSync(join(tmpdir(), "transcript-catalog-debrief-")),
  debrief?: TranscriptDebriefProcessor,
): TranscriptCatalog {
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  return new TranscriptCatalog({
    workspaceDir,
    source,
    disclosure: () => ({ provider: "test-provider", model: "test-model" }),
    identity: new TranscriptIdentityService({
      store: new TranscriptIdentityStore(workspaceDir),
      people,
    }),
    ...(debrief ? { debrief } : {}),
    now: () => new Date("2026-08-31T12:00:00.000Z"),
    log: () => {},
  });
}

describe("Transcript Catalog → Meeting Debrief hand-off (#139)", () => {
  it("hands every newly registered immutable Transcript to the Debrief processor at mining completion", async () => {
    const source = fakeSource({
      fileA: { name: "Weekly sync - 2026-08-17T13-00-00.000Z.md", body: SYNC_TEXT },
    });
    const debrief = recordingProcessor();
    const catalog = makeCatalog(source, undefined, debrief);

    await catalog.grantConsent();
    await catalog.whenIdle();

    expect(catalog.status().processed).toBe(1);
    expect(debrief.processed).toHaveLength(1);
    expect(debrief.processed[0]?.normalizedText).toBe(SYNC_TEXT);
    expect(debrief.processed[0]?.source.checksum).not.toBeNull();
  });

  it("reaches historically mined Transcripts too, through the same processor on every pass", async () => {
    const source = fakeSource({
      fileA: { name: "Weekly sync - 2026-08-17T13-00-00.000Z.md", body: SYNC_TEXT },
    });
    const workspaceDir = mkdtempSync(join(tmpdir(), "transcript-catalog-debrief-"));
    const catalog = makeCatalog(source, workspaceDir);
    await catalog.grantConsent();
    await catalog.whenIdle();

    const debrief = recordingProcessor();
    const withDebrief = makeCatalog(source, workspaceDir, debrief);
    const pass = await withDebrief.processAvailable();

    expect(pass.unchanged).toBe(1);
    expect(pass.processed).toBe(0);
    expect(debrief.backfilled).toHaveLength(1);
    expect(debrief.backfilled[0]?.map((record) => record.id)).toEqual(["drive_fileA_r1"]);
  });

  it("hands an associated record to the Debrief processor when the Calendar link becomes known", async () => {
    const source = fakeSource({
      fileA: { name: "Weekly sync - 2026-08-17T13-00-00.000Z.md", body: SYNC_TEXT },
    });
    const debrief = recordingProcessor();
    const catalog = makeCatalog(source, undefined, debrief);
    await catalog.grantConsent();
    await catalog.whenIdle();

    const record = catalog.listTranscripts()[0];
    await catalog.associateOccurrence(record.id, {
      occurrence: { occurrenceKey: "evt1::2026-08-17T13:00:00Z", calendarEventId: "evt1" },
      speakerIdentityMappings: [],
      roster: [{ displayName: "Alice", email: "alice@example.com" }],
    });

    expect(debrief.processed.some((entry) => entry.occurrence?.occurrenceKey)).toBe(true);
    expect(debrief.processed.some((entry) => entry.roster.length > 0)).toBe(true);
  });
});
