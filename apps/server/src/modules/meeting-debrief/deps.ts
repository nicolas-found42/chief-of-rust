import type {
  IdentityDecision,
  OrganizationMention,
  TranscriptMention,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";

/**
 * What the Debrief consumes from the Transcript Catalog (issue #139): the
 * immutable record of the mined Transcript — its normalized text, its Calendar
 * association, its roster. The Catalog is the sole writer and the only source;
 * the Debrief never polls Drive and never converts a source of its own.
 */
export interface DebriefCatalogReader {
  getTranscript(transcriptId: string): TranscriptRecord | null;
}

/**
 * The Catalog's identity review state for one Transcript — consumed here,
 * owned by the Catalog's identity mining (spec #117, ADR-0043). The Debrief
 * reads mentions, their latest decisions, and the Organization Mentions; it
 * decides none of them.
 */
export interface DebriefIdentityReview {
  mentions: TranscriptMention[];
  /** Latest decision per mention, as the Catalog holds it. */
  decisions: IdentityDecision[];
  organizations: OrganizationMention[];
}

export interface DebriefIdentityReviewReader {
  reviewFor(transcriptId: string): DebriefIdentityReview;
}

/** Everything one extraction sees. */
export interface DebriefExtractInput {
  record: TranscriptRecord;
  identity: DebriefIdentityReview;
}

/**
 * One outward-facing Gmail draft, as the Debrief hands it over. The addresses
 * are already decided by the approval — the outward surface receives
 * recipients, never a roster to interpret.
 */
export interface DebriefDraft {
  to: string[];
  subject: string;
  body: string;
}

/**
 * The Debrief's only outward-write capability (issue #141). Terminal approval
 * is the sole transition that reaches it. Left absent — as in the
 * extraction-only harness #139 shipped — approval still completes and no
 * outward write is structurally possible, so that property stays a wiring
 * decision rather than a promise in prose.
 */

/**
 * The Debrief's outward surface. One draft, and nothing else: publication is
 * email-only (issue #182), and accepted work is a canonical Task promoted one
 * decision at a time rather than a bulk write the Debrief performs (#199).
 */
export interface DebriefOutputsDeps {
  /** Creates exactly one draft and returns the provider's id for the receipt. */
  createDraft(draft: DebriefDraft): Promise<string>;
}
