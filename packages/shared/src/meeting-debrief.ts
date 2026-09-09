/** Meeting Debrief — Module-owned types (issues #139/#140, spec #117, ADR-0037/0038). */

import { z } from "zod/v3";

export const MEETING_DEBRIEF_MODULE_ID = "meeting-debrief" as const;
export const MEETING_DEBRIEF_MODULE_VERSION = 2 as const;

/**
 * Fixed Stages for this Module. `review` is the durable owner wait and
 * `regenerate` the audited re-extraction Stage (issue #140, ADR-0037/0038);
 * the approval-gated outward writes (`draft`, `tasks`) come in the next
 * slice, so nothing outward is written before approval.
 */
export const MEETING_DEBRIEF_STAGES = ["associate", "extract", "review", "regenerate"] as const;
export type MeetingDebriefStage = (typeof MEETING_DEBRIEF_STAGES)[number];

/** The Intake every Debrief Run starts from: the Transcript Catalog's mining. */
export const MEETING_DEBRIEF_INTAKE = "transcript-catalog" as const;

/** How the Run's association stands: Calendar prefill, or manual confirmation. */
export type MeetingDebriefRosterStatus = "prefilled" | "requires_confirmation";

/** Whether the Debrief is ready for the owner's review. */
/**
 * How a Debrief stands for the one thing that still needs the owner: the
 * outward writes. Nothing gates reading or using a Debrief any more, so this
 * describes publishing readiness only — `needs_roster` means the attendee
 * list is not settled enough to address a draft to, not that the Debrief is
 * unfinished.
 */
export type MeetingDebriefReviewReadiness = "ready" | "needs_roster" | "no_extraction";

/**
 * Unreviewed Runs expire to `skipped` this many days after the review wait
 * started (ADR-0038). A number of policy, fixed in version 1 of the review
 * slice and unconfigured, like the four-hour Brief lead time.
 */
export const MEETING_DEBRIEF_REVIEW_EXPIRY_DAYS = 30 as const;

/** Why the Run ended when its review window elapsed. */
export const MEETING_DEBRIEF_EXPIRED_REASON = "debrief_expired_unreviewed" as const;

/** One whole field the review may regenerate (ADR-0037: regenerated, never edited). */
export const MEETING_DEBRIEF_FIELDS = [
  "summary",
  "decisions",
  "actionItems",
  "openQuestions",
  "effectivenessEvidence",
  "coachingAdvice",
] as const;
export type MeetingDebriefField = (typeof MEETING_DEBRIEF_FIELDS)[number];

/**
 * One confirmed roster entry. The owner is resolved live against the
 * confirmed owner identity, never stored — it can change between reviews.
 */
export interface MeetingDebriefRosterEntry {
  email: string;
  displayName: string | null;
  /** The Profile this attendee was bound to at roster confirmation; null while unbound. */
  profileId: string | null;
  profileRevision: number | null;
}

/** One non-attendee recipient: an explicit confirmed Profile selection with a verified email. */
export interface MeetingDebriefRecipient {
  profileId: string;
  profileRevision: number;
  email: string;
}

/** Why the review surface cannot approve yet. Stable codes the UI renders. */
export type MeetingDebriefApprovalBlocker =
  "owner-identity-unconfirmed" | "roster-unconfirmed" | `attendee-unverified-email:${string}`;

/**
 * The Module-owned review state of one Debrief Run (issue #140), stored as
 * the Run's `review.json`. The Run is the log; this record is the review's
 * durable state, and approval locks every field of it.
 */
export interface MeetingDebriefReviewState {
  version: 1;
  runId: string;
  roster: {
    status: "unconfirmed" | "confirmed";
    confirmedAt: string | null;
    entries: MeetingDebriefRosterEntry[];
  };
  recipients: {
    additional: MeetingDebriefRecipient[];
  };
  review: {
    /** Action-item indexes the owner dismissed. Never become Google Tasks (issue #158). */
    droppedActionItems: number[];
    /** Action-item indexes the owner marked done. Local until a Google Task exists (issue #158). */
    completedActionItems: number[];
  };
  /** The pending owner action the Run resumes for; null while it simply waits. */
  request: { kind: "regenerate"; field: MeetingDebriefField } | { kind: "approve" } | null;
  /** Set once by approval; terminal for every review mutation afterwards. */
  approval: { approvedAt: string } | null;
}

/** The review half of the Debrief detail journey's payload. */
export interface MeetingDebriefReviewView {
  /**
   * `published` once the Gmail draft has been created; `extracted` before
   * that. A Debrief is never "awaiting review" — it finishes when it is
   * extracted — and never expires.
   */
  state: "extracted" | "published";
  approvedAt: string | null;
  /**
   * The Gmail draft this Debrief created, or null when none exists (issue
   * #182). A draft, never a sent message: `url` opens it in Gmail for the
   * owner to finish and send themselves.
   */
  draft: { draftId: string; url: string; recipientCount: number } | null;
  roster: {
    status: "unconfirmed" | "confirmed";
    confirmedAt: string | null;
    entries: MeetingDebriefRosterEntry[];
  };
  /** Derived: confirmed attendees other than the owner, each bound to a Profile. */
  automaticRecipients: MeetingDebriefRecipient[];
  /** Explicit non-attendee recipients, each an explicit confirmed Profile selection. */
  additionalRecipients: MeetingDebriefRecipient[];
  /** What the extraction suggested from follow-up context; each needs explicit confirmation. */
  suggestedRecipients: Array<{ name: string; email: string | null }>;
  /** Why approval is blocked right now; empty when ready. */
  approvalBlockers: MeetingDebriefApprovalBlocker[];
  /** Set when this Run re-extracts a transcript that already has an approved Debrief. */
  duplicateWarning: { approvedRunId: string } | null;
}

/** One decision the meeting produced, with the transcript evidence for it. */
export interface MeetingDebriefDecision {
  statement: string;
  /** Transcript quote the decision stands on; null when none was preserved. */
  evidence: string | null;
}

/**
 * One action item with an inferred owner. The owner is a surface name the
 * extraction inferred — never an identity guess. `ownerProfileId` is filled
 * only when the Catalog's identity review state already links the mention the
 * extraction named; ambiguity stays ambiguous.
 */
export interface MeetingDebriefActionItem {
  title: string;
  owner: string | null;
  /** The Catalog mention the owner refers to, when the extraction identified one. */
  ownerMentionId: string | null;
  /** Resolved by the Debrief from Catalog review state — never guessed. */
  ownerProfileId: string | null;
  /** Optional due date as an ISO date; null when none was stated. */
  dueDate: string | null;
}

export interface MeetingDebriefOpenQuestion {
  question: string;
  /** Who raised it, as a surface name; null when unclear. */
  raisedBy: string | null;
}

/** The complete structured retrospective of one meeting. */
export interface MeetingDebriefExtraction {
  version: 1;
  summary: string;
  decisions: MeetingDebriefDecision[];
  actionItems: MeetingDebriefActionItem[];
  openQuestions: MeetingDebriefOpenQuestion[];
  /** Evidence the meeting worked or did not — stays in Meeting Wizard. */
  effectivenessEvidence: string;
  /** Coaching advice for the workspace owner — stays in Meeting Wizard. */
  coachingAdvice: string;
  /**
   * Non-attendee people follow-up context implies should receive the
   * retrospective. A suggestion is never a recipient: the review surface
   * confirms each explicitly against a Profile with a verified email.
   */
  suggestedRecipients: Array<{ name: string; email: string | null }>;
}

/**
 * Strict model Result Shape (ADR-0029/0030): every adapter response is
 * validated here before it is used. There is no field for a Gmail draft, a
 * Task, or any other outward write — the extraction cannot carry one.
 */
export const MeetingDebriefExtractionSchema = z.strictObject({
  version: z.literal(1),
  summary: z.string().min(1),
  decisions: z.array(
    z.strictObject({
      statement: z.string().min(1),
      evidence: z.string().min(1).nullable(),
    }),
  ),
  actionItems: z.array(
    z.strictObject({
      title: z.string().min(1),
      owner: z.string().min(1).nullable(),
      ownerMentionId: z.string().min(1).nullable(),
      /** The model leaves this null; the Debrief resolves it from Catalog review state. */
      ownerProfileId: z.string().min(1).nullable(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
    }),
  ),
  openQuestions: z.array(
    z.strictObject({
      question: z.string().min(1),
      raisedBy: z.string().min(1).nullable(),
    }),
  ),
  effectivenessEvidence: z.string(),
  coachingAdvice: z.string(),
  suggestedRecipients: z.array(
    z.strictObject({
      name: z.string().min(1),
      /** Only an address stated in the transcript; never invented. */
      email: z.string().min(1).nullable(),
    }),
  ),
});

/** What one finished Debrief Run holds in its `result.json`. */
export interface MeetingDebriefRunResult {
  version: 1;
  transcriptId: string;
  extractedAt: string;
  debrief: MeetingDebriefExtraction;
}

/** Identity review state consumed for one transcript, as the Catalog holds it. */
export interface MeetingDebriefIdentitySummary {
  /** Mentions whose Catalog review decision links or creates a Profile. */
  resolved: Array<{ mentionId: string; surfaceText: string; profileId: string }>;
  /** Mentions still unresolved or ambiguous — shown as review state, never guessed. */
  unresolved: Array<{ mentionId: string; surfaceText: string }>;
  /** Organization mentions observed in the transcript. */
  organizations: Array<{ mentionId: string; surfaceText: string }>;
}

/** One row of the Debrief list in Meeting Wizard. */
export interface MeetingDebriefIndexEntry {
  runId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to (issue #153); null until placed. */
  meetingId: string | null;
  status: "pending" | "running" | "blocked" | "done" | "failed" | "skipped";
  summary: string | null;
  meetingDate: string | null;
  fileName: string | null;
  /** Whether the transcript is Calendar-linked (occurrence association known). */
  linked: boolean;
  occurrenceKey: string | null;
  rosterStatus: MeetingDebriefRosterStatus;
  rosterSize: number;
  identity: { resolvedCount: number; unresolvedCount: number; organizationCount: number };
  reviewReadiness: MeetingDebriefReviewReadiness;
  /** The Run's review state; null before the review record exists. */
  reviewState: "published" | null;
  rosterConfirmed: boolean;
  recipientCount: number;
}

export interface MeetingDebriefIndex {
  entries: MeetingDebriefIndexEntry[];
}

/** The Debrief detail journey's payload: extraction, roster, identity, readiness. */
export interface MeetingDebriefDetail {
  runId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to (issue #153); null until placed. */
  meetingId: string | null;
  status: MeetingDebriefIndexEntry["status"];
  summary: string | null;
  skipReason: string | null;
  meetingDate: string | null;
  fileName: string | null;
  sourceUrl: string | null;
  linked: boolean;
  occurrence: { occurrenceKey: string; calendarEventId: string | null } | null;
  roster: Array<{ displayName: string | null; email: string }>;
  speakers: string[];
  rosterStatus: MeetingDebriefRosterStatus;
  identity: MeetingDebriefIdentitySummary;
  extraction: MeetingDebriefExtraction | null;
  reviewReadiness: MeetingDebriefReviewReadiness;
  /** The review workflow's view; null before the Run holds a review record. */
  review: MeetingDebriefReviewView | null;
}
