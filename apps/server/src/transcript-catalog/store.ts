import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  TranscriptConsent,
  TranscriptDeletionReceipt,
  TranscriptDeletionTombstone,
  TranscriptLedgerEntry,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { recordingKey } from "../text/meetingFileName.js";

/**
 * Durable state of the Transcript Catalog: the standing folder consent, the
 * processing ledger (one entry per source revision — the exactly-once record),
 * and one immutable JSON file per Transcript record. There is no database: the
 * Workspace directory is the store, as everywhere else in the app.
 */
export class TranscriptCatalogStore {
  private readonly root: string;
  private readonly transcriptsDir: string;
  private readonly tombstonesDir: string;
  private readonly receiptsDir: string;

  constructor(workspaceDir: string) {
    this.root = join(workspaceDir, "transcript-catalog");
    this.transcriptsDir = join(this.root, "transcripts");
    this.tombstonesDir = join(this.root, "tombstones");
    this.receiptsDir = join(this.root, "deletion-receipts");
  }

  readConsent(): TranscriptConsent | null {
    return this.read(join(this.root, "consent.json")) as TranscriptConsent | null;
  }

  writeConsent(consent: TranscriptConsent): void {
    mkdirSync(this.root, { recursive: true });
    this.writeAtomic(join(this.root, "consent.json"), this.serialize(consent));
  }

  /** Whether the owner paused the backfill; survives a restart. */
  readPaused(): boolean {
    const state = this.read(join(this.root, "backfill.json")) as { paused?: boolean } | null;
    return state?.paused === true;
  }

  writePaused(paused: boolean): void {
    mkdirSync(this.root, { recursive: true });
    this.writeAtomic(join(this.root, "backfill.json"), this.serialize({ paused }));
  }

  readLedger(): TranscriptLedgerEntry[] {
    const entries = this.read(join(this.root, "ledger.json")) as TranscriptLedgerEntry[] | null;
    return entries ?? [];
  }

  /**
   * Replace one entry, keyed by source revision (external file + observed
   * revision). Entries are append-or-update only; a stored entry is never
   * rewritten to forget what happened to a revision.
   */
  saveLedgerEntry(entry: TranscriptLedgerEntry): void {
    const entries = this.readLedger();
    const key = (candidate: TranscriptLedgerEntry): string =>
      `${candidate.externalFileId}#${candidate.observedRevision}`;
    const next = [...entries.filter((candidate) => key(candidate) !== key(entry)), entry];
    next.sort((a, b) => key(a).localeCompare(key(b)));
    mkdirSync(this.root, { recursive: true });
    this.writeAtomic(join(this.root, "ledger.json"), this.serialize(next));
  }

  /**
   * The registered Transcript that already covers this source file, if
   * another one does. Drive makes a new file id every time a transcript is
   * copied, and an exporter writes the same recording as `.json` and `.md`
   * and as `_transcript` beside `_summary`: the corpus held 29 files for 19
   * distinct recordings, each copy mining its own identity and earning its
   * own Debrief.
   */
  processedDuplicate(
    checksum: string,
    fileName: string,
    exceptFileId: string,
  ): TranscriptLedgerEntry | null {
    const key = recordingKey(fileName);
    return (
      this.readLedger().find(
        (entry) =>
          entry.state === "processed" &&
          entry.transcriptId !== null &&
          entry.externalFileId !== exceptFileId &&
          /* Identical bytes, or the same recording under another name — a
             `.json` and a `.md` export of one meeting are not the same file
             and are not two meetings. */
          (entry.checksum === checksum || (key !== null && recordingKey(entry.fileName) === key)),
      ) ?? null
    );
  }

  latestEntry(externalFileId: string): TranscriptLedgerEntry | null {
    const entries = this.readLedger().filter((entry) => entry.externalFileId === externalFileId);
    if (entries.length === 0) return null;
    return entries.reduce((latest, entry) =>
      entry.observedRevision > latest.observedRevision ? entry : latest,
    );
  }

  /**
   * The date Meeting history is collected back to (issue #152): the oldest
   * Transcript's meeting date, falling back to its ingestion date when the
   * meeting date is unknown. Null when the Workspace holds no Transcripts.
   */
  oldestRecordedDate(): string | null {
    let oldest: string | null = null;
    for (const record of this.listTranscripts()) {
      const at = typeof record.meetingDate === "string" ? record.meetingDate : record.ingestedAt;
      if (typeof at !== "string") continue;
      if (oldest === null || at < oldest) oldest = at;
    }
    return oldest;
  }

  readTranscript(id: string): TranscriptRecord | null {
    return this.read(join(this.transcriptsDir, `${id}.json`)) as TranscriptRecord | null;
  }

  /**
   * Write-once: a Transcript record is immutable, so an existing record file
   * is never rewritten — a crash between this write and its ledger update
   * replays harmlessly instead of mutating the record (a fresh ingestedAt
   * would silently rewrite history). Association metadata has its own path.
   */
  saveTranscript(record: TranscriptRecord): void {
    mkdirSync(this.transcriptsDir, { recursive: true });
    const path = join(this.transcriptsDir, `${record.id}.json`);
    if (existsSync(path)) return;
    this.writeAtomic(path, this.serialize(record));
  }

  /** Overwrite association metadata only; the artifact fields stay untouched. */
  updateTranscript(record: TranscriptRecord): void {
    mkdirSync(this.transcriptsDir, { recursive: true });
    this.writeAtomic(join(this.transcriptsDir, `${record.id}.json`), this.serialize(record));
  }

  listTranscripts(): TranscriptRecord[] {
    if (!existsSync(this.transcriptsDir)) return [];
    return readdirSync(this.transcriptsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(join(this.transcriptsDir, name)) as TranscriptRecord | null)
      .filter((record): record is TranscriptRecord => record !== null);
  }

  /**
   * Delete the local record of one transcript (issue #128). The artifact is
   * immutable while it exists, so the only local path that removes one is
   * the explicit deletion cascade.
   */
  deleteTranscript(id: string): boolean {
    const path = join(this.transcriptsDir, `${id}.json`);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  /**
   * The content-free do-not-reingest record, keyed by source identity
   * (external file id). It is written by the deletion cascade and read
   * before every processing attempt, so a deleted source wins over
   * automatic Drive detection (spec #117, constraint 11) across restarts.
   */
  writeTombstone(tombstone: TranscriptDeletionTombstone): void {
    mkdirSync(this.tombstonesDir, { recursive: true });
    this.writeAtomic(this.tombstonePath(tombstone.externalFileId), this.serialize(tombstone));
  }

  readTombstone(externalFileId: string): TranscriptDeletionTombstone | null {
    return this.read(this.tombstonePath(externalFileId)) as TranscriptDeletionTombstone | null;
  }

  listTombstones(): TranscriptDeletionTombstone[] {
    if (!existsSync(this.tombstonesDir)) return [];
    return readdirSync(this.tombstonesDir)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) => this.read(join(this.tombstonesDir, name)) as TranscriptDeletionTombstone | null,
      )
      .filter((tombstone): tombstone is TranscriptDeletionTombstone => tombstone !== null)
      .sort((left, right) => left.deletedAt.localeCompare(right.deletedAt));
  }

  /** Explicit restore of processing permission removes the tombstone. */
  deleteTombstone(externalFileId: string): boolean {
    const path = this.tombstonePath(externalFileId);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  /**
   * Restore clears the exactly-once record for the source file too, so the
   * next pass processes it fresh instead of trusting a processed entry whose
   * record no longer exists. The deletion receipt keeps the audit trail.
   */
  removeLedgerEntries(externalFileId: string): number {
    const entries = this.readLedger();
    const kept = entries.filter((entry) => entry.externalFileId !== externalFileId);
    if (kept.length === entries.length) return 0;
    mkdirSync(this.root, { recursive: true });
    this.writeAtomic(join(this.root, "ledger.json"), this.serialize(kept));
    return entries.length - kept.length;
  }

  /** The audited receipt of one deletion; readable even after a restore. */
  saveDeletionReceipt(receipt: TranscriptDeletionReceipt): void {
    mkdirSync(this.receiptsDir, { recursive: true });
    this.writeAtomic(
      join(this.receiptsDir, `${receipt.transcriptId}.json`),
      this.serialize(receipt),
    );
  }

  getDeletionReceipt(transcriptId: string): TranscriptDeletionReceipt | null {
    return this.read(
      join(this.receiptsDir, `${transcriptId}.json`),
    ) as TranscriptDeletionReceipt | null;
  }

  private tombstonePath(externalFileId: string): string {
    return join(this.tombstonesDir, `${encodeURIComponent(externalFileId)}.json`);
  }

  private serialize(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  private read(path: string): unknown {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  private writeAtomic(path: string, content: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  }
}
