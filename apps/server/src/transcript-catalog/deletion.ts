import type {
  TranscriptConsumerDisclosure,
  TranscriptDeletionReceipt,
  TranscriptDeletionRemovedCounts,
  TranscriptDeletionTombstone,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { TRANSCRIPT_DELETE_CONFIRMATION } from "@chief-of-staff-demo/shared";
import type { TranscriptCatalogStore } from "./store.js";
import type { TranscriptIdentityStore } from "./identity-store.js";
import type { TranscriptRelevanceStore } from "./relevance-store.js";

export type TranscriptDeletionErrorCode = "transcript-not-found" | "confirmation-required";

/** A typed deletion refusal: an unknown transcript, or the exact confirmation phrase missing. */
export class TranscriptDeletionError extends Error {
  constructor(
    readonly code: TranscriptDeletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptDeletionError";
  }
}

/**
 * One registered consumer of transcript-derived records (issue #128). The
 * deletion cascade walks every registration: `inspect` discloses what would
 * be removed, `purge` removes it. A consumer module registers itself at the
 * composition root; no external provider belongs behind this port.
 */
export interface TranscriptConsumerRegistry {
  /** Stable consumer name, used in disclosures and the receipt. */
  readonly consumer: string;
  readonly label: string;
  /** How many of this consumer's records derive from the transcript. */
  inspect(record: TranscriptRecord): number;
  /** Remove every transcript-derived record. Idempotent; returns the count. */
  purge(transcriptId: string): number;
}

export interface TranscriptDeletionDeps {
  catalog: TranscriptCatalogStore;
  identity: TranscriptIdentityStore;
  relevance: TranscriptRelevanceStore;
  registries: TranscriptConsumerRegistry[];
  now?: () => Date;
  log?: (message: string) => void;
}

function zeroCounts(): TranscriptDeletionRemovedCounts {
  return {
    transcriptRecords: 0,
    identityMentions: 0,
    organizationMentions: 0,
    identityCandidates: 0,
    identityDecisions: 0,
    organizationMergeDecisions: 0,
    transcriptRememberedMappings: 0,
    extractionLedgerEntries: 0,
    relevanceCandidates: 0,
    relevanceDecisions: 0,
    consumerRecords: 0,
  };
}

/**
 * The Transcript Catalog's deletion surface (issue #128). Local-only by
 * construction: it removes the record and every local transcript-derived
 * record behind the stores it composes, writes the content-free
 * do-not-reingest tombstone, and contacts no provider. The tombstone wins
 * over automatic Drive detection until the owner explicitly restores
 * processing permission (spec #117, constraint 11).
 */
export class TranscriptDeletionService {
  private readonly catalog: TranscriptCatalogStore;
  private readonly identity: TranscriptIdentityStore;
  private readonly relevance: TranscriptRelevanceStore;
  private readonly registries: TranscriptConsumerRegistry[];
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(deps: TranscriptDeletionDeps) {
    this.catalog = deps.catalog;
    this.identity = deps.identity;
    this.relevance = deps.relevance;
    this.registries = deps.registries;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /**
   * The confirmation disclosure: what deletion would remove through each
   * registered consumer, before anything is removed.
   */
  preview(transcriptId: string): { consumerRecords: TranscriptConsumerDisclosure[] } {
    const record = this.requireRecord(transcriptId);
    const consumerRecords = this.registries.map((registry) => ({
      consumer: registry.consumer,
      label: registry.label,
      recordCount: registry.inspect(record),
    }));
    return { consumerRecords };
  }

  /**
   * The explicit privacy exception to the Catalog's retained corpus (spec
   * #117). Order matters: the tombstone is written FIRST, before anything
   * is removed, so reingestion is blocked at every crash point of the
   * cascade — a crash mid-cascade leaves text plus a standing tombstone,
   * and re-running the deletion completes it, because every cascade step
   * is idempotent. A deletion whose record is already gone is a typed
   * refusal; the tombstone and receipt outlive it.
   */
  delete(transcriptId: string, input: { confirmation: string }): TranscriptDeletionReceipt {
    if (input.confirmation !== TRANSCRIPT_DELETE_CONFIRMATION) {
      throw new TranscriptDeletionError(
        "confirmation-required",
        `Transcript deletion requires the exact confirmation ${TRANSCRIPT_DELETE_CONFIRMATION}.`,
      );
    }
    const record = this.requireRecord(transcriptId);

    /* Tombstone-first: from here on, reingestion is blocked no matter where
       this cascade is interrupted. A standing tombstone over a live record
       is an interrupted deletion, not a completed one, so re-running
       finishes the idempotent steps instead of refusing. */
    const deletedAt = this.now().toISOString();
    const tombstone: TranscriptDeletionTombstone = {
      sourceSystem: record.source.sourceSystem,
      externalFileId: record.source.externalFileId,
      checksum: record.source.checksum,
      deletedAt,
      policy: "do-not-reingest",
    };
    this.catalog.writeTombstone(tombstone);

    const removed = zeroCounts();
    const identityCounts = this.identity.forgetTranscript(transcriptId);
    removed.identityMentions = identityCounts.mentions;
    removed.organizationMentions = identityCounts.organizations;
    removed.identityCandidates = identityCounts.candidates;
    removed.identityDecisions = identityCounts.decisions;
    removed.organizationMergeDecisions = identityCounts.organizationDecisions;
    removed.transcriptRememberedMappings = identityCounts.transcriptMappings;
    removed.extractionLedgerEntries = identityCounts.ledgerEntries;
    const relevanceCounts = this.relevance.forgetTranscript(transcriptId);
    removed.relevanceCandidates = relevanceCounts.candidates;
    removed.relevanceDecisions = relevanceCounts.decisions;
    for (const registry of this.registries) {
      removed.consumerRecords += registry.purge(transcriptId);
    }

    this.catalog.deleteTranscript(transcriptId);

    const receipt: TranscriptDeletionReceipt = {
      receiptId: `transcript-deletion-${transcriptId}-${deletedAt}`,
      transcriptId,
      externalFileId: record.source.externalFileId,
      deletedAt,
      removed: { ...removed, transcriptRecords: 1 },
      tombstone,
      remoteProviderOperations: 0,
    };
    this.catalog.saveDeletionReceipt(receipt);
    this.log(
      `Transcript deleted: ${transcriptId}; ${removed.consumerRecords} consumer records; ` +
        `remote provider operations: 0`,
    );
    return receipt;
  }

  tombstones(): TranscriptDeletionTombstone[] {
    return this.catalog.listTombstones();
  }

  tombstone(externalFileId: string): TranscriptDeletionTombstone | null {
    return this.catalog.readTombstone(externalFileId);
  }

  deletionReceipt(transcriptId: string): TranscriptDeletionReceipt | null {
    return this.catalog.getDeletionReceipt(transcriptId);
  }

  /**
   * The owner's explicit re-permission of a deleted source. It removes the
   * tombstone and the exactly-once ledger entries for the file, so the next
   * pass processes it fresh. Nothing is reingested until the Catalog's own
   * processing runs.
   */
  restoreProcessingPermission(
    externalFileId: string,
  ): { tombstone: TranscriptDeletionTombstone } | null {
    const tombstone = this.catalog.readTombstone(externalFileId);
    if (tombstone === null) return null;
    this.catalog.deleteTombstone(externalFileId);
    this.catalog.removeLedgerEntries(externalFileId);
    this.log(`Processing permission restored for source file ${externalFileId}`);
    return { tombstone };
  }

  private requireRecord(transcriptId: string): TranscriptRecord {
    const record = this.catalog.readTranscript(transcriptId);
    if (record !== null) return record;
    if (this.catalog.getDeletionReceipt(transcriptId) !== null) {
      throw new TranscriptDeletionError(
        "transcript-not-found",
        `Transcript ${transcriptId} is already deleted; its tombstone stands.`,
      );
    }
    throw new TranscriptDeletionError(
      "transcript-not-found",
      `Unknown transcript: ${transcriptId}`,
    );
  }
}
