import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { MEETING_BRIEF_MODULE_ID } from "@chief-of-staff-demo/shared";
import type { Runs } from "../../../apps/server/src/runs";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";
import {
  buildWeeklyBriefing,
  weekBoundsFor,
  weeklyImportance,
} from "../../../apps/server/src/modules/meeting-brief-generator/weeklyBriefing";

/** Monday 2026-08-31 12:00 UTC — the covered sweep week opens Sunday 2026-08-30. */
const NOW = new Date("2026-08-31T12:00:00.000Z");

function emptyRuns(): Runs {
  return fromPartial<Runs>({
    list: () => ({ runs: [] }),
    open: () => null,
    detail: () => null,
  });
}

function seedMeetings(): WorkspaceMeetings {
  const meetings = new WorkspaceMeetings(mkdtempSync(join(tmpdir(), "mb-weekly-")), () => NOW);
  meetings.upsertFromCalendar({
    occurrenceKey: "evt-a::occ-a",
    calendarEventId: "evt-a",
    occurrenceId: "occ-a",
    title: "Acme negotiation",
    startAt: "2026-08-31T14:00:00.000Z",
    endAt: "2026-08-31T15:00:00.000Z",
    participants: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
        self: true,
      },
      {
        email: "a@acme.com",
        displayName: "A",
        responseStatus: "accepted",
        organizer: false,
        self: false,
      },
      {
        email: "b@acme.com",
        displayName: "B",
        responseStatus: "accepted",
        organizer: false,
        self: false,
      },
      {
        email: "c@acme.com",
        displayName: "C",
        responseStatus: "accepted",
        organizer: false,
        self: false,
      },
    ],
    cancelled: false,
    ineligibleReason: null,
  });
  meetings.upsertFromCalendar({
    occurrenceKey: "evt-b::occ-b",
    calendarEventId: "evt-b",
    occurrenceId: "occ-b",
    title: "Internal 1:1",
    startAt: "2026-09-01T14:00:00.000Z",
    endAt: "2026-09-01T14:30:00.000Z",
    participants: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
        self: true,
      },
      {
        email: "peer@example.com",
        displayName: "Peer",
        responseStatus: "accepted",
        organizer: false,
        self: false,
      },
    ],
    cancelled: false,
    ineligibleReason: null,
  });
  meetings.upsertFromCalendar({
    occurrenceKey: "evt-c::occ-c",
    calendarEventId: "evt-c",
    occurrenceId: "occ-c",
    title: "Next week sync",
    startAt: "2026-09-08T14:00:00.000Z",
    endAt: "2026-09-08T15:00:00.000Z",
    participants: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
        self: true,
      },
      {
        email: "d@acme.com",
        displayName: "D",
        responseStatus: "accepted",
        organizer: false,
        self: false,
      },
    ],
    cancelled: false,
    ineligibleReason: null,
  });
  return meetings;
}

describe("weeklyBriefing", () => {
  it("covers the sweep week and ranks external, headcount-heavy meetings first", () => {
    const briefing = buildWeeklyBriefing(
      { meetings: seedMeetings(), runs: emptyRuns() },
      NOW,
      "UTC",
      ["example.com"],
    );
    expect(briefing?.weekStart).toBe("2026-08-30");
    expect(briefing?.meetings.map((entry) => entry.title)).toEqual([
      "Acme negotiation",
      "Internal 1:1",
    ]);
    expect(briefing?.meetings[0]).toMatchObject({ importance: 13, briefStatus: "missing" });
    expect(briefing?.meetings[1]).toMatchObject({ importance: 1, briefStatus: "missing" });
    expect(briefing?.ranking).toBe("2 Meetings this week · 0 Briefs ready · top: Acme negotiation");
  });

  it("marks ready and pending Brief state from the Runs index", () => {
    const runs = fromPartial<Runs>({
      list: () => ({ runs: [{ id: "run-a" }, { id: "run-b" }] }),
      open: (id: string) => ({
        read: () => ({
          externalId: id === "run-a" ? "evt-a::occ-a" : "evt-b::occ-b",
          status: id === "run-a" ? "done" : "running",
        }),
      }),
      detail: (id: string) =>
        id === "run-a" ? { result: { meetingBrief: { id: "brief-a" } } } : { result: null },
    });
    const briefing = buildWeeklyBriefing({ meetings: seedMeetings(), runs }, NOW, "UTC", [
      "example.com",
    ]);
    // Ready (+5) still trails the external meeting's headcount lead; pending (+2) lifts the 1:1.
    expect(
      briefing?.meetings.map((entry) => `${entry.title}:${entry.briefStatus}:${entry.importance}`),
    ).toEqual(["Acme negotiation:ready:18", "Internal 1:1:pending:3"]);
    expect(briefing?.ranking).toBe("2 Meetings this week · 1 Brief ready · top: Acme negotiation");
    expect(MEETING_BRIEF_MODULE_ID).toBe("meeting-brief-generator");
  });

  it("returns null when the week holds no Meetings", () => {
    const meetings = new WorkspaceMeetings(
      mkdtempSync(join(tmpdir(), "mb-weekly-empty-")),
      () => NOW,
    );
    expect(buildWeeklyBriefing({ meetings, runs: emptyRuns() }, NOW, "UTC", [])).toBeNull();
  });

  it("leaves out days of the week that have already happened", () => {
    /* The sweep window opens on Sunday because that is when Briefs are
       prepared, but this section is about the week ahead. Read from the window
       start, a Friday's briefing re-listed Monday to Thursday — in this
       Workspace, transcripts of meetings nobody can prepare for. */
    const meetings = seedMeetings();
    meetings.createFromTranscript({
      transcriptId: "t_sunday",
      title: "Yesterday's stand-up",
      speakers: ["Dana", "Sam"],
      modifiedAt: null,
      meetingDate: "2026-08-30",
    });
    const briefing = buildWeeklyBriefing({ meetings, runs: emptyRuns() }, NOW, "UTC", []);

    expect(briefing?.meetings.map((entry) => entry.title)).not.toContain("Yesterday's stand-up");
  });

  it("keeps a meeting that already happened earlier today", () => {
    const meetings = seedMeetings();
    meetings.createFromTranscript({
      transcriptId: "t_this_morning",
      title: "This morning's stand-up",
      speakers: ["Dana", "Sam"],
      modifiedAt: null,
      nameTimestamp: "2026-08-31T09:00:00.000Z",
    });
    const briefing = buildWeeklyBriefing({ meetings, runs: emptyRuns() }, NOW, "UTC", []);

    expect(briefing?.meetings.map((entry) => entry.title)).toContain("This morning's stand-up");
  });

  it("scores importance deterministically from guests, external presence, and Brief state", () => {
    expect(weeklyImportance({ guestCount: 0, hasExternal: false, briefStatus: "missing" })).toBe(0);
    expect(weeklyImportance({ guestCount: 2, hasExternal: true, briefStatus: "ready" })).toBe(17);
    expect(weeklyImportance({ guestCount: 2, hasExternal: true, briefStatus: "pending" })).toBe(14);
    expect(weekBoundsFor(NOW, "UTC").weekStart).toBe("2026-08-30");
  });
});
