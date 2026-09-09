import type { Meeting, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { meetingFileNameMeta } from "../text/meetingFileName.js";
import { findMatchingMeeting, findNearMatches, rosterOf, type MatchedMeeting } from "./matching.js";
import { resolveMeetingTitle, type MeetingTitleCleanerDeps } from "./title.js";
import type { WorkspaceMeetings } from "./store.js";

/**
 * The Workspace Meeting join (issue #165, ADR-0050).
 *
 * One deep module owning match-plus-attach-plus-merge behind a single
 * interface. Callers never sequence Meeting file reads around it: every
 * method re-reads the Meetings and the Transcripts it needs, so the standing
 * pass, the single attach, and the orphan merge cannot go stale on each
 * other. The pure scorers stay in matching.ts as the internal seam; the
 * Catalog remains the sole write path for the Transcript side, reached
 * through the injected attach.
 *
 * The Meeting holds occurrence facts, participants, and person-supplied
 * state only, never Run state.
 */
export type MeetingJoinErrorCode =
  | "meeting-not-found"
  | "merge-source-has-occurrence"
  | "target-occurrence-key-required"
  | "target-meeting-not-found"
  | "unknown-transcript";

export class MeetingJoinError extends Error {
  readonly code: MeetingJoinErrorCode;

  constructor(code: MeetingJoinErrorCode) {
    super(code);
    this.name = "MeetingJoinError";
    this.code = code;
  }
}

export interface MeetingJoinDeps {
  meetings: WorkspaceMeetings;
  listTranscripts: () => TranscriptRecord[];
  attachMeeting: (transcriptId: string, matched: MatchedMeeting) => Promise<unknown>;
  /** Naming for transcript-owned Meetings; deterministic when absent. */
  title?: MeetingTitleCleanerDeps;
  log?: (message: string) => void;
}

export class WorkspaceMeetingJoin {
  constructor(private readonly deps: MeetingJoinDeps) {}

  /**
   * The standing pass joining the Transcript Catalog to the Workspace's
   * Meetings. It places every catalogued Transcript, not only newly ingested
   * ones. A Transcript nothing matches owns its Meeting instead, keyed on the
   * Transcript id so a re-run returns the same record.
   *
   * A Transcript on a Calendar Meeting is settled and never re-matched: that
   * placement is either a confident match or a person's own merge. One sitting
   * on a Meeting it owns is not settled — it is what happens when no Calendar
   * occurrence could be found — so it is offered to the match again. Calendar
   * arrives late (the backward history read is one reconcile behind the first
   * join, and an occurrence can be created after its own transcript), and
   * without this those Transcripts stayed on their shells for good.
   */
  async associateTranscripts(): Promise<{ linked: number }> {
    let linked = 0;
    const meetings = [...this.deps.meetings.list()];
    for (const transcript of this.deps.listTranscripts()) {
      const held = transcript.meetingId ? this.deps.meetings.get(transcript.meetingId) : null;
      if (held !== null && held.occurrenceKey !== null) {
        /* Settled, so never re-matched — but still brought up to date. An
           earlier build wrote the occurrence and nothing else, leaving linked
           Transcripts with an empty roster and their Debriefs asking for
           attendees the Meeting already held. */
        await this.carryRosterAcross(transcript, held);
        continue;
      }
      const meeting = findMatchingMeeting(transcript, meetings);
      if (meeting !== null) {
        await this.attachRecord(transcript, meeting);
        /* The shell it came off is forgotten once nothing is left on it, the
           same way a merge forgets one — otherwise the Meeting Wizard lists an
           empty duplicate of the meeting the Transcript just joined. */
        if (held !== null) this.forgetEmptyShell(held.id);
        linked += 1;
        this.deps.log?.(`transcript ${transcript.id} matched Meeting ${meeting.id}`);
        continue;
      }
      if (held !== null) continue;
      /* Every catalogued Transcript earns a Meeting. A meeting that only a
         transcript attests to still happened, and the Meeting Wizard is where
         the workspace looks for it — so an unparseable file name names the
         Meeting badly rather than withholding it. */
      const meta = meetingFileNameMeta(transcript.source.fileName);
      const created = this.deps.meetings.createFromTranscript({
        transcriptId: transcript.id,
        title: await resolveMeetingTitle(transcript, this.deps.title ?? {}),
        speakers: transcript.speakers,
        modifiedAt: transcript.source.modifiedAt,
        meetingDate: transcript.meetingDate,
        nameTimestamp: meta.timestamp,
      });
      meetings.push(created);
      await this.attachRecord(transcript, {
        id: created.id,
        occurrenceKey: created.occurrenceKey,
        calendarEventId: created.calendarEventId,
        roster: rosterOf(created),
      });
      linked += 1;
      this.deps.log?.(`transcript ${transcript.id} created Meeting ${created.id}`);
    }
    return { linked };
  }

  /**
   * Give a settled Transcript the Calendar attendees its Meeting holds, when
   * the association was written without them. Idempotent: a Transcript that
   * already has a roster, or a Meeting with no attendees to give, writes
   * nothing.
   */
  private async carryRosterAcross(transcript: TranscriptRecord, held: Meeting): Promise<void> {
    if (transcript.roster.length > 0) return;
    const roster = rosterOf(held);
    if (roster.length === 0) return;
    await this.deps.attachMeeting(transcript.id, {
      id: held.id,
      occurrenceKey: held.occurrenceKey,
      calendarEventId: held.calendarEventId,
      roster,
    });
    this.deps.log?.(`transcript ${transcript.id} took the roster of Meeting ${held.id}`);
  }

  /**
   * Forget a transcript-owned Meeting that no Transcript sits on any more.
   * Calendar Meetings are never removed here — only the shell a Transcript
   * owned before it found its occurrence.
   */
  private forgetEmptyShell(meetingId: string): void {
    const shell = this.deps.meetings.get(meetingId);
    if (!shell || shell.occurrenceKey !== null) return;
    if (this.transcriptsForMeeting(meetingId).length > 0) return;
    this.deps.meetings.remove(meetingId);
    this.deps.log?.(`forgot empty transcript Meeting ${meetingId}`);
  }

  /**
   * Attach one Transcript to its Meeting. Idempotent: a Transcript already
   * carrying this Meeting is left alone and reports no write.
   */
  async attachTranscript(
    transcriptId: string,
    matched: MatchedMeeting,
  ): Promise<{ attached: boolean }> {
    const record = this.deps.listTranscripts().find((candidate) => candidate.id === transcriptId);
    if (!record) throw new MeetingJoinError("unknown-transcript");
    return this.attachRecord(record, matched);
  }

  /** The catalogued Transcripts of one Meeting, for its page. */
  transcriptsForMeeting(meetingId: string): { id: string; title: string }[] {
    return this.deps
      .listTranscripts()
      .filter((transcript) => transcript.meetingId === meetingId)
      .map((transcript) => ({ id: transcript.id, title: transcript.source.fileName }));
  }

  /**
   * Nearest Meetings for a Transcript that owns its Meeting, for the merge
   * UI. Never suggests the Meeting the Transcript already sits on.
   */
  nearMatchesFor(meetingId: string): Meeting[] {
    const meeting = this.deps.meetings.get(meetingId);
    if (!meeting) throw new MeetingJoinError("meeting-not-found");
    const transcript =
      this.deps.listTranscripts().find((candidate) => candidate.meetingId === meetingId) ?? null;
    if (!transcript) return [];
    const candidates = this.deps.meetings.list().filter((candidate) => candidate.id !== meeting.id);
    return findNearMatches(transcript, candidates);
  }

  /**
   * Carry a transcript-owned Meeting's Transcripts across to the Calendar
   * Meeting they belong to, then forget the transcript-owned shell, so
   * exactly one Meeting remains. The source must be transcript-owned: a
   * Calendar Meeting is never deleted by a merge. The shell is removed only
   * after every Transcript has carried across, so a failed merge deletes no
   * Meeting data.
   */
  async mergeTranscriptShell(
    sourceMeetingId: string,
    targetOccurrenceKey: string,
  ): Promise<Meeting> {
    const source = this.deps.meetings.get(sourceMeetingId);
    if (!source) throw new MeetingJoinError("meeting-not-found");
    if (source.occurrenceKey !== null) throw new MeetingJoinError("merge-source-has-occurrence");
    if (targetOccurrenceKey === "") throw new MeetingJoinError("target-occurrence-key-required");
    const target = this.deps.meetings.findByOccurrenceKey(targetOccurrenceKey);
    if (!target) throw new MeetingJoinError("target-meeting-not-found");
    const matched: MatchedMeeting = {
      id: target.id,
      occurrenceKey: target.occurrenceKey,
      calendarEventId: target.calendarEventId,
      roster: rosterOf(target),
    };
    for (const transcript of this.transcriptsForMeeting(source.id)) {
      await this.attachTranscript(transcript.id, matched);
    }
    this.deps.meetings.remove(source.id);
    return this.deps.meetings.get(target.id) ?? target;
  }

  private async attachRecord(
    transcript: TranscriptRecord,
    matched: MatchedMeeting,
  ): Promise<{ attached: boolean }> {
    if (transcript.meetingId === matched.id) return { attached: false };
    await this.deps.attachMeeting(transcript.id, matched);
    return { attached: true };
  }
}
