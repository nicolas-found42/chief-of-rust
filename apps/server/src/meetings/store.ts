import { notifyWorkspaceChange } from "../engine/workspace-changes.js";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Meeting, MeetingIndex, MeetingParticipant } from "@chief-of-staff-demo/shared";
import { atomicWriteJson } from "../engine/atomic.js";

/**
 * A date-only `YYYY-MM-DD` anchored at midday UTC, so the calendar day it
 * names survives rendering in any offset from UTC-11 to UTC+11. Anything that
 * already carries a time is returned untouched; null passes through.
 */
function middayUtc(date: string | null | undefined): string | null {
  if (!date) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : date;
}

/**
 * Chronological order. Calendar writes an offset (`…T09:00:00-04:00`) and a
 * transcript-owned Meeting writes UTC (`…T12:00:00.000Z`), so comparing the
 * strings sorts `09:00:00-04:00` (13:00Z) before `12:00:00.000Z` — text order,
 * not time order. Compare the instants; an unparseable start sorts last rather
 * than scrambling the ones around it.
 */
function compareByStart(a: Meeting, b: Meeting): number {
  const left = Date.parse(a.startAt);
  const right = Date.parse(b.startAt);
  if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
  if (Number.isNaN(right)) return -1;
  return left - right;
}

/**
 * The Workspace's Meetings (ADR-0050).
 *
 * A Workspace resource beside Person Profiles and the Transcript Catalog, not
 * a Module's feature store: the Meeting Brief Generator and the Executive
 * Assistant both consume it, and neither owns it.
 *
 * Like the calendar store beside it, this holds nothing in memory. Every call
 * re-reads the file and writes the whole list back atomically, so a Calendar
 * reconcile and a later Transcript association cannot lose each other's
 * writes.
 */
export class WorkspaceMeetings {
  private readonly dirPath: string;
  private readonly filePath: string;
  private readonly historyPath: string;

  constructor(
    workspaceDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dirPath = join(workspaceDir, "meetings");
    this.filePath = join(this.dirPath, "meetings.json");
    this.historyPath = join(this.dirPath, "history.json");
  }

  list(): Meeting[] {
    return this.read().sort(compareByStart);
  }

  index(): MeetingIndex {
    const meetings = this.list();
    return { meetings, historyBeginsAt: meetings[0]?.startAt ?? null };
  }

  get(id: string): Meeting | null {
    return this.read().find((meeting) => meeting.id === id) ?? null;
  }

  findByOccurrenceKey(occurrenceKey: string): Meeting | null {
    return this.read().find((meeting) => meeting.occurrenceKey === occurrenceKey) ?? null;
  }

  /** The one-time mark that Calendar history has been collected (issue #152). */
  historyMark(): MeetingHistoryMark | null {
    return readMarkFile(this.historyPath);
  }

  writeHistoryMark(mark: MeetingHistoryMark): void {
    mkdirSync(this.dirPath, { recursive: true });
    atomicWriteJson(this.historyPath, mark);
  }

  /**
   * Record what Calendar currently says about one occurrence. Keyed on the
   * occurrence key so a re-sync updates rather than duplicates, and so the
   * Meeting's own id survives every revision of the event behind it.
   */
  upsertFromCalendar(input: {
    occurrenceKey: string;
    calendarEventId: string;
    occurrenceId: string;
    title: string;
    startAt: string;
    endAt: string;
    participants: MeetingParticipant[];
    cancelled: boolean;
    ineligibleReason: Meeting["ineligibleReason"];
  }): Meeting {
    const meetings = this.read();
    const at = this.now().toISOString();
    const existing = meetings.find((meeting) => meeting.occurrenceKey === input.occurrenceKey);
    const meeting: Meeting = {
      id: existing?.id ?? newMeetingId(this.now()),
      occurrenceKey: input.occurrenceKey,
      calendarEventId: input.calendarEventId,
      occurrenceId: input.occurrenceId,
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      participants: input.participants,
      cancelled: input.cancelled,
      ineligibleReason: input.ineligibleReason,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const next = existing
      ? meetings.map((current) => (current.id === meeting.id ? meeting : current))
      : [...meetings, meeting];
    atomicWriteJson(this.filePath, next);
    notifyWorkspaceChange(join(this.dirPath, ".."));
    return meeting;
  }

  /**
   * Record a Meeting attested only by a Transcript (issue #154). Calendar
   * keys stay null until a merge carries the Transcript across to a Calendar
   * Meeting. The id derives from the Transcript id, so re-running the
   * association pass returns the same record instead of duplicating it.
   */
  createFromTranscript(input: {
    transcriptId: string;
    title: string;
    speakers: string[];
    modifiedAt: string | null;
    meetingDate?: string | null;
    /** The full timestamp the transcript's file name carries, when it has one. */
    nameTimestamp?: string | null;
  }): Meeting {
    const meetings = this.read();
    const id = transcriptMeetingId(input.transcriptId);
    const existing = meetings.find((meeting) => meeting.id === id);
    if (existing) return existing;
    const at = this.now().toISOString();
    /* When the meeting happened, best evidence first. `modifiedAt` is when
       Drive last touched the file — copying a June transcript into the folder
       in August dated the Meeting August — so it is the last resort, not the
       first. A date-only `meetingDate` is anchored at midday UTC: every offset
       from UTC-11 to UTC+11 then renders the calendar day the name states,
       where midnight would show the day before across the Americas. */
    const startAt = input.nameTimestamp ?? middayUtc(input.meetingDate) ?? input.modifiedAt ?? at;
    const participants = participantsFromSpeakers(input.speakers);
    const meeting: Meeting = {
      id,
      occurrenceKey: null,
      calendarEventId: null,
      occurrenceId: null,
      title: input.title,
      startAt,
      endAt: startAt,
      participants,
      cancelled: false,
      ineligibleReason: participants.length >= 2 ? null : "no_other_attendee",
      createdAt: at,
      updatedAt: at,
    };
    atomicWriteJson(this.filePath, [...meetings, meeting]);
    notifyWorkspaceChange(join(this.dirPath, ".."));
    return meeting;
  }

  /**
   * Forget a Meeting by id (issue #154: merging a transcript-owned Meeting
   * into its Calendar Meeting). Returns false when nothing carried the id.
   */
  remove(id: string): boolean {
    const meetings = this.read();
    const next = meetings.filter((meeting) => meeting.id !== id);
    if (next.length === meetings.length) return false;
    atomicWriteJson(this.filePath, next);
    notifyWorkspaceChange(join(this.dirPath, ".."));
    return true;
  }

  private read(): Meeting[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isMeeting) : [];
    } catch {
      return [];
    }
  }
}

/** Deterministic id for a Transcript-owned Meeting, keyed on the Transcript (issue #154). */
function transcriptMeetingId(transcriptId: string): string {
  return `meeting_transcript_${transcriptId}`;
}

/**
 * Speaker labels as the Meeting record keeps them: people only, no mailbox
 * facts a Transcript never supplies. Two distinct voices make the Meeting
 * eligible; a lone label does not evidence another attendee.
 */
function participantsFromSpeakers(speakers: string[]): MeetingParticipant[] {
  const seen = new Set<string>();
  const participants: MeetingParticipant[] = [];
  for (const speaker of speakers) {
    const displayName = speaker.trim();
    if (displayName === "") continue;
    const key = displayName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    participants.push({
      email: "",
      displayName,
      responseStatus: "needsAction",
      organizer: false,
      self: false,
    });
  }
  return participants;
}

/** The one-time mark that the backward Calendar read has run (issue #152). */
export interface MeetingHistoryMark {
  /** When the read ran. */
  collectedAt: string;
  /** The oldest Transcript date the read reached back to. */
  from: string;
}

function readMarkFile(path: string): MeetingHistoryMark | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const mark = parsed as Partial<MeetingHistoryMark>;
    return typeof mark.collectedAt === "string" && typeof mark.from === "string"
      ? { collectedAt: mark.collectedAt, from: mark.from }
      : null;
  } catch {
    return null;
  }
}

function newMeetingId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `meeting_${stamp}_${randomBytes(4).toString("hex")}`;
}

function isMeeting(value: unknown): value is Meeting {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.startAt === "string" &&
    typeof candidate.endAt === "string" &&
    Array.isArray(candidate.participants)
  );
}
