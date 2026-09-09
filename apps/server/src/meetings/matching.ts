import type {
  Meeting,
  TranscriptRecord,
  TranscriptRosterPerson,
} from "@chief-of-staff-demo/shared";
import { meetingFileNameMeta } from "../text/meetingFileName.js";

/**
 * How far from a Meeting's start a name timestamp or a file modification may
 * sit and still corroborate a match (issue #153). Stated policy, not a tuned
 * threshold: a transcript is usually written down within a day of the meeting.
 */
export const MEETING_MATCH_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * How far a file name's *stated time* may sit from a Meeting's start (issue:
 * recurring meetings never linked). A name that states a time is naming the
 * meeting's own start, not the day it was written down, so the day-wide window
 * above is the wrong instrument for it: a meeting held every weekday puts two
 * or three occurrences inside a day of any exact timestamp, and the rule that
 * refuses to pick a winner then refused every one of them. Two hours absorbs
 * an exporter naming the join rather than the invite, and half-hour timezone
 * offsets, without reaching the next day's occurrence of a daily meeting.
 */
export const MEETING_NAME_TIME_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/** What the Catalog needs to attach a Transcript to its Meeting. */
export interface MatchedMeeting {
  id: string;
  occurrenceKey: string | null;
  calendarEventId: string | null;
  /**
   * Who Calendar says was in the meeting, carried across with the association.
   * Without it a linked Transcript still had an empty roster, so its Debrief
   * asked the owner to type in attendees the Meeting beside it already knew.
   * Empty for a Meeting a Transcript owns: it has no Calendar attendees.
   */
  roster: TranscriptRosterPerson[];
}

/** The Calendar attendees of one Meeting, as the Catalog records them. */
export function rosterOf(meeting: Meeting): TranscriptRosterPerson[] {
  if (meeting.occurrenceKey === null) return [];
  return meeting.participants
    .filter((participant) => participant.email !== "")
    .map((participant) => ({
      displayName: participant.displayName ?? null,
      email: participant.email,
    }));
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleSignalsMatch(transcriptTitle: string, meetingTitle: string): boolean {
  const left = normalizeTitle(transcriptTitle);
  const right = normalizeTitle(meetingTitle);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  // Containment counts only above a floor, so "Q4" alone never links a meeting.
  return Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left));
}

function speakersMatch(transcript: TranscriptRecord, meeting: Meeting): boolean {
  const names = new Set(
    meeting.participants
      .map((participant) => (participant.displayName ?? "").toLowerCase().trim())
      .filter((name) => name !== ""),
  );
  return transcript.speakers.some((speaker) => names.has(speaker.toLowerCase().trim()));
}

function withinTolerance(
  at: string,
  startAt: string,
  toleranceMs: number = MEETING_MATCH_TOLERANCE_MS,
): boolean {
  const delta = Math.abs(Date.parse(at) - Date.parse(startAt));
  return Number.isFinite(delta) && delta <= toleranceMs;
}

/**
 * Which Meeting a Transcript belongs to (issue #153).
 *
 * The file name is the primary evidence: its title and, when present, its
 * timestamp. Speaker names and the file's modification time corroborate. The
 * rule is deliberately stated:
 *
 * - a name that carries neither title nor timestamp never produces a match;
 * - when the name carries a timestamp, that pins the window, and one
 *   corroborating signal (title, a speaker on the roster, or modification
 *   time) guards the guess;
 * - when the name carries only a title, that title plus one corroborating
 *   signal (a speaker on the roster, or modification time) is required —
 *   a title alone never links;
 * - zero qualifying meetings, or two, mean no match: ambiguity is not
 *   resolved by picking a winner.
 *
 * Calendar Meetings only. A Meeting a Transcript owns is the outcome of
 * failing to match, not a thing to match against: two Drive copies of one
 * meeting used to qualify each other's shell, so the second copy either
 * attached to the first's shell instead of Calendar, or made the count two and
 * killed the match outright. Placing a Transcript means finding its Calendar
 * occurrence.
 */
export function findMatchingMeeting(
  transcript: TranscriptRecord,
  meetings: Meeting[],
): MatchedMeeting | null {
  const meta = meetingFileNameMeta(transcript.source.fileName);
  if (meta.title === null && meta.timestamp === null) return null;

  const qualified = meetings.filter((meeting) => {
    if (meeting.occurrenceKey === null) return false;
    const titleMatch = meta.title !== null && titleSignalsMatch(meta.title, meeting.title);
    /* A name that states a time is pinned to the meeting's start; one that
       states only a date claims no more than the day it names. */
    const timeMatch =
      meta.timestamp !== null &&
      withinTolerance(
        meta.timestamp,
        meeting.startAt,
        meta.namesTime ? MEETING_NAME_TIME_TOLERANCE_MS : MEETING_MATCH_TOLERANCE_MS,
      );
    const speakers = speakersMatch(transcript, meeting);
    const modifiedAt = transcript.source.modifiedAt;
    const mtimeMatch = modifiedAt !== null && withinTolerance(modifiedAt, meeting.startAt);

    if (meta.timestamp !== null) {
      /* A name that states both a title and a time has said everything it
         knows, so a Meeting whose title disagrees is not a candidate: a
         "Found42 Stand-Up Meeting" transcript was qualifying against a
         different meeting ninety minutes away on a day-old file time, and the
         two qualifiers then cancelled each other out. A name with a time but
         no title still leans on the other corroborators. */
      if (meta.title !== null && meta.namesTime) return timeMatch && titleMatch;
      return timeMatch && (titleMatch || speakers || mtimeMatch);
    }
    return titleMatch && (speakers || mtimeMatch);
  });

  if (qualified.length !== 1) return null;
  const meeting = qualified[0]!;
  return {
    id: meeting.id,
    occurrenceKey: meeting.occurrenceKey,
    calendarEventId: meeting.calendarEventId,
    roster: rosterOf(meeting),
  };
}

/**
 * Nearest Meetings for a Transcript that owns its Meeting (issue #154), for
 * the merge UI. Same signals as the match, scored rather than gated: title
 * outweighs a shared speaker, which outweighs a nearby modification time.
 * Never suggests the Meeting the Transcript already sits on; at most five.
 */
export function findNearMatches(transcript: TranscriptRecord, meetings: Meeting[]): Meeting[] {
  return (
    meetings
      .filter((meeting) => meeting.id !== transcript.meetingId)
      /* Calendar Meetings only. Merging is defined as a transcript-owned
       Meeting joining a Calendar occurrence, so a candidate without one has
       nothing to merge into — offering it renders a button that cannot act. */
      .filter((meeting) => meeting.occurrenceKey !== null)
      .map((meeting) => ({ meeting, score: nearMatchScore(transcript, meeting) }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.meeting.startAt.localeCompare(right.meeting.startAt),
      )
      .slice(0, 5)
      .map((candidate) => candidate.meeting)
  );
}

/**
 * How far a merge candidate may sit from when the transcript says its meeting
 * happened. Wider than MEETING_MATCH_TOLERANCE_MS, because this is a
 * suggestion for a person to judge rather than an automatic match — but
 * bounded, because a shared attendee alone was offering next week's stand-up
 * as the home for a workshop three months ago.
 */
const NEAR_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** When the transcript says its meeting happened, best evidence first. */
function transcriptWhen(transcript: TranscriptRecord): string | null {
  const meta = meetingFileNameMeta(transcript.source.fileName);
  return meta.timestamp ?? transcript.meetingDate ?? transcript.source.modifiedAt;
}

function nearMatchScore(transcript: TranscriptRecord, meeting: Meeting): number {
  const meta = meetingFileNameMeta(transcript.source.fileName);
  /* Out of the window is out of the running: a candidate the owner would
     never pick is noise in a list they have to read. */
  const when = transcriptWhen(transcript);
  if (when !== null) {
    const delta = Math.abs(Date.parse(when) - Date.parse(meeting.startAt));
    if (!Number.isFinite(delta) || delta > NEAR_MATCH_WINDOW_MS) return 0;
  }
  let score = 0;
  if (meta.title !== null && titleSignalsMatch(meta.title, meeting.title)) score += 3;
  if (speakersMatch(transcript, meeting)) score += 2;
  const modifiedAt = transcript.source.modifiedAt;
  if (modifiedAt !== null && withinTolerance(modifiedAt, meeting.startAt)) score += 1;
  return score;
}
