import type {
  MeetingDebriefApprovalBlocker,
  MeetingDebriefExtraction,
  MeetingDebriefField,
  MeetingDebriefReviewState,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";

export function serializeReviewState(state: MeetingDebriefReviewState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseReviewState(raw: string | null): MeetingDebriefReviewState | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as MeetingDebriefReviewState;
    /* Records written before done/dismiss split (issue #158) carry no local
       done list — backfill it so every reader sees both persisted states. */
    if (!Array.isArray(parsed.review.completedActionItems)) {
      parsed.review.completedActionItems = [];
    }
    if (!Array.isArray(parsed.review.droppedActionItems)) {
      parsed.review.droppedActionItems = [];
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The review state a freshly extracted Run waits with: the Calendar-prefilled
 * roster, if any, unconfirmed; no recipients, no drops, no pending request.
 */
export function initialReviewState(
  runId: string,
  record: TranscriptRecord,
): MeetingDebriefReviewState {
  return {
    version: 1,
    runId,
    roster: {
      status: "unconfirmed",
      confirmedAt: null,
      entries: record.roster.map((person) => ({
        email: person.email,
        displayName: person.displayName ?? null,
        profileId: null,
        profileRevision: null,
      })),
    },
    recipients: { additional: [] },
    review: { droppedActionItems: [], completedActionItems: [] },
    request: null,
    approval: null,
  };
}

/**
 * Whole-field regeneration (ADR-0037): only the regenerated field comes from
 * the fresh extraction; every other field keeps its current value, so review
 * decisions on untouched fields survive. The fresh extraction is built from
 * the immutable input alone — the replaced value is structurally unreachable.
 */
export function mergeRegeneratedField(
  current: MeetingDebriefExtraction,
  field: MeetingDebriefField,
  fresh: MeetingDebriefExtraction,
): MeetingDebriefExtraction {
  return { ...current, [field]: fresh[field] };
}

/**
 * The approval gate's collaborators (spec #450): the confirmed owner
 * identity, and the Calendar-verified Profile holding an exact email. One
 * interface, two adapters — the host route refuses synchronously with it, the
 * Module's review Stage re-asserts durably with the same function.
 */
export interface DebriefApprovalGateDeps {
  /** The confirmed owner identity's email, or null while unconfirmed. */
  ownerEmail(): string | null;
  /** The one current Profile whose verified identity holds this exact email, or null. */
  verifiedForEmail(email: string): { profileId: string; profileRevision: number } | null;
}

/**
 * Why approval is blocked right now. Approval requires the confirmed owner
 * identity (so attendees can be told apart from the owner), a confirmed
 * roster, and every non-owner attendee bound to a Profile with a verified
 * email. Confirmed attendees other than the owner need no separate recipient
 * decision — they are automatic.
 */
export function approvalBlockers(
  state: MeetingDebriefReviewState,
  gate: DebriefApprovalGateDeps,
): MeetingDebriefApprovalBlocker[] {
  const blockers: MeetingDebriefApprovalBlocker[] = [];
  const ownerEmail = gate.ownerEmail();
  if (ownerEmail === null) blockers.push("owner-identity-unconfirmed");
  if (state.roster.status !== "confirmed") blockers.push("roster-unconfirmed");
  for (const entry of state.roster.entries) {
    if (ownerEmail !== null && entry.email === ownerEmail) continue;
    if (entry.profileId === null || gate.verifiedForEmail(entry.email) === null) {
      blockers.push(`attendee-unverified-email:${entry.email}`);
    }
  }
  return blockers;
}
