import { DateTime } from "luxon";
import {
  MEETING_BRIEF_MODULE_ID,
  meetingBriefOccurrenceIdentity,
} from "@chief-of-staff-demo/shared";
import type { MeetingIneligibility } from "@chief-of-staff-demo/shared";
import type { DurableClock } from "../../engine/durableClock.js";
import type { WorkspaceMeetings } from "../../meetings/store.js";
import {
  eligibilityReason,
  isEligibleMeeting,
  isRecordableMeeting,
  meetingParticipants,
} from "./eligibility.js";
import {
  type CalendarEvent,
  type CalendarProvider,
  INTAKE_HORIZON_MS,
  InvalidSyncTokenError,
  type MeetingBriefCalendarStore,
  newChannelId,
  newChannelToken,
} from "./calendar.js";

export const MEETING_BRIEF_CALENDAR_ID = "primary" as const;

/**
 * The Sunday sweep window covering `now` (issue://157): Sunday 00:00
 * inclusive through the following Sunday 00:00 exclusive, in the owner's
 * calendar timezone, returned as UTC instants. Weekend included, so a Monday
 * plan can see Friday. An unknown timezone falls back to UTC.
 */
export interface SweepWindow {
  windowStart: Date;
  windowEnd: Date;
}

export function sweepWindowFor(now: Date, timezone: string): SweepWindow {
  let local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  if (!local.isValid) local = DateTime.fromJSDate(now, { zone: "utc" });
  // Luxon weekdays run Monday (1) through Sunday (7); days since Sunday is weekday % 7.
  const windowStart = local.startOf("day").minus({ days: local.weekday % 7 });
  return {
    windowStart: windowStart.toJSDate(),
    windowEnd: windowStart.plus({ days: 7 }).toJSDate(),
  };
}

/** Whether a meeting start falls inside the sweep window covering `now`. */
function isInSweepWindow(startAt: string, now: Date, timezone: string): boolean {
  const startMs = Date.parse(startAt);
  if (Number.isNaN(startMs)) return false;
  const { windowStart, windowEnd } = sweepWindowFor(now, timezone);
  return startMs >= windowStart.getTime() && startMs < windowEnd.getTime();
}

/** Occurrence key for deduplication and durableClock key (ADR-0033). */
export function occurrenceKeyFor(event: Pick<CalendarEvent, "eventId" | "occurrenceId">): string {
  return meetingBriefOccurrenceIdentity(event.eventId, event.occurrenceId).occurrenceKey;
}

const INELIGIBILITY: readonly MeetingIneligibility[] = [
  "all_day_excluded",
  "missing_time",
  "cancelled",
  "owner_declined",
  "no_other_attendee",
];

/** Narrow `eligibilityReason`'s diagnostic string; `eligible` becomes null. */
export function ineligibilityOf(reason: string): MeetingIneligibility | null {
  return INELIGIBILITY.find((value) => value === reason) ?? null;
}

/** Record what Calendar currently says about one occurrence in the Workspace's Meetings (ADR-0050). */
function recordMeeting(
  meetings: WorkspaceMeetings | undefined,
  event: CalendarEvent,
  ownerEmail: string | null,
): void {
  if (!meetings || !isRecordableMeeting(event, ownerEmail)) return;
  const key = occurrenceKeyFor(event);
  meetings.upsertFromCalendar({
    occurrenceKey: key,
    calendarEventId: event.eventId,
    occurrenceId: event.occurrenceId,
    title: event.summary,
    startAt: event.startAt,
    endAt: event.endAt,
    participants: meetingParticipants(event, ownerEmail),
    cancelled: event.status === "cancelled",
    ineligibleReason: ineligibilityOf(eligibilityReason(event, ownerEmail)),
  });
}

/** Ensure the primary Calendar push channel exists and is durable before expiration (issue://83). */
export async function ensureCalendarWatch(args: {
  provider: CalendarProvider;
  store: MeetingBriefCalendarStore;
  now: Date;
  calendarId?: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const calendarId = args.calendarId ?? MEETING_BRIEF_CALENDAR_ID;
  const needsRenewal = args.store.needsRenewal(args.now);
  const existing = args.store.load().channel;
  if (existing && !needsRenewal) return;

  const newId = newChannelId();
  const newToken = newChannelToken();
  const result = await args.provider.watchChannel({
    calendarId,
    channelId: newId,
    token: newToken,
  });
  const newChannel = {
    channelId: newId,
    token: newToken,
    resourceId: result.resourceId,
    expiration: result.expiration,
    calendarId,
  };
  // Activate new before revoking old (ADR-0031)
  if (existing && existing.channelId !== newId) {
    try {
      await args.provider.stopChannel({
        channelId: existing.channelId,
        resourceId: existing.resourceId,
      });
    } catch {
      // best-effort revoke; still persist new channel
    }
  }
  args.store.setChannel(newChannel);
  args.log?.(`calendar watch ensured ${newId} exp ${result.expiration}`);
}

/**
 * Reconcile Calendar current state against Intake schedules (issue://83, weekly sweep per issue://157).
 * Header-only wake-ups never mistaken for data — we fetch Calendar after each wake-up.
 * Classifies Eligible Meetings: in-window ones schedule for immediate preparation while
 * beyond-window ones wait for the sweep that covers them, moved inside starts immediately,
 * ineligible removes schedule. A revised event still regenerates its Brief — the new
 * version replaces the schedule and the Run path supersedes.
 * Duplicate wake-ups are harmless (idempotent replace). Bounded reconciliation on invalid sync.
 */
export async function reconcileCalendar(args: {
  provider: CalendarProvider;
  store: MeetingBriefCalendarStore;
  clock: DurableClock;
  ownerEmail: string | null | (() => string | null);
  /** The Workspace's Meetings (ADR-0050). Absent in callers that only schedule. */
  meetings?: WorkspaceMeetings;
  now: Date;
  /** IANA timezone the sweep window is computed in (issue://157). Defaults to UTC. */
  timezone?: string;
  calendarId?: string;
  forceFullSync?: boolean;
  log?: (msg: string) => void;
}): Promise<{ scheduled: number; removed: number; invalidSyncRecovered: boolean }> {
  const calendarId = args.calendarId ?? MEETING_BRIEF_CALENDAR_ID;
  const timezone = args.timezone ?? "UTC";
  let syncToken: string | null = args.forceFullSync ? null : args.store.getSyncToken();
  let events: CalendarEvent[];
  let nextSyncToken: string | null;
  let invalidSyncRecovered = false;

  // Attempt incremental or bounded full sync
  const fetchOnce = async (token: string | null) => {
    // Bounded full sync uses timeMin/timeMax window (next 90 days)
    if (token === null) {
      const timeMin = args.now.toISOString();
      const timeMax = new Date(args.now.getTime() + INTAKE_HORIZON_MS).toISOString();
      return args.provider.listEvents({ calendarId, syncToken: null, timeMin, timeMax });
    }
    return args.provider.listEvents({ calendarId, syncToken: token });
  };

  try {
    const result = await fetchOnce(syncToken);
    events = result.events;
    nextSyncToken = result.nextSyncToken;
  } catch (err) {
    if (
      err instanceof InvalidSyncTokenError ||
      (err instanceof Error && err.name === "InvalidSyncTokenError")
    ) {
      invalidSyncRecovered = true;
      args.log?.("calendar syncToken invalid — bounded reconciliation");
      // Bounded reconciliation: full sync without token
      const result = await fetchOnce(null);
      events = result.events;
      nextSyncToken = result.nextSyncToken;
      // Clear old token before saving new
      syncToken = null;
    } else {
      throw err;
    }
  }

  // Persist syncToken if provider gave one
  if (nextSyncToken !== null && nextSyncToken !== syncToken) {
    args.store.setSyncState(nextSyncToken, args.now.toISOString());
  } else if (nextSyncToken === null && syncToken !== null) {
    // Provider may return null on full sync; keep stored unless invalidated
  }

  let scheduled = 0;
  let removed = 0;
  const ownerEmail = typeof args.ownerEmail === "function" ? args.ownerEmail() : args.ownerEmail;

  // A full sync has a complete view, so unseen schedules can be removed. Incremental syncs only
  // reconcile the occurrences returned by Google.
  const seenKeys = new Set<string>();

  for (const event of events) {
    // Sparse cancelled non-recurring tombstones without start/end: remove by eventId using durable identity
    const isSparseCancelled =
      event.status === "cancelled" && (!event.startAt || Number.isNaN(Date.parse(event.startAt)));
    if (isSparseCancelled) {
      const matching = args.clock.list(MEETING_BRIEF_MODULE_ID).filter((s) => {
        const input = s.input as CalendarEvent | null;
        return input !== null && typeof input === "object" && input.eventId === event.eventId;
      });
      if (matching.length > 0) {
        for (const matched of matching) {
          args.clock.remove(MEETING_BRIEF_MODULE_ID, matched.key);
          removed += 1;
          const storedInput = matched.input as CalendarEvent;
          args.store.setCancellation({
            occurrenceKey: matched.key,
            eventId: event.eventId,
            occurrenceId: storedInput.occurrenceId,
            version: event.version,
            summary: event.summary,
            cancelledAt: args.now.toISOString(),
          });
          seenKeys.add(matched.key);
        }
      } else {
        // No prior schedule, still record cancellation using incoming identity
        const fallbackKey = occurrenceKeyFor(event);
        args.store.setCancellation({
          occurrenceKey: fallbackKey,
          eventId: event.eventId,
          occurrenceId: event.occurrenceId,
          version: event.version,
          summary: event.summary,
          cancelledAt: args.now.toISOString(),
        });
        seenKeys.add(fallbackKey);
      }
      continue;
    }

    const key = occurrenceKeyFor(event);
    seenKeys.add(key);
    const eligible = isEligibleMeeting(event, ownerEmail);

    /* ADR-0050: the Workspace records the meeting whether or not it earns a
       Meeting Brief, and keeps it once Calendar's forward window has moved
       past it. Eligibility below still decides only what gets prepared. */
    recordMeeting(args.meetings, event, ownerEmail);

    const startMs = Date.parse(event.startAt);
    const isFuture = !Number.isNaN(startMs) && startMs > args.now.getTime();

    if (!eligible || !isFuture) {
      // Ineligible or past/cancelled/all-day/resource-only/internal-only — remove schedule if present
      const before = args.clock.list(MEETING_BRIEF_MODULE_ID).some((s) => s.key === key);
      args.clock.remove(MEETING_BRIEF_MODULE_ID, key);
      if (before) removed += 1;
      if (event.status === "cancelled") {
        args.store.setCancellation({
          occurrenceKey: key,
          eventId: event.eventId,
          occurrenceId: event.occurrenceId,
          version: event.version,
          summary: event.summary,
          cancelledAt: args.now.toISOString(),
        });
      }
      continue;
    }

    // Eligible future inside the sweep window prepares immediately (seen after
    // the sweep starts at once); beyond the window it waits for the sweep that
    // covers it (issue://157). A revised event still regenerates its Brief —
    // the new version replaces the schedule below and the Run path supersedes.
    if (!isInSweepWindow(event.startAt, args.now, timezone)) {
      const before = args.clock.list(MEETING_BRIEF_MODULE_ID).some((s) => s.key === key);
      args.clock.remove(MEETING_BRIEF_MODULE_ID, key);
      if (before) removed += 1;
      continue;
    }
    args.store.clearCancellation(key);
    // Durably schedule for immediate preparation (atomic replace)
    args.clock.schedule({
      module: MEETING_BRIEF_MODULE_ID,
      key,
      dueAt: args.now.toISOString(),
      input: event,
    });
    scheduled += 1;
  }
  // A missing occurrence in a full sync was deleted or is no longer eligible.
  if (syncToken === null) {
    const currentKeys = args.clock.list(MEETING_BRIEF_MODULE_ID).map((s) => s.key);
    for (const key of currentKeys) {
      if (!seenKeys.has(key)) {
        args.clock.remove(MEETING_BRIEF_MODULE_ID, key);
        removed += 1;
      }
    }
  }

  args.log?.(`reconcile: ${scheduled} scheduled, ${removed} removed, token ${nextSyncToken}`);
  return { scheduled, removed, invalidSyncRecovered };
}

/**
 * The Sunday sweep (issue://157): enumerate the Meetings starting inside the
 * sweep window covering `now` (Sunday 00:00 through Saturday end, weekend
 * included) and enqueue Brief preparation for each eligible one missing a
 * current Brief. Same-version schedules and current Briefs are left alone; a
 * revised event still regenerates its Brief — the new version replaces the
 * schedule and the Run path supersedes.
 */
export async function prepareWeekSweep(args: {
  provider: CalendarProvider;
  store: MeetingBriefCalendarStore;
  clock: DurableClock;
  ownerEmail: string | null | (() => string | null);
  /** The Workspace's Meetings (ADR-0050). Absent in callers that only schedule. */
  meetings?: WorkspaceMeetings;
  /** True when the occurrence already has a Brief current for this event version. */
  hasCurrentBrief?: (occurrenceKey: string, event: CalendarEvent) => boolean;
  now: Date;
  /** IANA timezone the sweep window is computed in. Defaults to UTC. */
  timezone?: string;
  calendarId?: string;
  log?: (msg: string) => void;
}): Promise<{ scheduled: number; windowStart: string; windowEnd: string }> {
  const calendarId = args.calendarId ?? MEETING_BRIEF_CALENDAR_ID;
  const timezone = args.timezone ?? "UTC";
  const { windowStart, windowEnd } = sweepWindowFor(args.now, timezone);
  // Bounded read over exactly the week the sweep covers. Providers that
  // ignore the window still converge: the window filter below applies.
  const { events } = await args.provider.listEvents({
    calendarId,
    syncToken: null,
    timeMin: windowStart.toISOString(),
    timeMax: windowEnd.toISOString(),
  });
  const ownerEmail = typeof args.ownerEmail === "function" ? args.ownerEmail() : args.ownerEmail;
  let scheduled = 0;
  for (const event of events) {
    recordMeeting(args.meetings, event, ownerEmail);
    const key = occurrenceKeyFor(event);
    if (!isEligibleMeeting(event, ownerEmail)) continue;
    const startMs = Date.parse(event.startAt);
    if (Number.isNaN(startMs) || startMs <= args.now.getTime()) continue;
    if (startMs < windowStart.getTime() || startMs >= windowEnd.getTime()) continue;
    const existing = args.clock.list(MEETING_BRIEF_MODULE_ID).find((s) => s.key === key);
    if (existing && (existing.input as CalendarEvent | null)?.version === event.version) continue;
    if (args.hasCurrentBrief?.(key, event) === true) continue;
    args.store.clearCancellation(key);
    args.clock.schedule({
      module: MEETING_BRIEF_MODULE_ID,
      key,
      dueAt: args.now.toISOString(),
      input: event,
    });
    scheduled += 1;
  }
  args.log?.(
    `week sweep: ${scheduled} scheduled for ${windowStart.toISOString()}–${windowEnd.toISOString()}`,
  );
  return { scheduled, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
}
