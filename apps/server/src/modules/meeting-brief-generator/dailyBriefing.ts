import { DateTime } from "luxon";
import {
  MEETING_BRIEF_MODULE_ID,
  type DailyBriefing,
  type DailyBriefingBriefStatus,
  type DailyBriefingWork,
  type MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceMeetings } from "../../meetings/store.js";
import type { Runs } from "../../runs.js";
import { NO_BRIEFING_WORK } from "../../tasks/briefing-projection.js";

/**
 * The Daily Briefing read model (issue #160): the day ahead, derived on read
 * from the day's Meetings and their Meeting Briefs (ADR-0005). Pure
 * derivation — no Run is started and nothing is persisted here. The host owns
 * the morning schedule and the error state; this file only computes.
 */

export interface DailyBriefingDeps {
  meetings: WorkspaceMeetings;
  runs: Runs;
  /**
   * The day's canonical Tasks and pending Action Items (issue #192), as the
   * bounded projection the Tasks product hands over. Absent when no Tasks
   * product is composed, and then the Briefing is meetings alone.
   */
  work?: () => DailyBriefingWork;
}

/** The owner-timezone calendar day covering `now`: day id and UTC bounds. */
export function dayBoundsFor(
  now: Date,
  timezone: string,
): { date: string; startMs: number; endMs: number } {
  let local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  if (!local.isValid) local = DateTime.fromJSDate(now, { zone: "utc" });
  const start = local.startOf("day");
  const end = start.plus({ days: 1 });
  return {
    date: start.toISODate() ?? start.toUTC().toISODate() ?? "unknown",
    startMs: start.toMillis(),
    endMs: end.toMillis(),
  };
}

/**
 * The day's Daily Briefing, or null when the day holds neither Meetings nor
 * work. Reads the Workspace's Meetings for the owner-timezone day plus the
 * Brief Runs index for their Brief state, and the Tasks product's own
 * projection of overdue, due-today, high-priority Tasks and pending review
 * (issue #192). Throws only when the underlying stores throw; the host turns
 * that into the surfaced error state.
 */
export function buildDailyBriefing(
  deps: DailyBriefingDeps,
  now: Date,
  timezone: string,
): DailyBriefing | null {
  const { date, startMs, endMs } = dayBoundsFor(now, timezone);
  const todays = deps.meetings
    .list()
    .filter((meeting) => {
      if (meeting.cancelled) return false;
      const startMsOf = Date.parse(meeting.startAt);
      return !Number.isNaN(startMsOf) && startMsOf >= startMs && startMsOf < endMs;
    })
    /* By the instant, not the text: Calendar writes an offset and a
       transcript-owned Meeting writes UTC, so the strings do not sort. */
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const work = deps.work?.() ?? NO_BRIEFING_WORK;
  const hasWork =
    work.totals.overdue +
      work.totals.dueToday +
      work.totals.highPriority +
      work.totals.pendingActionItems >
    0;
  /* A day with no Meetings can still be a day with work. Only a day with
     neither is nothing to say — and that is the one that stays null. */
  if (todays.length === 0 && !hasWork) return null;

  const doneKeys = new Set<string>();
  const activeKeys = new Set<string>();
  /* A preparation that ran and produced nothing — failed outright, or ended
     `done` with no Brief on it. The owner can retry those, so they must not
     read as never having been asked for. */
  const failedKeys = new Set<string>();
  for (const summary of deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs) {
    const meta = deps.runs.open(summary.id)?.read();
    const key = meta?.externalId;
    if (!key) continue;
    if (meta.status === "done") {
      const result = deps.runs.detail(summary.id)?.result as MeetingBriefRunResult | null;
      if (result?.meetingBrief) doneKeys.add(key);
      else failedKeys.add(key);
    } else if (
      meta.status === "pending" ||
      meta.status === "running" ||
      meta.status === "blocked"
    ) {
      activeKeys.add(key);
    } else if (meta.status === "failed") {
      failedKeys.add(key);
    }
  }

  const meetings = todays.map((meeting) => {
    /* Best outcome wins: a Brief that succeeded after an earlier failure is
       ready, and one still preparing outranks the attempt it supersedes. */
    let briefStatus: DailyBriefingBriefStatus = "missing";
    if (meeting.occurrenceKey) {
      if (doneKeys.has(meeting.occurrenceKey)) briefStatus = "ready";
      else if (activeKeys.has(meeting.occurrenceKey)) briefStatus = "pending";
      else if (failedKeys.has(meeting.occurrenceKey)) briefStatus = "failed";
    }
    return {
      meetingId: meeting.id,
      title: meeting.title,
      startAt: meeting.startAt,
      briefStatus,
    };
  });
  const ready = meetings.filter((entry) => entry.briefStatus === "ready").length;
  /* Named in the summary, not just per row: a failure the owner has to act on
     should be visible without reading the list. */
  const failed = meetings.filter((entry) => entry.briefStatus === "failed").length;
  const noun = meetings.length === 1 ? "Meeting" : "Meetings";
  return {
    date,
    meetings,
    summary:
      `${meetings.length} ${noun} today · ` +
      `${ready} ${ready === 1 ? "Brief" : "Briefs"} ready` +
      (failed > 0 ? ` · ${failed} failed` : "") +
      (work.totals.overdue > 0 ? ` · ${work.totals.overdue} overdue` : "") +
      (work.totals.pendingActionItems > 0
        ? ` · ${work.totals.pendingActionItems} awaiting review`
        : ""),
    work,
  };
}
