import { DateTime } from "luxon";
import {
  MEETING_BRIEF_MODULE_ID,
  type DailyBriefingBriefStatus,
  type MeetingBriefRunResult,
  type WeeklyBriefing,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceMeetings } from "../../meetings/store.js";
import type { Runs } from "../../runs.js";
import { dayBoundsFor } from "./dailyBriefing.js";
import { isInternalDomain } from "./eligibility.js";
import { sweepWindowFor } from "./intake.js";

/**
 * The Weekly Briefing read model (issue #161): the week ahead, derived on read
 * from the coming week's Meetings and their Meeting Briefs (ADR-0005) — the
 * Briefs the Sunday sweep prepares. Pure derivation — no Run is started and
 * nothing is persisted here. The host owns the Monday schedule and the error
 * state; this file only computes.
 */

export interface WeeklyBriefingDeps {
  meetings: WorkspaceMeetings;
  runs: Runs;
}

/** The owner-timezone sweep week covering `now`: Sunday start id and UTC bounds. */
export function weekBoundsFor(
  now: Date,
  timezone: string,
): { weekStart: string; startMs: number; endMs: number } {
  const { windowStart, windowEnd } = sweepWindowFor(now, timezone);
  let local = DateTime.fromJSDate(windowStart, { zone: "utc" }).setZone(timezone);
  if (!local.isValid) local = DateTime.fromJSDate(windowStart, { zone: "utc" });
  return {
    weekStart: local.toISODate() ?? local.toUTC().toISODate() ?? "unknown",
    startMs: windowStart.getTime(),
    endMs: windowEnd.getTime(),
  };
}

/**
 * Deterministic importance — which meetings matter most. An external guest
 * outweighs headcount, and a ready Brief outranks a missing one. Attendee
 * count, external presence, and Brief readiness only; no new signals.
 */
export function weeklyImportance(input: {
  guestCount: number;
  hasExternal: boolean;
  briefStatus: DailyBriefingBriefStatus;
}): number {
  let score = Math.max(0, input.guestCount);
  if (input.hasExternal) score += 10;
  if (input.briefStatus === "ready") score += 5;
  else if (input.briefStatus === "pending") score += 2;
  return score;
}

/**
 * The week's Weekly Briefing, or null when the week holds no Meetings. Reads
 * the Workspace's Meetings for the owner-timezone sweep week plus the Brief
 * Runs index for their Brief state. Throws only when the underlying stores
 * throw; the host turns that into the surfaced error state.
 */
export function buildWeeklyBriefing(
  deps: WeeklyBriefingDeps,
  now: Date,
  timezone: string,
  internalDomains: string[] = [],
): WeeklyBriefing | null {
  const { weekStart, startMs, endMs } = weekBoundsFor(now, timezone);
  /* The week *ahead*. The sweep window opens on Sunday because that is when
     Briefs are prepared, but a briefing about what the week holds must not
     re-list days that have already happened — on a Friday that filled the
     section with Monday-to-Thursday transcripts nobody can prepare for. Today
     stays whole: a meeting earlier today is still part of this week. */
  const fromMs = Math.max(startMs, dayBoundsFor(now, timezone).startMs);
  const weeks = deps.meetings.list().filter((meeting) => {
    if (meeting.cancelled) return false;
    const startMsOf = Date.parse(meeting.startAt);
    return !Number.isNaN(startMsOf) && startMsOf >= fromMs && startMsOf < endMs;
  });
  if (weeks.length === 0) return null;

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

  const meetings = weeks.map((meeting) => {
    /* Best outcome wins: a Brief that succeeded after an earlier failure is
       ready, and one still preparing outranks the attempt it supersedes. */
    let briefStatus: DailyBriefingBriefStatus = "missing";
    if (meeting.occurrenceKey) {
      if (doneKeys.has(meeting.occurrenceKey)) briefStatus = "ready";
      else if (activeKeys.has(meeting.occurrenceKey)) briefStatus = "pending";
      else if (failedKeys.has(meeting.occurrenceKey)) briefStatus = "failed";
    }
    const guests = meeting.participants.filter((participant) => !participant.self);
    const hasExternal = guests.some(
      (participant) =>
        participant.email !== "" && !isInternalDomain(participant.email, internalDomains),
    );
    return {
      meetingId: meeting.id,
      title: meeting.title,
      startAt: meeting.startAt,
      importance: weeklyImportance({ guestCount: guests.length, hasExternal, briefStatus }),
      briefStatus,
    };
  });
  meetings.sort(
    (a, b) =>
      b.importance - a.importance ||
      Date.parse(a.startAt) - Date.parse(b.startAt) ||
      a.meetingId.localeCompare(b.meetingId),
  );
  const ready = meetings.filter((entry) => entry.briefStatus === "ready").length;
  /* Named in the ranking, not just per row: a failure the owner has to act on
     should be visible without reading the list. */
  const failed = meetings.filter((entry) => entry.briefStatus === "failed").length;
  const noun = meetings.length === 1 ? "Meeting" : "Meetings";
  const readyNoun = ready === 1 ? "Brief" : "Briefs";
  const top = meetings[0]?.title ?? "—";
  return {
    weekStart,
    meetings,
    ranking:
      `${meetings.length} ${noun} this week · ` +
      `${ready} ${readyNoun} ready · ` +
      (failed > 0 ? `${failed} failed · ` : "") +
      `top: ${top}`,
  };
}
