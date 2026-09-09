export type PersonProfileMatchConfidence = "high" | "medium" | "low";
export const PERSON_PROFILE_SOURCE_ID = "person-profile" as const;
export type PersonEvidenceKind =
  "identity" | "employment" | "social-profile" | "website" | "feed" | "publication" | "mention";
export const PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION = 1 as const;
export const PERSON_PROFILE_MEETING_PROJECTION_VERSION = 1 as const;
export type PersonProfileProjectionPurpose = "public-safe" | "meeting";

export interface PersonIdentitySignals {
  emails: string[];
  fullNames: string[];
  handles: Record<string, string[]>;
  profileUrls: string[];
  employerHints: string[];
}

export interface PersonEvidenceClaims {
  fullName?: string;
  role?: string;
  background?: string;
  currentEmployer?: string;
}

export interface PersonEvidenceCandidate {
  source: string;
  kind: PersonEvidenceKind;
  title: string;
  summary: string;
  url: string;
  publishedAt?: string;
  identitySignals: PersonIdentitySignals;
  claims: PersonEvidenceClaims;
}

export interface PersonEvidence extends PersonEvidenceCandidate {
  id: string;
  matchConfidence: PersonProfileMatchConfidence;
  matchedSignals: string[];
  observedAt: string;
}

/**
 * The evidence-source convention for transcript-origin Person Evidence
 * (issue #128): the evidence's `source` names the Transcript Catalog and its
 * `url` carries the transcript id it was observed in. The future producer
 * lane and the transcript-deletion cascade share this one definition, so
 * what the cascade purges is exactly what producers write.
 */
export const TRANSCRIPT_EVIDENCE_SOURCE = "transcript-catalog";

export function isTranscriptOriginEvidence(
  evidence: Pick<PersonEvidence, "source" | "url">,
  transcriptId: string,
): boolean {
  return evidence.source === TRANSCRIPT_EVIDENCE_SOURCE && evidence.url === transcriptId;
}

export interface PersonProfileSourceDiagnostic {
  source: string;
  status: "completed" | "empty" | "failed" | "unconfigured";
  detail: string;
}

export interface PersonSocialProfile {
  platform: string;
  handle: string | null;
  url: string;
}

/** A provider-owned stable contact key, namespaced by its source system. */
export interface ExternalContactId {
  system: string;
  externalId: string;
}

export interface PersonPublishingFeed {
  url: string;
  title: string | null;
}

/** What explicit manual creation records: identity inputs plus optional known facts. */
export interface PersonProfileCreateInput {
  profileUrls?: string[];
  fullName?: string;
  primaryEmail?: string;
  role?: string;
  background?: string;
  currentEmployer?: string;
}

export interface PersonProfile {
  researchFacts?: Partial<
    Record<
      "fullName" | "role" | "currentEmployer" | "background",
      { value: string; sourceIds: string[]; effectiveFrom: string | null }
    >
  >;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  fullName: string | null;
  primaryEmail: string | null;
  emails: string[];
  handles: Record<string, string[]>;
  profileUrls: string[];
  externalContactIds?: ExternalContactId[];
  employerHints: string[];
  role: string | null;
  background: string | null;
  currentEmployer: string | null;
  socialProfiles: PersonSocialProfile[];
  websites: string[];
  feeds: PersonPublishingFeed[];
  publications: PersonEvidence[];
  mentions: PersonEvidence[];
  evidence: PersonEvidence[];
  sourceDiagnostics: PersonProfileSourceDiagnostic[];
  /** Reversible lifecycle state: archive is ticket #122's operation, the state is the resource's. */
  archivedAt: string | null;
  /**
   * Identity repair (ticket #121): set when this Profile was merged away. Its
   * revisions remain readable audit records; current identity lives under the
   * surviving Profile, so consumers follow this id instead.
   */
  mergedInto?: string;
  /** Append-only repair record: one entry per invalidation this Profile filed. */
  invalidations?: PersonProfileInvalidation[];
}

// ---------------------------------------------------------------------------
// Profile lifecycle (ticket #122): dependencies, residual sources, and purge.
// ---------------------------------------------------------------------------

export type PersonProfileDependentConfigurationAction = "pause" | "repoint";

/** A consumer-owned configuration that must be resolved before archive. */
export interface PersonProfileDependentConfiguration {
  id: string;
  consumer: string;
  label: string;
  profileId: string;
  state: "active" | "paused";
  availableActions: PersonProfileDependentConfigurationAction[];
}

/**
 * Immutable source material that privacy deletion deliberately does not
 * rewrite. The disclosure is a reference — which document, of what kind,
 * separately deletable or not — and never copies the document's title or text,
 * because the receipt outlives the identity the document may still name.
 * Source deletion, where supported, is a separate operation.
 */
export interface PersonProfileResidualSourceArtifact {
  artifactId: string;
  kind: "transcript" | "public-source";
  separateDeleteSupported: boolean;
}

export interface PersonProfileLifecycleState {
  profileId: string;
  profileRevision: number;
  archivedAt: string | null;
  dependentConfigurations: PersonProfileDependentConfiguration[];
  residualSourceArtifacts: PersonProfileResidualSourceArtifact[];
}

export const PERSON_PROFILE_PRIVACY_DELETE_CONFIRMATION = "DELETE PROFILE" as const;

export interface PersonProfileDeletionCounts {
  canonicalProfileRecords: number;
  revisions: number;
  evidence: number;
  aliases: number;
  candidates: number;
  mappings: number;
  decisions: number;
  activeLinks: number;
  personSnapshots: number;
}

/** Minimal referential marker: no name, email, claim, evidence, or source text. */
export interface PersonProfileTombstone {
  profileId: string;
  deletedAt: string;
}

/**
 * The body of a refused lifecycle operation. A refusal is a disclosure: it
 * carries the same lifecycle state the confirmation surface reads, so the
 * operator can see what still points here and what would outlive the Profile
 * without having to go and ask a second endpoint.
 */
export interface PersonProfileLifecycleRefusal {
  error: "active-dependencies" | "privacy-confirmation-required";
  message: string;
  lifecycle: PersonProfileLifecycleState;
}

/** Audited local result; `remoteProviderOperations` is always zero. */
export interface PersonProfileDeletionReceipt {
  receiptId: string;
  profileId: string;
  deletedAt: string;
  removed: PersonProfileDeletionCounts;
  tombstone: PersonProfileTombstone;
  residualSourceArtifacts: PersonProfileResidualSourceArtifact[];
  remoteProviderOperations: 0;
}

/**
 * What a privacy-deleted Profile's route answers with. The tombstone keeps the
 * reference resolvable and the receipt says what the deletion accounted for;
 * neither names the person.
 */
export interface PersonProfilePrivacyDeleted {
  error: "profile-privacy-deleted";
  message: string;
  tombstone: PersonProfileTombstone;
  receipt: PersonProfileDeletionReceipt | null;
}

/**
 * One evidence record reduced to what a consumer may see for its purpose: the
 * provenance (which source, which URL) and the match confidence survive; the
 * raw identity signals and claims around them stay behind the interface.
 */
export interface PersonProjectedEvidence {
  id: string;
  source: string;
  kind: PersonEvidenceKind;
  title: string;
  summary: string;
  url: string;
  publishedAt?: string;
  matchConfidence: PersonProfileMatchConfidence;
  observedAt: string;
}

export interface PersonProfileProjectionBase {
  profileId: string;
  profileRevision: number;
  fullName: string | null;
  role: string | null;
  background: string | null;
  currentEmployer: string | null;
  socialProfiles: PersonSocialProfile[];
  websites: string[];
  feeds: PersonPublishingFeed[];
  /**
   * Present when the projected revision has since been invalidated (ticket
   * #121): the repair records filed against it, read from the Profile's
   * current record. A current projection of a healthy Profile omits it.
   */
  invalidations?: PersonProfileInvalidation[];
}
/**
 * What a content-creation consumer may hold (spec #117): public facts and
 * publishing surfaces only. Private email, CRM/contact records, search
 * diagnostics, and mention evidence are outside its authority.
 */
export interface PersonProfilePublicSafeProjection extends PersonProfileProjectionBase {
  purpose: "public-safe";
  projectionVersion: typeof PERSON_PROFILE_PUBLIC_SAFE_PROJECTION_VERSION;
  publications: PersonProjectedEvidence[];
}

/**
 * What a meeting consumer may hold: contact and evidence for preparation.
 * Enrichment plumbing (source diagnostics, signal bookkeeping) is outside its
 * authority — the owner reads diagnostics on the Profile detail surface.
 */
export interface PersonProfileMeetingProjection extends PersonProfileProjectionBase {
  purpose: "meeting";
  projectionVersion: typeof PERSON_PROFILE_MEETING_PROJECTION_VERSION;
  primaryEmail: string | null;
  emails: string[];
  publications: PersonProjectedEvidence[];
  mentions: PersonProjectedEvidence[];
  evidence: PersonProjectedEvidence[];
}

export type PersonProfileProjection =
  PersonProfilePublicSafeProjection | PersonProfileMeetingProjection;

// ---------------------------------------------------------------------------
// Calendar attendee shells (issue #124; spec #117 creation and matching policy)
// ---------------------------------------------------------------------------

/**
 * The only source id Calendar may claim on a Profile: the provenance entry that
 * marks a shell as created from an exact Calendar attendee email.
 */
export const PERSON_PROFILE_CALENDAR_SOURCE = "calendar" as const;

/**
 * What the Calendar attendee path may pass to the shared interface. The exact
 * Calendar email is the authoritative anchor: it may reuse a non-conflicting
 * Profile or create one minimal email-anchored shell, but Calendar never
 * supplies inferred employer, title, biography, or public-search claims, so
 * nothing else is recorded.
 */
export interface PersonProfileCalendarAttendeeInput {
  /** Exact attendee email from Calendar; matched and anchored case-insensitively. */
  email: string;
  /** Stable Calendar context (occurrence/event identity) recorded as the shell's source provenance. */
  provenance?: string;
}

/** Reuse-or-create result: consumers pin `profile.id` and `profile.revision`. */
export interface PersonProfileCalendarAttendeeResult {
  profile: PersonProfile;
  /** False when an existing Profile was reused instead of created. */
  created: boolean;
}

/* ---------------------------------------------------------------------------
 * Owner onboarding (issue #123). The connected Google identity proposes the
 * Workspace owner's canonical Profile; only an explicit owner confirmation
 * pins the reference below. These types serve the onboarding namespace and
 * the /api/onboarding routes, not the Profile store itself.
 * ------------------------------------------------------------------------- */

/** What onboarding shows before any confirmation: the connected identity and
 * any existing Profile its exact email already anchors. Never a confirmation. */
export interface OwnerOnboardingProposal {
  googleEmail: string;
  matchedProfileId: string | null;
  matchedProfileRevision: number | null;
}

/** The owner reference workflows gate on: an exact Profile revision, held for
 * one Google identity. Changing or disconnecting that identity voids it. */
export interface ConfirmedOwnerReference {
  profileId: string;
  profileRevision: number;
  confirmedAt: string;
  confirmedForGoogleEmail: string;
}

// ---------------------------------------------------------------------------
// Identity repair (ticket #121): factual correction, merge, and detach/split.
// Repair operations append revisions; these types carry the audited decisions
// and the invalidation marks consumers read to refresh what they hold.
// ---------------------------------------------------------------------------

/** The repair decisions that supersede past facts or attributions. */
export type PersonProfileRepairKind = "correction" | "merge" | "evidence-detached";
export const PERSON_PROFILE_REPAIR_FACT_KEYS = [
  "fullName",
  "primaryEmail",
  "role",
  "currentEmployer",
  "background",
] as const;
export type PersonProfileRepairFactKey = (typeof PERSON_PROFILE_REPAIR_FACT_KEYS)[number];

/**
 * One audited repair decision, filed on the Profile it invalidates. Records
 * are append-only: a record never edits history, it marks every affected
 * historical revision so consumers refresh what they hold from it.
 */
export interface PersonProfileInvalidation {
  id: string;
  kind: PersonProfileRepairKind;
  /** The revision whose then-current facts this record invalidates. */
  affectedRevision: number;
  /** Every historical revision a consumer may still hold from before this decision. */
  affectedRevisions?: number[];
  occurredAt: string;
  /** The decision in the owner's words, or a generated audit line. */
  detail: string;
  /** kind "merge", filed on the merged-away Profile: the surviving Profile id. */
  mergedInto?: string;
  /** kind "merge", filed on the surviving Profile: the merged-away Profile id. */
  mergedFrom?: string;
  /** kind "evidence-detached": the evidence record that was detached. */
  evidenceId?: string;
  /** kind "evidence-detached": where the evidence was re-attributed, when it moved. */
  movedTo?: string;
  /** kind "evidence-detached": where the evidence was wrongly attributed before. */
  movedFrom?: string;
}

/** One compatibility rule for legacy single-revision and current multi-revision records. */
export function invalidationAffectsRevision(
  record: Pick<PersonProfileInvalidation, "affectedRevision" | "affectedRevisions">,
  revision: number,
): boolean {
  return (
    record.affectedRevision === revision || record.affectedRevisions?.includes(revision) === true
  );
}

/** Current read-time state of one consumer's exact pinned Profile revision. */
export interface PersonProfileConsumerState {
  profileId: string;
  profileRevision: number;
  currentProfileId: string;
  currentProfileRevision: number;
  refreshRequired: boolean;
  invalidations: PersonProfileInvalidation[];
}

/** What the owner corrects on an ordinary factual repair; omitted facts are unchanged. */
export interface PersonProfileCorrectionInput {
  fullName?: string;
  /** `null` explicitly removes a false canonical email and current identity signal. */
  primaryEmail?: string | null;
  /** `null` explicitly removes a false fact; omission leaves it unchanged. */
  role?: string | null;
  /** `null` explicitly removes a false fact; omission leaves it unchanged. */
  currentEmployer?: string | null;
  /** `null` explicitly removes a false fact; omission leaves it unchanged. */
  background?: string | null;
  /**
   * The person's profile URLs, replacing the current set; `null` or `[]` clears
   * them. Handles are re-derived from the URLs, so correcting these is how a
   * Profile gains the Identity Signals that let public evidence match at high
   * confidence instead of on a name alone.
   */
  profileUrls?: string[] | null;
  /** Audit note recorded with the correction decision. */
  note?: string;
}

/**
 * A merge decision: `duplicateId` is merged away into the surviving Profile.
 * Facts that both Profiles state differently must be resolved explicitly.
 */
export interface PersonProfileMergeInput {
  duplicateId: string;
  /** Chosen values for conflicting facts, keyed by fact name. */
  resolutions?: Partial<Record<PersonProfileRepairFactKey, string>>;
  /** Audit note recorded with the merge decision. */
  note?: string;
}

/** A detach/split decision: one evidence record leaves the Profile it was attributed to. */
export interface PersonProfileDetachInput {
  evidenceId: string;
  /** When set, the evidence is re-attributed to this Profile (a split). */
  toProfileId?: string;
  /** Audit note recorded with the detach decision. */
  note?: string;
}
