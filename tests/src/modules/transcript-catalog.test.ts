import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriveFileClient } from "../../../apps/server/src/intake/drive";
import {
  TranscriptCatalog,
  TRANSCRIPT_CATALOG_EXTRACTOR_VERSION,
  type TranscriptCatalogDisclosure,
  type TranscriptCatalogSource,
} from "../../../apps/server/src/transcript-catalog/catalog";
import { createDriveCatalogSource } from "../../../apps/server/src/transcript-catalog/drive-source";
import { TranscriptIdentityService } from "../../../apps/server/src/transcript-catalog/identity";
import { TranscriptIdentityStore } from "../../../apps/server/src/transcript-catalog/identity-store";
import { TranscriptCatalogStore } from "../../../apps/server/src/transcript-catalog/store";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import type { TranscriptRecord } from "@chief-of-staff-demo/shared";

interface FakeFile {
  name: string;
  body?: string;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  url?: string | null;
}

function fakeSource(files: Record<string, FakeFile>): TranscriptCatalogSource & {
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
        sizeBytes:
          file.sizeBytes ?? (file.body === undefined ? null : Buffer.byteLength(file.body)),
        modifiedAt: file.modifiedAt ?? null,
        sourceUrl: file.url ?? null,
      }));
    },
    async fetch(externalFileId) {
      fetches[externalFileId] = (fetches[externalFileId] ?? 0) + 1;
      if (!(externalFileId in files)) return null;
      const file = files[externalFileId];
      if (file.body === undefined) return null;
      return Buffer.from(file.body, "utf8");
    },
    fetchCount(externalFileId) {
      return fetches[externalFileId] ?? 0;
    },
  };
}

function makeCatalog(
  source: TranscriptCatalogSource,
  workspaceDir: string = mkdtempSync(join(tmpdir(), "transcript-catalog-")),
  disclosure: () => TranscriptCatalogDisclosure = () => ({
    provider: "test-provider",
    model: "test-model",
  }),
): TranscriptCatalog {
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  return new TranscriptCatalog({
    workspaceDir,
    source,
    disclosure,
    identity: new TranscriptIdentityService({
      store: new TranscriptIdentityStore(workspaceDir),
      people,
    }),
    now: () => new Date("2026-08-31T12:00:00.000Z"),
    log: () => {},
  });
}

describe("Transcript Catalog inventory (before consent)", () => {
  it("previews folder identity, count, date range, scope, retention, and provider exposure without mining content", async () => {
    const source = fakeSource({
      fileA: { name: "Weekly sync - 2026-08-17T13-00-00.000Z.md", body: "# Weekly sync" },
      fileB: {
        name: "Retro - 2026-08-03T09-30-00.000Z.md",
        body: "# Retro",
        modifiedAt: "2026-08-03T09:35:00.000Z",
      },
      fileC: { name: "notes.pdf", body: "%PDF-1.7 fake", modifiedAt: "2026-08-20T08:00:00.000Z" },
    });
    const catalog = makeCatalog(source);

    const inventory = await catalog.inventory();

    expect(inventory.folder).toEqual({
      sourceSystem: "drive",
      folderId: "folder-1",
      folderName: "Transcripts",
    });
    expect(inventory.fileCount).toBe(3);
    expect(inventory.dateRange).toEqual({ earliest: "2026-08-03", latest: "2026-08-20" });
    expect(inventory.estimatedScope.totalBytes).toBeGreaterThan(0);
    expect(inventory.localRetention).toContain("retained locally");
    expect(inventory.providerExposure).toEqual({
      sendsTranscriptTextToConfiguredModel: true,
      provider: "test-provider",
      model: "test-model",
    });
    expect(inventory.externalQueryBehavior).toBe("none");
    expect(inventory.files.map((file) => file.externalFileId).sort()).toEqual([
      "fileA",
      "fileB",
      "fileC",
    ]);
    // Content-free: not one byte of file content was fetched to build the preview.
    expect(source.fetchCount("fileA")).toBe(0);
    expect(source.fetchCount("fileB")).toBe(0);
    expect(source.fetchCount("fileC")).toBe(0);
  });

  it("discloses the provider and model of the moment, not the ones from construction (#198)", async () => {
    const source = fakeSource({
      fileA: { name: "Weekly sync - 2026-08-17T13-00-00.000Z.md", body: "# Weekly sync" },
    });
    let configured = { provider: "openrouter", model: "inception/mercury-2.5-preview" };
    const catalog = makeCatalog(source, undefined, () => configured);

    const before = await catalog.inventory();
    expect(before.providerExposure).toEqual({
      sendsTranscriptTextToConfiguredModel: true,
      provider: "openrouter",
      model: "inception/mercury-2.5-preview",
    });

    /* The owner edited the model in Settings after the runtime was composed;
       the next consent decision must name what would receive transcript text
       now, not what the boot-time snapshot said. */
    configured = { provider: "anthropic", model: "claude-sonnet-5" };

    const after = await catalog.inventory();
    expect(after.providerExposure).toEqual({
      sendsTranscriptTextToConfiguredModel: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it("refuses to process before the owner has consented", async () => {
    const catalog = makeCatalog(fakeSource({ fileA: { name: "sync.md", body: "hello" } }));

    await expect(catalog.processAvailable()).rejects.toThrow(/consent/i);
    expect(catalog.status().consent).toBeNull();
  });
});

describe("Transcript Catalog consent and backfill", () => {
  it("registers one immutable normalized record per supported source revision on consent", async () => {
    const fireflies = JSON.stringify([
      { speaker_name: "Dana", text: "Let's start with the export bug.", index: 0 },
      { speaker_name: "Sam", text: "I have the ticket numbers.", index: 1 },
    ]);
    const source = fakeSource({
      fileA: {
        name: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
        body: "Dana: Three things today.\nSam: Ticket volume is down.\nDana: Good.",
        modifiedAt: "2026-08-17T13:05:00.000Z",
        url: "https://drive.example/fileA",
      },
      fileB: { name: "Retro - 2026-08-03T09-30-00.000Z.json", body: fireflies },
      fileC: { name: "meeting-notes.xyz", body: "not a transcript" },
    });
    const catalog = makeCatalog(source);

    await catalog.grantConsent();
    await catalog.whenIdle();

    const status = catalog.status();
    expect(status.consent).toEqual({
      folderId: "folder-1",
      folderName: "Transcripts",
      consentedAt: "2026-08-31T12:00:00.000Z",
    });
    expect(status.processed).toBe(2);
    expect(status.skipped).toBe(1);
    expect(status.failed).toBe(0);
    expect(status.transcriptCount).toBe(2);

    const record = catalog.getTranscript("drive_fileA_r1");
    expect(record).not.toBeNull();
    expect(record?.source).toEqual({
      sourceSystem: "drive",
      externalFileId: "fileA",
      fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
      sourceUrl: "https://drive.example/fileA",
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      observedRevision: 1,
      modifiedAt: "2026-08-17T13:05:00.000Z",
    });
    expect(record?.extractorVersion).toBe(TRANSCRIPT_CATALOG_EXTRACTOR_VERSION);
    expect(record?.ingestedAt).toBe("2026-08-31T12:00:00.000Z");
    expect(record?.meetingDate).toBe("2026-08-17");
    expect(record?.occurrence).toBeNull();
    expect(record?.speakers).toEqual(["Dana", "Sam"]);
    expect(record?.normalizedText).toContain("Three things today");

    // Conversion primitives are reused: a Fireflies sentences export becomes
    // `Speaker: text` lines, and its speaker labels land in the record.
    const converted = catalog.getTranscript("drive_fileB_r1");
    expect(converted?.normalizedText).toBe(
      "Dana: Let's start with the export bug.\nSam: I have the ticket numbers.",
    );
    expect(converted?.speakers).toEqual(["Dana", "Sam"]);
    expect(converted?.meetingDate).toBe("2026-08-03");
  });

  it("keeps #125's speaker-label classification: two-token capitalized labels only", async () => {
    const source = fakeSource({
      fileA: {
        name: "sync - 2026-08-17T13-00-00.000Z.md",
        body: [
          "Grace Hopper: Ready.",
          "Rear Admiral Grace Hopper: Not a two-token label.",
          "DR SMITH: Not a person-shaped label.",
          "OPERATOR: A single-token label is captured.",
          "Ada Lovelace: Ready too.",
        ].join("\n"),
      },
    });
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();

    expect(catalog.getTranscript("drive_fileA_r1")?.speakers).toEqual([
      "Grace Hopper",
      "OPERATOR",
      "Ada Lovelace",
    ]);
  });

  it("re-derives speaker labels on a record stored under an older extractor", async () => {
    /* Records are immutable, so a derivation fix would otherwise never reach
       the corpus already catalogued: every Markdown transcript in it would keep
       reporting no speakers, and every Debrief keep an unprefillable roster.
       Only the derived fields move — the text, the source and the ledger are
       untouched. */
    const workspaceDir = mkdtempSync(join(tmpdir(), "transcript-catalog-rederive-"));
    const source = fakeSource({
      fileA: {
        name: "Stand-Up-transcript-2026-08-17T13-00-00.000Z.md",
        body: "**Grace Hopper** *[00:00]*: Ready.",
      },
    });
    const catalog = makeCatalog(source, workspaceDir);
    await catalog.grantConsent();
    await catalog.whenIdle();

    const store = new TranscriptCatalogStore(workspaceDir);
    const stored = store.readTranscript("drive_fileA_r1");
    expect(stored).not.toBeNull();
    store.updateTranscript({ ...stored!, speakers: [], extractorVersion: 1 });
    expect(store.readTranscript("drive_fileA_r1")?.speakers).toEqual([]);

    await catalog.processAvailable();
    await catalog.whenIdle();

    const repaired = store.readTranscript("drive_fileA_r1");
    expect(repaired?.speakers).toEqual(["Grace Hopper"]);
    expect(repaired?.extractorVersion).toBe(TRANSCRIPT_CATALOG_EXTRACTOR_VERSION);
    // Re-derived in place, not re-registered: same text, same revision.
    expect(repaired?.normalizedText).toBe(stored!.normalizedText);
    expect(repaired?.source).toEqual(stored!.source);
    expect(repaired?.ingestedAt).toBe(stored!.ingestedAt);
  });

  it("retires a copy the Catalog mined before it knew to refuse it, keeping the fuller text", async () => {
    /* The corpus was catalogued under the older per-file rule. The richest
       member is kept: a `_summary` is an artifact of the recording its
       `_transcript` carries in full. */
    const workspaceDir = mkdtempSync(join(tmpdir(), "transcript-catalog-retire-"));
    const source = fakeSource({
      fileA: { name: "Team Sync_transcript.txt", body: "Dana: Three things today, at length." },
    });
    const catalog = makeCatalog(source, workspaceDir);
    await catalog.grantConsent();
    await catalog.whenIdle();

    // A second record for the same recording, as the older rule would have left it.
    const store = new TranscriptCatalogStore(workspaceDir);
    const kept = store.readTranscript("drive_fileA_r1");
    expect(kept).not.toBeNull();
    store.saveTranscript({
      ...kept!,
      id: "drive_fileB_r1",
      source: { ...kept!.source, externalFileId: "fileB", fileName: "Team Sync_summary.txt" },
      normalizedText: "Dana: Short.",
    });
    expect(store.listTranscripts()).toHaveLength(2);

    await catalog.processAvailable();
    await catalog.whenIdle();

    const remaining = store.listTranscripts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.source.fileName).toBe("Team Sync_transcript.txt");
  });

  it("mines one recording once, however many copies of it Drive holds", async () => {
    /* Drive makes a new file id for every copy, and an exporter writes the
       same recording as `.json` and `.md` and as `_transcript` beside
       `_summary`. Mined per file, one meeting earned three Debriefs and its
       action items were counted three times. */
    const source = fakeSource({
      original: {
        name: "Team Sync-transcript-2026-08-17T13-00-00.000Z.md",
        body: "Dana: Three things today.",
      },
      identicalBytes: {
        name: "Copy of Team Sync-transcript-2026-08-17T13-00-00.000Z.md",
        body: "Dana: Three things today.",
      },
      otherFormat: {
        name: "Team Sync-transcript-2026-08-17T13-00-00.000Z.json",
        body: JSON.stringify([{ speaker_name: "Dana", text: "Three things today.", index: 0 }]),
      },
      differentMeeting: {
        name: "Team Sync-transcript-2026-08-18T13-00-00.000Z.md",
        body: "Dana: A different day.",
      },
    });
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();

    const kept = catalog.listTranscripts();
    expect(kept).toHaveLength(2);
    expect(kept.map((record) => record.meetingDate).sort()).toEqual(["2026-08-17", "2026-08-18"]);
    // The copies are still accounted for, and each one names what covers it.
    const status = catalog.status();
    expect(status.skipped).toBe(2);
    expect(status.transcriptCount).toBe(2);
  });

  it("reads the Markdown speaker line an export writes with a bracketed timestamp", async () => {
    /* `**Richard Achee** *[00:00]*: …`. The plain label pattern cannot reach
       the separating colon — it refuses to cross the one inside `00:00` — so
       every Markdown transcript in the corpus recorded no speakers at all, and
       with no speakers a transcript-owned Meeting has no participants and its
       Debrief has no roster to prefill. */
    const source = fakeSource({
      fileA: {
        name: "Stand-Up-transcript-2026-08-17T13-00-00.000Z.md",
        body: [
          "# Found42 Stand-Up Meeting",
          "",
          "**Richard Achee** *[00:00]*: So we'll do a recap.",
          "**Adejoke Olaosebikan** *[00:18]*: Yes, I made some progress.",
          "__Dana__: Emphasis without a timestamp still counts.",
          "**Richard Achee** *[01:02]*: Repeats are one speaker.",
        ].join("\n"),
      },
    });
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();

    expect(catalog.getTranscript("drive_fileA_r1")?.speakers).toEqual([
      "Richard Achee",
      "Adejoke Olaosebikan",
      "Dana",
    ]);
  });

  it("is idempotent: a second pass over unchanged revisions registers nothing new", async () => {
    const source = fakeSource({
      fileA: { name: "sync - 2026-08-17T13-00-00.000Z.md", body: "Dana: Morning." },
      fileC: { name: "notes.xyz", body: "not a transcript" },
    });
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();
    const first = catalog.listTranscripts();

    const pass = await catalog.processAvailable();

    expect(pass).toEqual({ processed: 0, failed: 0, skipped: 0, unchanged: 2 });
    expect(catalog.listTranscripts()).toEqual(first);
    expect(catalog.status().transcriptCount).toBe(1);
  });

  it("processes files that arrive after the initial backfill", async () => {
    const files: Record<string, FakeFile> = {
      fileA: { name: "sync - 2026-08-17T13-00-00.000Z.md", body: "Dana: Morning." },
    };
    const source = fakeSource(files);
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();
    expect(catalog.status().transcriptCount).toBe(1);

    files.fileD = { name: "standup - 2026-08-19T16-00-00.000Z.md", body: "Priya: Late arrival." };
    const pass = await catalog.processAvailable();

    expect(pass).toEqual({ processed: 1, failed: 0, skipped: 0, unchanged: 1 });
    expect(catalog.status().transcriptCount).toBe(2);
    expect(catalog.getTranscript("drive_fileD_r1")?.meetingDate).toBe("2026-08-19");
  });

  it("retries a failed conversion in place, and registers fixed content as the next revision", async () => {
    const brokenBody = "{not valid json";
    const files: Record<string, FakeFile> = {
      fileB: { name: "broken - 2026-08-18T15-00-00.000Z.json", body: brokenBody },
    };
    const source = fakeSource(files);
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();
    expect(catalog.status()).toMatchObject({ processed: 0, failed: 1, transcriptCount: 0 });

    // The same broken bytes retry without producing a record or a new revision.
    expect(await catalog.processAvailable()).toEqual({
      processed: 0,
      failed: 1,
      skipped: 0,
      unchanged: 0,
    });
    expect(catalog.status().transcriptCount).toBe(0);

    // Fixed bytes are a new source revision, registered as the next one.
    files.fileB = {
      name: files.fileB.name,
      body: JSON.stringify([{ speaker_name: "Sam", text: "Fixed export.", index: 0 }]),
    };
    const pass = await catalog.processAvailable();

    expect(pass).toEqual({ processed: 1, failed: 0, skipped: 0, unchanged: 0 });
    expect(catalog.getTranscript("drive_fileB_r2")?.normalizedText).toBe("Sam: Fixed export.");
    // The broken first revision stays failed in the ledger; the fixed one is processed.
    expect(catalog.status()).toMatchObject({ processed: 1, failed: 1, transcriptCount: 1 });
  });
});

describe("Transcript Catalog restart, pause, and revisions", () => {
  it("resumes across a restart, retries the failed file, and stays exactly-once", async () => {
    const inner = fakeSource({
      fileA: { name: "sync - 2026-08-17T13-00-00.000Z.md", body: "Dana: Morning." },
      fileB: { name: "retro - 2026-08-18T15-00-00.000Z.md", body: "Sam: Ready when you are." },
    });
    let fileBFails = true;
    const source: TranscriptCatalogSource = {
      folder: () => inner.folder(),
      listFiles: () => inner.listFiles(),
      async fetch(externalFileId) {
        if (externalFileId === "fileB" && fileBFails) {
          throw new Error("Drive temporarily unavailable");
        }
        return inner.fetch(externalFileId);
      },
    };
    const workspaceDir = mkdtempSync(join(tmpdir(), "transcript-catalog-"));
    const firstEra = makeCatalog(source, workspaceDir);
    await firstEra.grantConsent();
    await firstEra.whenIdle();
    expect(firstEra.status()).toMatchObject({ processed: 1, failed: 1 });

    // Restart: a fresh catalog over the same Workspace sees the same ledger…
    fileBFails = false;
    const secondEra = makeCatalog(source, workspaceDir);
    expect(secondEra.status()).toMatchObject({ processed: 1, failed: 1, pending: 0 });

    // …and resuming finishes the backfill exactly once.
    secondEra.resume();
    await secondEra.whenIdle();
    expect(secondEra.status()).toMatchObject({ processed: 2, failed: 0, transcriptCount: 2 });
    expect(secondEra.listTranscripts().map((record) => record.id)).toEqual([
      "drive_fileA_r1",
      "drive_fileB_r1",
    ]);

    // Unchanged revisions stay exactly-once after the restart.
    expect(await secondEra.processAvailable()).toEqual({
      processed: 0,
      failed: 0,
      skipped: 0,
      unchanged: 2,
    });
  });

  it("pauses between files without losing the catalog, and resume continues", async () => {
    const inner = fakeSource({
      fileA: { name: "one - 2026-08-17T13-00-00.000Z.md", body: "Dana: First." },
      fileB: { name: "two - 2026-08-18T15-00-00.000Z.md", body: "Sam: Second." },
      fileC: { name: "three - 2026-08-19T16-00-00.000Z.md", body: "Dana: Third." },
    });
    let pausedOnce = false;
    const source: TranscriptCatalogSource = {
      folder: () => inner.folder(),
      listFiles: () => inner.listFiles(),
      async fetch(externalFileId) {
        if (externalFileId === "fileB" && !pausedOnce) {
          pausedOnce = true;
          // The owner pauses while a pass is running; the in-flight file
          // completes and the pass stops before the next one.
          catalog.pause();
        }
        return inner.fetch(externalFileId);
      },
    };
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();

    expect(catalog.status()).toMatchObject({
      backfill: "paused",
      processed: 2,
      transcriptCount: 2,
    });
    expect(catalog.getTranscript("drive_fileC_r1")).toBeNull();

    catalog.resume();
    await catalog.whenIdle();
    expect(catalog.status()).toMatchObject({ backfill: "idle", processed: 3, transcriptCount: 3 });
  });

  it("represents a changed source revision as a deliberate new immutable record", async () => {
    const files: Record<string, FakeFile> = {
      fileA: {
        name: "sync - 2026-08-17T13-00-00.000Z.md",
        body: "Dana: Original agenda.",
        modifiedAt: "2026-08-17T13:05:00.000Z",
      },
    };
    const source = fakeSource(files);
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();
    const first = catalog.getTranscript("drive_fileA_r1");
    const firstSnapshot = JSON.stringify(first);

    files.fileA = {
      name: files.fileA.name,
      body: "Dana: Revised agenda.",
      modifiedAt: "2026-08-18T09:00:00.000Z",
    };
    const pass = await catalog.processAvailable();

    expect(pass).toEqual({ processed: 1, failed: 0, skipped: 0, unchanged: 0 });
    expect(catalog.status().transcriptCount).toBe(2);
    // The predecessor is untouched, not overwritten.
    expect(JSON.stringify(catalog.getTranscript("drive_fileA_r1"))).toBe(firstSnapshot);
    const revised = catalog.getTranscript("drive_fileA_r2");
    expect(revised?.source.observedRevision).toBe(2);
    expect(revised?.source.checksum).not.toBe(first?.source.checksum);
    expect(revised?.source.modifiedAt).toBe("2026-08-18T09:00:00.000Z");
    expect(revised?.normalizedText).toContain("Revised agenda");
  });

  it("associates a Calendar occurrence when it becomes known, without touching the artifact", async () => {
    const catalog = makeCatalog(
      fakeSource({ fileA: { name: "sync - 2026-08-17T13-00-00.000Z.md", body: "Dana: Morning." } }),
    );
    await catalog.grantConsent();
    await catalog.whenIdle();

    const associated = await catalog.associateOccurrence("drive_fileA_r1", {
      occurrence: {
        occurrenceKey: "2026-08-17T1300",
        calendarEventId: "evt_42",
      },
      speakerIdentityMappings: [],
      roster: [],
    });
    expect(associated.occurrence).toEqual({
      occurrenceKey: "2026-08-17T1300",
      calendarEventId: "evt_42",
    });
    expect(associated.source.checksum).toBe(
      catalog.getTranscript("drive_fileA_r1")?.source.checksum,
    );
    expect(associated.normalizedText).toBe(catalog.getTranscript("drive_fileA_r1")?.normalizedText);
    await expect(
      catalog.associateOccurrence("drive_missing_r1", {
        occurrence: { occurrenceKey: "x", calendarEventId: null },
        speakerIdentityMappings: [],
        roster: [],
      }),
    ).rejects.toThrow(/unknown/i);
  });

  it("retries an unsupported file after a rename makes it supported", async () => {
    const files: Record<string, FakeFile> = {
      fileA: { name: "minutes.xyz", body: "Dana: Renamed into support." },
    };
    const source = fakeSource(files);
    const catalog = makeCatalog(source);
    await catalog.grantConsent();
    await catalog.whenIdle();
    expect(catalog.status()).toMatchObject({ processed: 0, skipped: 1, transcriptCount: 0 });

    files.fileA = {
      name: "minutes - 2026-08-19T16-00-00.000Z.md",
      body: "Dana: Renamed into support.",
    };
    const pass = await catalog.processAvailable();

    expect(pass).toEqual({ processed: 1, failed: 0, skipped: 0, unchanged: 0 });
    expect(catalog.getTranscript("drive_fileA_r1")?.normalizedText).toContain(
      "Renamed into support",
    );
  });

  it("never rewrites an existing record file; association metadata is the only mutation", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "transcript-catalog-"));
    const store = new TranscriptCatalogStore(workspaceDir);
    const record: TranscriptRecord = {
      id: "drive_fileA_r1",
      source: {
        sourceSystem: "drive",
        externalFileId: "fileA",
        fileName: "sync.md",
        sourceUrl: null,
        checksum: "a".repeat(64),
        observedRevision: 1,
        modifiedAt: null,
      },
      ingestedAt: "2026-08-31T12:00:00.000Z",
      extractorVersion: 1,
      normalizedText: "Dana: Morning.",
      meetingDate: null,
      occurrence: null,
      speakers: ["Dana"],
      speakerIdentityMappings: [],
      meetingId: null,
      roster: [],
    };
    store.saveTranscript(record);

    // A replayed registration (crash between record and ledger writes) cannot mutate it.
    store.saveTranscript({ ...record, ingestedAt: "2027-01-01T00:00:00.000Z" });
    expect(store.readTranscript(record.id)?.ingestedAt).toBe("2026-08-31T12:00:00.000Z");

    store.updateTranscript({ ...record, occurrence: { occurrenceKey: "k", calendarEventId: "e" } });
    const updated = store.readTranscript(record.id);
    expect(updated?.occurrence).toEqual({ occurrenceKey: "k", calendarEventId: "e" });
    expect(updated?.normalizedText).toBe("Dana: Morning.");
  });
});

describe("Transcript Catalog Drive source", () => {
  it("maps Drive listing to content-free metadata and reuses the Drive client seam for bytes", async () => {
    let mediaGets = 0;
    let exports = 0;
    const client: DriveFileClient = {
      files: {
        list: async () => ({
          data: {
            files: [
              {
                id: "doc1",
                name: "Sync",
                mimeType: "application/vnd.google-apps.document",
                webViewLink: "https://docs.example/doc1",
                modifiedTime: "2026-08-17T13:00:00.000Z",
              },
              {
                id: "txt1",
                name: "retro - 2026-08-18T15-00-00.000Z.txt",
                mimeType: "text/plain",
                size: "42",
                modifiedTime: "2026-08-18T15:04:00.000Z",
              },
              { id: "sub1", name: "Nested", mimeType: "application/vnd.google-apps.folder" },
            ],
            nextPageToken: null,
          },
        }),
        get: async (params) => {
          if (params.alt === "media") {
            mediaGets += 1;
            return { data: Buffer.from("Dana: Morning.") };
          }
          return {
            data: {
              mimeType:
                params.fileId === "doc1" ? "application/vnd.google-apps.document" : "text/plain",
            },
          };
        },
        export: async () => {
          exports += 1;
          return { data: Buffer.from("Priya: From a Google Doc.") };
        },
      },
    };
    const source = createDriveCatalogSource(client, {
      folderId: "folder-1",
      folderName: "Transcripts",
    });

    expect(await source.folder()).toEqual({ folderId: "folder-1", folderName: "Transcripts" });
    expect(await source.listFiles()).toEqual([
      {
        externalFileId: "doc1",
        fileName: "Sync",
        sizeBytes: null,
        modifiedAt: "2026-08-17T13:00:00.000Z",
        sourceUrl: "https://docs.example/doc1",
        conversionName: "Sync.txt",
      },
      {
        externalFileId: "txt1",
        fileName: "retro - 2026-08-18T15-00-00.000Z.txt",
        sizeBytes: 42,
        modifiedAt: "2026-08-18T15:04:00.000Z",
        sourceUrl: null,
      },
    ]);

    expect((await source.fetch("doc1"))?.toString()).toBe("Priya: From a Google Doc.");
    expect(exports).toBe(1);
    expect((await source.fetch("txt1"))?.toString()).toBe("Dana: Morning.");
    expect(mediaGets).toBe(1);
  });

  it("round-trips a full backfill through the Drive-shaped source", async () => {
    const client: DriveFileClient = {
      files: {
        list: async () => ({
          data: {
            files: [
              {
                id: "f1",
                name: "sync - 2026-08-17T13-00-00.000Z.md",
                mimeType: "text/markdown",
                size: "14",
                modifiedTime: "2026-08-17T13:00:00.000Z",
              },
              {
                id: "doc9",
                name: "Weekly sync",
                mimeType: "application/vnd.google-apps.document",
                modifiedTime: "2026-08-18T10:00:00.000Z",
              },
            ],
            nextPageToken: null,
          },
        }),
        get: async (params) => {
          if (params.alt === "media") {
            return { data: Buffer.from("Dana: Via Drive.") };
          }
          return {
            data: {
              mimeType:
                params.fileId === "doc9" ? "application/vnd.google-apps.document" : "text/markdown",
            },
          };
        },
        export: async () => {
          return { data: Buffer.from("Priya: Exported doc text.") };
        },
      },
    };
    const catalog = makeCatalog(
      createDriveCatalogSource(client, { folderId: "folder-1", folderName: "Transcripts" }),
    );
    await catalog.grantConsent();
    await catalog.whenIdle();

    expect(catalog.status()).toMatchObject({
      processed: 2,
      failed: 0,
      skipped: 0,
      transcriptCount: 2,
    });
    expect(catalog.getTranscript("drive_f1_r1")?.normalizedText).toBe("Dana: Via Drive.");
    expect(catalog.getTranscript("drive_f1_r1")?.speakers).toEqual(["Dana"]);
    // An extensionless Google Doc converts through its export, not its name.
    expect(catalog.getTranscript("drive_doc9_r1")?.normalizedText).toBe(
      "Priya: Exported doc text.",
    );
    expect(catalog.getTranscript("drive_doc9_r1")?.speakers).toEqual(["Priya"]);
  });
});
