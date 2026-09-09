import { z } from "zod/v3";
import type { ExternalContactId } from "./person-profile.js";

/**
 * Extraction result — mirror of the routine's `routine/outbox-schema.json` v1,
 * with two adaptations for this app:
 *  - `drafts[].body` added: this app composes the draft text itself and creates
 *    the Gmail draft from it.
 *  - `sourceId` / `sourceUrl` generalized: a run id or Fireflies transcript id
 *    and any source URL, instead of Drive file id / url.
 */
export const ExtractionResultSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string(),
  sourceFileName: z.string(),
  sourceUrl: z.string().nullable(),
  processedAt: z.string(),
  isTranscript: z.boolean(),
  skipReason: z.string().nullable(),
  summary: z.string(),
  tasks: z.array(
    z.strictObject({
      title: z.string().min(1),
      owner: z.string().optional(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "due must be YYYY-MM-DD")
        .optional(),
      notes: z.string().optional(),
      sourceQuote: z.string().optional(),
    }),
  ),
  drafts: z.array(
    z.strictObject({
      /** Empty string when the recipient is unknown. */
      to: z.string().optional(),
      subject: z.string(),
      body: z.string(),
      reason: z.string().optional(),
    }),
  ),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type TaskItem = ExtractionResult["tasks"][number];
export type DraftItem = ExtractionResult["drafts"][number];

/**
 * Wire schema handed to LLM providers as the structured-output contract.
 * Identical to `ExtractionResultSchema` except every optional field is
 * required-but-nullable: OpenAI strict json_schema demands that all properties
 * appear in `required`. The normalization schema below removes those nulls in
 * the same validation pass before the pipeline trusts the payload.
 */
export const ExtractionWireSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string(),
  sourceFileName: z.string(),
  sourceUrl: z.string().nullable(),
  processedAt: z.string(),
  isTranscript: z.boolean(),
  skipReason: z.string().nullable(),
  summary: z.string(),
  tasks: z.array(
    z.strictObject({
      title: z.string(),
      owner: z.string().nullable(),
      due: z.string().nullable(),
      notes: z.string().nullable(),
      sourceQuote: z.string().nullable(),
    }),
  ),
  drafts: z.array(
    z.strictObject({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      reason: z.string().nullable(),
    }),
  ),
});

const NormalizedWireExtractionSchema = ExtractionWireSchema.transform((wire): ExtractionResult => ({
  ...wire,
  tasks: wire.tasks.map((task) => {
    const out: ExtractionResult["tasks"][number] = { title: task.title };
    for (const key of ["owner", "due", "notes", "sourceQuote"] as const) {
      if (task[key] !== null) {
        out[key] = task[key];
      }
    }
    return out;
  }),
  drafts: wire.drafts.map((draft) => {
    const out: ExtractionResult["drafts"][number] = {
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
    };
    if (draft.reason !== null) {
      out.reason = draft.reason;
    }
    return out;
  }),
}));

/**
 * The accepted reply variants, normalized as part of the one validation pass:
 * strict-provider wire values lose their null placeholders, while canonical
 * values (including hand-edited fixtures) pass through unchanged.
 */
export const NormalizedExtractionResultSchema = z.union([
  NormalizedWireExtractionSchema,
  ExtractionResultSchema,
]);

/* ==========================================================================
 * Transcript Catalog (ADR-0043, issue #125)
 *
 * Contracts for the Workspace-owned catalog that is the sole writer for
 * private transcript registration and processing. The owner reviews a
 * content-free folder inventory, grants one explicit folder-level consent,
 * and the catalog then registers one immutable normalized Transcript record
 * per source revision behind a checksummed, resumable ledger.
 * ========================================================================== */

/** The configured source folder the Catalog draws from. */
export interface TranscriptFolderRef {
  sourceSystem: "drive";
  folderId: string;
  folderName: string | null;
}

/** One folder file as the pre-consent inventory sees it: metadata only, never content. */
export interface TranscriptInventoryFile {
  externalFileId: string;
  fileName: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  /** Meeting date recovered from the file name, when it carries one. */
  meetingDate: string | null;
}

/** Policy facts the inventory must disclose before the owner consents. */
export interface TranscriptProviderExposure {
  sendsTranscriptTextToConfiguredModel: boolean;
  provider: string;
  model: string;
}

/**
 * First-run inventory preview: folder identity, file count, date range,
 * estimated scope, local retention, model/provider exposure and external-query
 * behavior — without mining any file's content.
 */
export interface TranscriptFolderInventory {
  folder: TranscriptFolderRef;
  fileCount: number;
  dateRange: { earliest: string | null; latest: string | null };
  estimatedScope: { totalBytes: number };
  localRetention: string;
  providerExposure: TranscriptProviderExposure;
  externalQueryBehavior: "none";
  files: TranscriptInventoryFile[];
}

/** Standing, folder-level authorization. Processing refuses without it. */
export interface TranscriptConsent {
  folderId: string;
  folderName: string | null;
  consentedAt: string;
}

/** The source facts one immutable Transcript was registered from. */
export interface TranscriptSourceRevision {
  sourceSystem: "drive";
  externalFileId: string;
  fileName: string;
  sourceUrl: string | null;
  /** sha256 of the raw source bytes. */
  checksum: string;
  /** 1-based per external file; a changed checksum is a new deliberate revision. */
  observedRevision: number;
  modifiedAt: string | null;
}

/** Calendar association, recorded only when it is known. */
export interface TranscriptOccurrence {
  occurrenceKey: string;
  calendarEventId: string | null;
}

/** Verified source metadata tying one diarized speaker label to stable
 * identity signals. Raw transcript text alone never verifies a handle or an
 * external contact identifier. */
export interface TranscriptSpeakerIdentityMapping {
  speakerLabel: string;
  calendarEmail: string | null;
  verifiedHandles: Record<string, string[]>;
  externalContactIds: ExternalContactId[];
}

/** Calendar roster evidence. A name-to-email roster bridge is review evidence,
 * not an exact stable identifier observed on a transcript span. */
export interface TranscriptRosterPerson {
  displayName: string | null;
  email: string;
}

/** Calendar association plus the verified identity facts Calendar/provider
 * metadata supplies for source speaker labels. */
export interface TranscriptOccurrenceAssociation {
  occurrence: TranscriptOccurrence;
  speakerIdentityMappings: TranscriptSpeakerIdentityMapping[];
  roster: TranscriptRosterPerson[];
}

/** One immutable normalized transcript per source revision. */
export interface TranscriptRecord {
  id: string;
  source: TranscriptSourceRevision;
  ingestedAt: string;
  extractorVersion: number;
  /** Immutable normalized UTF-8 text artifact. */
  normalizedText: string;
  meetingDate: string | null;
  occurrence: TranscriptOccurrence | null;
  /** Source-system speaker labels, in order of first appearance. */
  speakers: string[];
  /** Verified provider/Calendar identity metadata, when available. */
  speakerIdentityMappings: TranscriptSpeakerIdentityMapping[];
  /** Calendar roster persisted with the association for candidate context. */
  roster: TranscriptRosterPerson[];
  /**
   * The Meeting this Transcript belongs to (issue #153), or null until the
   * matching pass places it. Association metadata: the artifact stays
   * immutable while this is corrected by a better match.
   */
  meetingId: string | null;
}

export type TranscriptLedgerState = "pending" | "failed" | "skipped" | "processed";

/** Processing ledger: one entry per source revision, the exactly-once record. */
export interface TranscriptLedgerEntry {
  sourceSystem: "drive";
  externalFileId: string;
  fileName: string;
  observedRevision: number;
  checksum: string | null;
  state: TranscriptLedgerState;
  attempts: number;
  transcriptId: string | null;
  reason: string | null;
  updatedAt: string;
}

export interface TranscriptCatalogStatus {
  consent: TranscriptConsent | null;
  backfill: "idle" | "running" | "paused";
  pending: number;
  processed: number;
  failed: number;
  skipped: number;
  transcriptCount: number;
}

export interface TranscriptProcessingPass {
  /** Source revisions newly registered as immutable Transcript records. */
  processed: number;
  failed: number;
  skipped: number;
  /** Source revisions found already processed or deliberately skipped, untouched. */
  unchanged: number;
}

/* ==========================================================================
 * Transcript identity mining (ADR-0043, issue #126)
 *
 * Mentions, Organization Mentions, match candidates, Identity Decisions and
 * remembered mappings are Catalog-owned records: their persistence lives
 * outside Person Profiles (spec #117, Implementation Decision 7). A Mention
 * is evidence that a string occurred in context — never proof of identity —
 * and no mining path creates a Person Profile; only an explicit owner
 * decision does.
 * ========================================================================== */

export type IdentityDecisionAction =
  | "confirm"
  | "alternate-profile"
  | "create-profile"
  | "not-a-person"
  | "unresolved"
  | "remember-mapping";

export type IdentityDecisionOutcome = "linked" | "created" | "not-a-person" | "unresolved";

export type RememberedMappingScope = "transcript" | "workspace";

/** An explicit, scoped, versioned and reversible normalized-name mapping. */
export interface RememberedMapping {
  /** Unique immutable version record. */
  id: string;
  /** Stable identity shared by every version and its revocation record. */
  lineageId: string;
  supersedesMappingId: string | null;
  scope: RememberedMappingScope;
  scopeId: string | null;
  normalizedForm: string;
  surfaceText: string;
  profileId: string;
  mappingVersion: number;
  /** Timestamp for this immutable version record. */
  createdAt: string;
  /** Non-null only on the terminal revocation version. */
  revokedAt: string | null;
}

/** Entity classification for one preserved span. Never a guess at identity. */
export type TranscriptMentionKind =
  "person" | "organization" | "ambiguous-name" | "product" | "unknown";

export type TranscriptMentionConfidence = "high" | "medium" | "low";

/**
 * How the mentioned person relates to the meeting as observed: a source
 * speaker label, a name spoken inside another speaker's utterance
 * (attendee or not — the roster is not assumed), or a span with no speaker
 * context on its line.
 */
export type TranscriptAttendeeStatus = "speaker" | "third-person" | "unknown";

/** A model-observed relationship kept as reviewable transcript evidence. */
export const TranscriptRelationshipAssertionSchema = z.strictObject({
  subject: z.string().min(1),
  relationship: z.string().min(1),
  object: z.string().min(1),
});

export type TranscriptRelationshipAssertion = z.infer<typeof TranscriptRelationshipAssertionSchema>;

/** Where in which immutable Transcript the span was preserved from. */
export interface TranscriptMentionProvenance {
  transcriptId: string;
  /** Character offsets of the span inside the normalized transcript text. */
  spanStart: number;
  spanEnd: number;
  /** The span exactly as it occurs in the normalized text. */
  quote: string;
  /** Line timestamp, when the source line carried one. */
  timestamp: string | null;
  /** Speaker label of the line the span occurs on, when any. */
  speakerLabel: string | null;
  meetingDate: string | null;
}

export interface TranscriptMention {
  id: string;
  kind: TranscriptMentionKind;
  surfaceText: string;
  /**
   * Comparison forms derived per spec #117 (Extraction and normalization):
   * whitespace-, punctuation-, honorific- and credential-normalized
   * lowercase variants. Candidate matching compares these, never the raw
   * surface text.
   */
  normalizedForms: string[];
  /** Exact stable email identifiers observed on the span. */
  emails: string[];
  /** Canonicalized exact Profile URLs observed on the span. */
  profileUrls: string[];
  /** Handles verified by source speaker metadata, keyed by platform. */
  verifiedHandles: Record<string, string[]>;
  /** Provider-owned stable identifiers verified by source metadata. */
  externalContactIds: ExternalContactId[];
  /** Exact Calendar email tied to this source speaker label, when verified. */
  speakerCalendarEmail: string | null;
  /** Model-observed honorific/job titles retained as evidence, never copied
   * into a Profile without review. */
  titles: string[];
  /** Model-observed meeting/context roles retained as evidence. */
  roles: string[];
  /** Alternate names observed for this span. */
  aliases: string[];
  relationshipAssertions: TranscriptRelationshipAssertion[];
  /** Calendar attendees whose display name matches this observed mention or
   * one of its strict-extraction aliases. */
  rosterContext: TranscriptRosterPerson[];
  /** Normalized organization name when the person was named in org context. */
  organizationContext: string | null;
  attendeeStatus: TranscriptAttendeeStatus;
  confidence: TranscriptMentionConfidence;
  provenance: TranscriptMentionProvenance;
  minedAt: string;
  algorithmVersion: number;
}

/**
 * One preserved organization span and its normalized identifiers (spec #117).
 * It is shared evidence, not a Profile employer string and not a new
 * top-level resource — there is no Organization Profile in v1.
 */
export interface OrganizationMention {
  id: string;
  surfaceText: string;
  normalizedName: string;
  aliases: string[];
  /** Email domains observed for the organization in the transcript. */
  domains: string[];
  externalCompanyIds: { system: string; externalId: string }[];
  relationshipAssertions: TranscriptRelationshipAssertion[];
  /** Person-mention ids seen in organization context with this mention. */
  relatedMentionIds: string[];
  confidence: TranscriptMentionConfidence;
  provenance: TranscriptMentionProvenance;
  minedAt: string;
  algorithmVersion: number;
}

/** Spec #117 policy classes, minus "rejected": a non-person is a decision,
 *  not a Profile candidate, so no candidate record exists for one. */
export type TranscriptCandidatePolicyClass = "confirmed" | "probable" | "ambiguous";

/** One scored signal inside a candidate's explanation. */
export interface TranscriptCandidateSignal {
  signal:
    | "exact-email"
    | "exact-profile-url"
    | "verified-handle"
    | "external-contact-id"
    | "speaker-calendar-email"
    | "remembered-mapping"
    | "normalized-full-name"
    | "alias"
    | "title"
    | "role"
    | "roster-context"
    | "speaker-label"
    | "employer-hint";
  /** What was compared to what, in review-readable words. */
  explanation: string;
  matched: boolean;
  weight: number;
}

/** A conflict that blocks or weakens a candidate. */
export interface TranscriptCandidateConflict {
  kind:
    | "archived-profile"
    | "duplicate-stable-id"
    | "email-belongs-elsewhere"
    | "stable-id-belongs-elsewhere"
    | "name-email-mismatch"
    | "roster-email-belongs-elsewhere";
  explanation: string;
  /** Hard conflicts prevent auto-linking (spec #117 policy classes). */
  hard: boolean;
}

export interface TranscriptCandidateEvidence {
  quote: string;
  spanStart: number;
  spanEnd: number;
  timestamp: string | null;
  speakerLabel: string | null;
}

/**
 * One explainable Profile candidate: every signal that was considered (with
 * its outcome and weight), every conflict, the resulting score, the lead
 * over the next-best candidate, the evidence spans, and the algorithm
 * version that produced the judgment.
 */
export interface TranscriptMatchCandidate {
  id: string;
  mentionId: string;
  transcriptId: string;
  profileId: string;
  policyClass: TranscriptCandidatePolicyClass;
  score: number;
  /** This candidate's lead over the next-best; null when it is the only one. */
  leadOverNext: number | null;
  signals: TranscriptCandidateSignal[];
  conflicts: TranscriptCandidateConflict[];
  evidence: TranscriptCandidateEvidence[];
  algorithmVersion: number;
  generatedAt: string;
}

/**
 * The durable, auditable resolution of a Transcript Mention to a Profile, a
 * rejection, or an unresolved state (spec #117 vocabulary). Policy-made
 * decisions are auto-links from non-conflicting stable identifiers. Mapping
 * applications and review actions retain owner authority and audit lineage.
 */
export interface IdentityDecision {
  id: string;
  mentionId: string;
  transcriptId: string;
  action: IdentityDecisionAction;
  outcome: IdentityDecisionOutcome;
  profileId: string | null;
  profileRevision: number | null;
  decidedBy: "policy" | "owner";
  decidedAt: string;
  note: string | null;
  /**
   * The exact remembered mapping this decision stands on, or null when no
   * mapping is involved. It is the single place a mapping's authority is
   * stated: present means the decision is the mapping's application (or its
   * withdrawal), absent means the decision stands on its own.
   */
  mappingAuthority: RememberedMappingAuthority | null;
}

/** The exact immutable mapping version a decision was derived from. */
export interface RememberedMappingAuthority {
  lineageId: string;
  mappingId: string;
  mappingVersion: number;
}

/**
 * Whether the decision is derived rather than owner review authority. A policy
 * auto-link and a remembered-mapping application are both re-derivable from
 * current Profiles, conflicts and mapping authority, so identity rematching
 * recomputes them. An owner review decision carries neither mark and is never
 * recomputed — only repaired to follow a Profile merge or invalidation.
 */
export function isDerivedIdentityDecision(decision: IdentityDecision): boolean {
  return decision.decidedBy === "policy" || decision.mappingAuthority !== null;
}

export interface OrganizationMergeDecision {
  id: string;
  action: "merge";
  sourceOrganizationMentionId: string;
  targetOrganizationMentionId: string;
  decisionVersion: number;
  algorithmVersion: number;
  decidedBy: "owner";
  decidedAt: string;
  note: string | null;
  provenance: {
    source: TranscriptMentionProvenance;
    target: TranscriptMentionProvenance;
  };
}

/** One Review-queue row: a mention, its explainable candidates, its decision. */
export interface TranscriptReviewItem {
  transcriptId: string;
  transcriptFileName: string | null;
  meetingDate: string | null;
  mention: TranscriptMention;
  candidates: TranscriptMatchCandidate[];
  decision: IdentityDecision | null;
  /** A remembered mapping that produced or may replay this mention's link. */
  rememberedMapping: RememberedMapping | null;
}

/** Organization review stays scoped to identity review and meeting evidence. */
export interface OrganizationReviewItem {
  transcriptId: string;
  transcriptFileName: string | null;
  organization: OrganizationMention;
  relatedPeople: { mentionId: string; surfaceText: string }[];
  /** Latest append-only merge decision for this source Organization Mention. */
  mergeDecision: OrganizationMergeDecision | null;
}

export interface TranscriptReviewQueue {
  items: TranscriptReviewItem[];
  organizations: OrganizationReviewItem[];
}

/* ==========================================================================
 * Semantic transcript relevance (ADR-0043, issue #127)
 *
 * Full-corpus discovery is a reviewable evidence lane. Similarity is a
 * suggestion with a citation, never a fact: unconfirmed results stay out of
 * every factual consumer (Profile facts, Meeting Brief evidence, attendee
 * identity, recipient authority). Only an explicit owner confirmation makes
 * relevance auditable, as its own decision kind — never an identity decision,
 * and never a Profile write.
 * ========================================================================== */

/**
 * The meeting context a discovery query may carry (spec #117: meeting title,
 * purpose, attendees, organizations, and topics). Fields are advisory search
 * signals; whatever the query carried is recorded verbatim on each result.
 */
export interface RelevanceMeetingContext {
  title?: string | null;
  purpose?: string | null;
  attendees?: string[] | null;
  organizations?: string[] | null;
  topics?: string[] | null;
}

/** What was asked of the Transcript corpus. */
export interface TranscriptRelevanceQuery {
  text: string;
  meeting?: RelevanceMeetingContext | null;
}

/**
 * Review state of one semantic candidate: pending until an explicit owner
 * decision moves it. Rejected and unresolved stay non-factual, exactly like
 * pending.
 */
export type TranscriptRelevanceReviewState = "pending" | "confirmed" | "rejected" | "unresolved";

export type TranscriptRelevanceDecisionAction = "confirm" | "reject" | "unresolved";

/** One cited excerpt, located exactly inside the retained normalized text. */
export interface TranscriptRelevanceExcerpt {
  text: string;
  spanStart: number;
  spanEnd: number;
}

/**
 * One unlinked semantic result. Its id is deterministic over the query
 * context, the cited Transcript revision, and the excerpt span, so an index
 * rebuild re-derives the same candidate instead of duplicating review work.
 */
export interface TranscriptRelevanceCandidate {
  id: string;
  query: TranscriptRelevanceQuery;
  transcriptId: string;
  excerpt: TranscriptRelevanceExcerpt;
  score: number;
  explanation: string;
  /** The model or index version that produced this similarity judgment. */
  relevanceVersion: string;
  createdAt: string;
  /** Where this result was cited from, snapshotted at discovery. */
  sourceContext: TranscriptRelevanceSourceContext;
}

/**
 * The durable, auditable resolution of a semantic candidate. Stored apart
 * from IdentityDecision: relevance confirmation is its own decision kind and
 * never writes a Profile.
 */
export interface TranscriptRelevanceDecision {
  id: string;
  candidateId: string;
  transcriptId: string;
  action: TranscriptRelevanceDecisionAction;
  outcome: Exclude<TranscriptRelevanceReviewState, "pending">;
  decidedBy: "owner";
  decidedAt: string;
  note: string | null;
}

/** Source context one result was cited from, snapshotted at discovery. */
export interface TranscriptRelevanceSourceContext {
  fileName: string;
  meetingDate: string | null;
  sourceUrl: string | null;
}

/** One Review-surface row: the candidate, its current review state, its decision. */
export interface TranscriptRelevanceReviewItem {
  candidate: TranscriptRelevanceCandidate;
  decision: TranscriptRelevanceDecision | null;
  reviewState: TranscriptRelevanceReviewState;
}

/* ==========================================================================
 * Transcript deletion (ADR-0043, issue #128)
 *
 * Local deletion of one immutable Transcript record. It is local-only by
 * construction: the remote Drive source and every previously created provider
 * record (Gmail drafts, Tasks, Sheets) stay untouched, and the receipt says
 * so with a zero remote-operation count.
 * ========================================================================== */

/** The exact confirmation phrase transcript deletion requires (spec #117). */
export const TRANSCRIPT_DELETE_CONFIRMATION = "DELETE TRANSCRIPT";

/**
 * The content-free record a deleted Transcript leaves behind: source identity,
 * checksum, deletion time, and the do-not-reingest policy — and nothing else.
 * No file name, no participants, no text; it outlives the identity the deleted
 * document may still have named.
 */
export interface TranscriptDeletionTombstone {
  sourceSystem: "drive";
  externalFileId: string;
  checksum: string;
  deletedAt: string;
  policy: "do-not-reingest";
}

/** What one registered consumer of transcript-derived records will lose. */
export interface TranscriptConsumerDisclosure {
  consumer: string;
  label: string;
  recordCount: number;
}

export interface TranscriptDeletionRemovedCounts {
  /** The immutable normalized record itself. */
  transcriptRecords: number;
  identityMentions: number;
  organizationMentions: number;
  identityCandidates: number;
  identityDecisions: number;
  organizationMergeDecisions: number;
  /** Remembered mappings scoped to the deleted transcript; they can never
   *  apply again and carry its surface text. Workspace-scoped mappings are
   *  standing owner authority and survive. */
  transcriptRememberedMappings: number;
  extractionLedgerEntries: number;
  relevanceCandidates: number;
  relevanceDecisions: number;
  /** Records removed through registered consumer cascades. */
  consumerRecords: number;
}

/** The audited result of one transcript deletion. */
export interface TranscriptDeletionReceipt {
  receiptId: string;
  transcriptId: string;
  externalFileId: string;
  deletedAt: string;
  removed: TranscriptDeletionRemovedCounts;
  tombstone: TranscriptDeletionTombstone;
  remoteProviderOperations: number;
}

/** A retained transcript as the deletion surface lists it: metadata only. */
export interface TranscriptSummary {
  id: string;
  externalFileId: string;
  fileName: string;
  sourceUrl: string | null;
  meetingDate: string | null;
  ingestedAt: string;
}
