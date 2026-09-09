import type { TranscriptRelevanceReviewState } from "@chief-of-staff-demo/shared";

/**
 * Transcript evidence for a Meeting Brief (issue #138).
 *
 * There are two approved retrieval lanes and they are not equal. A confirmed
 * person, organization, or meeting-series link makes a Transcript evidence the
 * Brief may compose and cite as fact. A similarity judgment makes it a
 * suggestion, and it stays one until the owner confirms it — the rule #127
 * established inside the Catalog, applied here at the Brief's seam so a
 * similarity score can never buy its way into a talking point.
 */

/** Why a Transcript is already evidence rather than a suggestion. */
export type TranscriptEvidenceVia = "person" | "organization" | "meeting-series";

/** A Transcript reached through a confirmed link the Workspace already holds. */
interface ConfirmedTranscriptLink {
  transcriptId: string;
  via: TranscriptEvidenceVia;
  excerpt: string;
  /** How relevant this excerpt is to the meeting being briefed. */
  relevance: number;
  meetingDate: string | null;
}

/** A Transcript reached by similarity, carrying the Catalog's review state. */
interface SemanticTranscriptCandidate {
  transcriptId: string;
  excerpt: string;
  score: number;
  meetingDate: string | null;
  reviewState: TranscriptRelevanceReviewState;
}

/** One cited excerpt composition may state as fact. */
interface TranscriptEvidenceItem {
  transcriptId: string;
  via: TranscriptEvidenceVia | "confirmed-relevance" | "relevance";
  excerpt: string;
  meetingDate: string | null;
}

/** One unconfirmed similarity result, shown for review and never composed. */
interface TranscriptEvidenceSuggestion {
  transcriptId: string;
  excerpt: string;
  score: number;
}

export interface TranscriptEvidenceSelection {
  evidence: TranscriptEvidenceItem[];
  suggestions: TranscriptEvidenceSuggestion[];
}

export interface TranscriptEvidenceInput {
  links: ConfirmedTranscriptLink[];
  semantic: SemanticTranscriptCandidate[];
}

/** The enrichment section id this lane contributes, and its provider id. */
export const TRANSCRIPT_EVIDENCE_SOURCE_ID = "confirmed-transcripts";

/**
 * The Brief's read into the Transcript Catalog. It is meeting-level, not
 * attendee-level: the organization and meeting-series lanes are properties of
 * the occurrence rather than of any one guest, so the Brief asks once.
 */
export interface MeetingTranscriptEvidenceRequest {
  occurrenceKey: string;
  /** The series identity: recurring occurrences share one Calendar event id. */
  calendarEventId: string;
  title: string;
  attendees: string[];
  /** Attendee domains, the organization lane's key. */
  organizations: string[];
}

export interface MeetingTranscriptEvidenceProvider {
  collect(request: MeetingTranscriptEvidenceRequest): Promise<TranscriptEvidenceInput>;
}

/**
 * How many cited excerpts composition may receive. The set is bounded so a
 * large corpus cannot flood a Brief; the ranking below decides which survive.
 */
const DEFAULT_TRANSCRIPT_EVIDENCE_LIMIT = 6;

/**
 * Relationship strength, the first ranking key. A direct person link is the
 * strongest claim the Workspace holds, then the organization, then the
 * standing meeting series, then similarity the owner confirmed, and last
 * similarity nobody has ruled on. Undecided similarity is citable — a review
 * queue nobody works is not a safety property, it is evidence withheld — but
 * it ranks below every lane the Workspace can vouch for, so it only ever
 * fills space the stronger lanes left.
 */
const RELATIONSHIP_STRENGTH: Record<TranscriptEvidenceItem["via"], number> = {
  person: 4,
  organization: 3,
  "meeting-series": 2,
  "confirmed-relevance": 1,
  relevance: 0,
};

/** One citable excerpt with the two ranking keys that outrank neither lane. */
interface RankedEvidence {
  item: TranscriptEvidenceItem;
  relevance: number;
}

/**
 * Split the two lanes into what may be cited and what may not.
 *
 * Everything the owner has not rejected is citable. Confirmation used to be
 * required, which meant every similarity result waited on a review queue that
 * nothing in the product ever presented — so the lane was, in practice, always
 * empty. A rejection is still honoured: that is an owner decision, not an
 * absent one.
 *
 * Citable evidence is then ranked by relationship strength, then meeting
 * relevance, then recency, and cut to `limit`. The keys are applied in
 * priority order rather than blended into one score, so a strong relationship
 * is never outbid by a high similarity number.
 */
export function selectTranscriptEvidence(
  input: TranscriptEvidenceInput,
  options?: { limit?: number },
): TranscriptEvidenceSelection {
  const ranked: RankedEvidence[] = input.links.map((link) => ({
    item: {
      transcriptId: link.transcriptId,
      via: link.via,
      excerpt: link.excerpt,
      meetingDate: link.meetingDate,
    },
    relevance: link.relevance,
  }));
  const suggestions: TranscriptEvidenceSuggestion[] = [];
  for (const candidate of input.semantic) {
    if (candidate.reviewState === "rejected") continue;
    ranked.push({
      item: {
        transcriptId: candidate.transcriptId,
        via: candidate.reviewState === "confirmed" ? "confirmed-relevance" : "relevance",
        excerpt: candidate.excerpt,
        meetingDate: candidate.meetingDate,
      },
      relevance: candidate.score,
    });
    /* Still listed as a suggestion while undecided, so the owner can confirm
       or reject it — it is simply cited in the meantime rather than withheld. */
    if (candidate.reviewState === "pending") {
      suggestions.push({
        transcriptId: candidate.transcriptId,
        excerpt: candidate.excerpt,
        score: candidate.score,
      });
    }
  }

  /* A missing meeting date sorts last rather than first: an undated
     Transcript is not evidence that something happened recently. The
     transcriptId tiebreak keeps the set stable across runs. */
  ranked.sort(
    (left, right) =>
      RELATIONSHIP_STRENGTH[right.item.via] - RELATIONSHIP_STRENGTH[left.item.via] ||
      right.relevance - left.relevance ||
      (right.item.meetingDate ?? "").localeCompare(left.item.meetingDate ?? "") ||
      left.item.transcriptId.localeCompare(right.item.transcriptId),
  );

  const limit = options?.limit ?? DEFAULT_TRANSCRIPT_EVIDENCE_LIMIT;
  return { evidence: ranked.slice(0, limit).map((entry) => entry.item), suggestions };
}
