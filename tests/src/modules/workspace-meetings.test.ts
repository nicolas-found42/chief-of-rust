import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import {
  FakeCalendarProvider,
  type CalendarEvent,
} from "../../../apps/server/src/modules/meeting-brief-generator/calendar";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";

function calEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: "primary",
    eventId: "evt1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Test Event",
    startAt: "2026-08-28T15:00:00.000Z",
    endAt: "2026-08-28T16:00:00.000Z",
    attendees: [
      { email: "owner@example.com", responseStatus: "accepted", self: true },
      { email: "alice@external.co", responseStatus: "accepted" },
    ],
    status: "confirmed",
    isAllDay: false,
    ...overrides,
  };
}

let workspaceDir: string;
let runs: Runs;
let fakeCal: FakeCalendarProvider;
let host: MeetingBriefHost;
let meetings: WorkspaceMeetings;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "wsm-"));
  runs = openRuns(workspaceDir);
  fakeCal = new FakeCalendarProvider();
  host = new MeetingBriefHost({
    runs,
    workspaceDir,
    now: () => new Date("2026-08-28T09:00:00.000Z"),
    calendarProvider: fakeCal,
    getOwnerEmail: () => "owner@example.com",
    log: () => {},
  });
  meetings = new WorkspaceMeetings(workspaceDir);
});

describe("the Workspace records Meetings from Calendar (ADR-0050)", () => {
  it("records a timed occurrence that has another attendee", async () => {
    fakeCal.setEvents([calEvent()]);
    await host.reconcileCalendar({ forceFullSync: true });

    const list = meetings.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Test Event");
    expect(list[0]?.occurrenceKey).toBe("evt1::2026-08-28T15:00:00Z");
    expect(list[0]?.ineligibleReason).toBeNull();
  });

  it("keeps only people on the record — a room is not a participant", async () => {
    fakeCal.setEvents([
      calEvent({
        attendees: [
          { email: "owner@example.com", responseStatus: "accepted", self: true },
          { email: "alice@external.co", responseStatus: "accepted" },
          {
            email: "room-3@resource.calendar.google.com",
            responseStatus: "accepted",
            resource: true,
          },
        ],
      }),
    ]);
    await host.reconcileCalendar({ forceFullSync: true });

    const participants = meetings.list()[0]?.participants ?? [];
    expect(participants.map((person) => person.email)).toEqual([
      "owner@example.com",
      "alice@external.co",
    ]);
    expect(participants[0]?.self).toBe(true);
  });

  it("records a meeting the owner declined, and names the test it failed", async () => {
    fakeCal.setEvents([
      calEvent({
        attendees: [
          { email: "owner@example.com", responseStatus: "declined", self: true },
          { email: "alice@external.co", responseStatus: "accepted" },
        ],
      }),
    ]);
    await host.reconcileCalendar({ forceFullSync: true });

    const list = meetings.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.ineligibleReason).toBe("owner_declined");
  });

  it("does not record an all-day entry or one with nobody else invited", async () => {
    fakeCal.setEvents([
      calEvent({ eventId: "all-day", occurrenceId: "d1", isAllDay: true }),
      calEvent({
        eventId: "solo",
        occurrenceId: "d2",
        attendees: [{ email: "owner@example.com", responseStatus: "accepted", self: true }],
      }),
    ]);
    await host.reconcileCalendar({ forceFullSync: true });

    expect(meetings.list()).toHaveLength(0);
  });

  it("keeps the Meeting after its start time has passed", async () => {
    fakeCal.setEvents([calEvent()]);
    await host.reconcileCalendar({ forceFullSync: true });
    const before = meetings.list()[0];

    /* A later reconcile with the occurrence long past: the Brief schedule goes,
       the record does not (ADR-0050). */
    const laterHost = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date("2026-09-30T09:00:00.000Z"),
      calendarProvider: fakeCal,
      getOwnerEmail: () => "owner@example.com",
      log: () => {},
    });
    await laterHost.reconcileCalendar({ forceFullSync: true });

    const after = meetings.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before.id);
  });

  it("gives a Meeting its own identity, and keeps it across a Calendar revision", async () => {
    fakeCal.setEvents([calEvent()]);
    await host.reconcileCalendar({ forceFullSync: true });
    const first = meetings.list()[0];
    expect(first.id).not.toBe(first.occurrenceKey);

    fakeCal.setEvents([calEvent({ version: "v2", summary: "Test Event (moved room)" })]);
    await host.reconcileCalendar({ forceFullSync: true });

    const list = meetings.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(first.id);
    expect(list[0]?.title).toBe("Test Event (moved room)");
  });

  it("records a cancelled occurrence rather than forgetting it", async () => {
    fakeCal.setEvents([calEvent({ status: "cancelled" })]);
    await host.reconcileCalendar({ forceFullSync: true });

    const list = meetings.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.cancelled).toBe(true);
    expect(list[0]?.ineligibleReason).toBe("cancelled");
  });
});
