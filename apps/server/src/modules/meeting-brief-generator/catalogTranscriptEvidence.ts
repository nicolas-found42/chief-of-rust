import type { TranscriptRecord, TranscriptRelevanceReviewState } from "@chief-of-staff-demo/shared";
import type { TranscriptRelevanceService } from "../../transcript-catalog/relevance.js";
import type {
  MeetingTranscriptEvidenceProvider,
  MeetingTranscriptEvidenceRequest,
  TranscriptEvidenceInput,
  TranscriptEvidenceVia,
} from "./transcriptEvidence.js";

/**
 * The Catalog-backed confirmed-transcript lane (issue #138).
 *
 * The two approved retrieval lanes are built here from what the Workspace
 * already holds. Confirmed links are structural — a Transcript is linked
 * because its roster or its Calendar series says so, never because a model
 * thought it looked relevant. Semantic discovery runs through the Catalog's
 * own relevance service, which grounds every excerpt in retained text and
 * carries the owner's review decision with it.
 */

/** The bound on a link excerpt, matching the relevance service's own bound. */
const MAX_LINK_EXCERPT_CHARS = 280;

/** The opening of the retained text, bounded. A link cites the Transcript it
 *  reached; it has no similarity span to point at. */
function linkExcerpt(record: TranscriptRecord): string {
  return record.normalizedText.trim().slice(0, MAX_LINK_EXCERPT_CHARS);
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Meeting relevance for a structural link: the share of this meeting's
 * attendees who were in that Transcript's roster. It is a count over recorded
 * fact, not a similarity judgment — a Transcript with everyone in the room is
 * more relevant to this meeting than one with a single overlapping name.
 */
function rosterOverlap(record: TranscriptRecord, attendees: string[]): number {
  if (attendees.length === 0) return 0;
  const roster = new Set(record.roster.map((person) => person.email.toLowerCase()));
  const present = attendees.filter((email) => roster.has(email)).length;
  return present / attendees.length;
}

export function catalogTranscriptEvidence(deps: {
  listTranscripts: () => TranscriptRecord[];
  relevance: TranscriptRelevanceService;
}): MeetingTranscriptEvidenceProvider {
  return {
    async collect(request: MeetingTranscriptEvidenceRequest): Promise<TranscriptEvidenceInput> {
      const attendees = request.attendees.map((email) => email.toLowerCase());
      const organizations = new Set(request.organizations.map((domain) => domain.toLowerCase()));
      const records = deps
        .listTranscripts()
        .filter((record) => record.normalizedText.trim().length > 0);

      /* One link per Transcript, at its strongest lane: a Transcript reached
         both through a person and through the series is person evidence. The
         order of these three checks is the strength order. */
      const links = records.flatMap((record) => {
        const roster = record.roster.map((person) => person.email.toLowerCase());
        const via: TranscriptEvidenceVia | null = roster.some((email) => attendees.includes(email))
          ? "person"
          : roster.some((email) => organizations.has(domainOf(email)))
            ? "organization"
            : record.occurrence?.calendarEventId === request.calendarEventId
              ? "meeting-series"
              : null;
        if (via === null) return [];
        return [
          {
            transcriptId: record.id,
            via,
            excerpt: linkExcerpt(record),
            relevance: rosterOverlap(record, attendees),
            meetingDate: record.meetingDate,
          },
        ];
      });

      /* Semantic discovery over the whole corpus, from the meeting context
         AC 2 names. Candidates come back grounded and bounded; the selector
         next door decides which — if any — the owner has confirmed. */
      const candidates = await deps.relevance.search({
        text: request.title,
        meeting: {
          title: request.title,
          attendees,
          organizations: [...organizations],
        },
      });
      const reviewState = new Map<string, TranscriptRelevanceReviewState>(
        deps.relevance.reviewQueue().map((item) => [item.candidate.id, item.reviewState]),
      );
      const linked = new Set(links.map((link) => link.transcriptId));
      const semantic = candidates
        /* A Transcript already reached by a confirmed link is evidence
           through that link; it must not also arrive as a suggestion the
           owner is asked to review a second time. */
        .filter((candidate) => !linked.has(candidate.transcriptId))
        .map((candidate) => ({
          transcriptId: candidate.transcriptId,
          excerpt: candidate.excerpt.text,
          score: candidate.score,
          meetingDate: candidate.sourceContext.meetingDate,
          reviewState: reviewState.get(candidate.id) ?? "pending",
        }));

      return { links, semantic };
    },
  };
}
