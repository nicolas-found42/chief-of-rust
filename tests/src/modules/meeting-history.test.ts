import { mkdtempSync } from "node:fs";
import type { Meeting } from "@chief-of-staff-demo/shared";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectMeetingHistory } from "../../../apps/server/src/modules/meeting-brief-generator/history";
import {
  FakeCalendarProvider,
  type CalendarEvent,
  type CalendarProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/calendar";
import { reconcileCalendar } from "../../../apps/server/src/modules/meeting-brief-generator/intake";
import { openRuns } from "../../../apps/server/src/runs";
import { TranscriptCatalogStore } from "../../../apps/server/src/transcript-catalog/store";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { atomicWriteJson } from "../../../apps/server/src/engine/atomic";

/**
 * The one backward read of Calendar (issue #152): from the oldest Transcript's
 * date through to now, once, through the same store path forward intake uses.
 */

const NOW = new Date("2026-09-02T10:00:00.000Z");
const OLDEST = "2026-05-01T00:00:00.000Z";

/** The record a reader sees, without the volatile Workspace identity. */
function recordOf(meeting: Meeting): Omit<Meeting, "id"> {
  const { id, ...record } = meeting;
  void id;
  return record;
}

function calEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: "primary",
    eventId: "evt_hist_1",
    version: "v1",
    occurrenceId: "2026-06-15T15:00:00Z",
    summary: "Old planning",
    startAt: "2026-06-15T15:00:00.000Z",
    endAt: "2026-06-15T16:00:00.000Z",
    attendees: [
      { email: "owner@example.com", responseStatus: "accepted", self: true },
      { email: "alice@external.co", responseStatus: "accepted" },
    ],
    status: "confirmed",
    isAllDay: false,
    ...overrides,
  };
}

/** A provider wrapper that records every read window. */
function spyingProvider(inner: CalendarProvider): {
  provider: CalendarProvider;
  windows: Array<{ timeMin: string | null | undefined; timeMax: string | null | undefined }>;
} {
  const windows: Array<{ timeMin: string | null | undefined; timeMax: string | null | undefined }> =
    [];
  const provider: CalendarProvider = {
    ...inner,
    async listEvents(args) {
      windows.push({ timeMin: args.timeMin, timeMax: args.timeMax });
      return inner.listEvents(args);
    },
  };
  return { provider, windows };
}

function meetingsStore(): WorkspaceMeetings {
  return new WorkspaceMeetings(mkdtempSync(join(tmpdir(), "hist-")), () => new Date(NOW));
}

describe("collectMeetingHistory (issue #152)", () => {
  it("reads once from the oldest Transcript's date through to now and records the Meetings", async () => {
    const meetings = meetingsStore();
    const fake = new FakeCalendarProvider([
      calEvent(),
      calEvent({
        eventId: "evt_hist_2",
        summary: "All-day hold",
        isAllDay: true,
        startAt: "2026-06-16T00:00:00.000Z",
        endAt: "2026-06-17T00:00:00.000Z",
      }),
    ]);
    const { provider, windows } = spyingProvider(fake);

    const result = await collectMeetingHistory({
      provider,
      meetings,
      oldestTranscriptAt: OLDEST,
      ownerEmail: "owner@example.com",
      now: NOW,
    });

    expect(windows).toEqual([{ timeMin: OLDEST, timeMax: NOW.toISOString() }]);
    expect(result).toEqual({ recorded: 1, marked: true });
    const list = meetings.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Old planning");
    expect(list[0]?.occurrenceKey).toBe("evt_hist_1::2026-06-15T15:00:00Z");
  });

  it("sends Calendar an RFC3339 instant when the oldest Transcript states only a date", async () => {
    /* `oldestRecordedDate` returns the Transcript's `meetingDate`, which is a
       plain `YYYY-MM-DD`. Sent as-is, Calendar answered 400 Bad Request on
       every reconcile: no history was ever collected, no past Meeting existed,
       and so no Transcript could reach the occurrence it belonged to. */
    const meetings = meetingsStore();
    const { provider, windows } = spyingProvider(new FakeCalendarProvider([calEvent()]));

    await collectMeetingHistory({
      provider,
      meetings,
      oldestTranscriptAt: "2026-05-01",
      ownerEmail: "owner@example.com",
      now: NOW,
    });

    expect(windows).toEqual([{ timeMin: "2026-05-01T00:00:00.000Z", timeMax: NOW.toISOString() }]);
  });

  it("records a Meeting collected from history indistinguishably from forward intake", async () => {
    const fromHistory = meetingsStore();
    const fake = new FakeCalendarProvider([calEvent()]);
    await collectMeetingHistory({
      provider: fake,
      meetings: fromHistory,
      oldestTranscriptAt: OLDEST,
      ownerEmail: "owner@example.com",
      now: NOW,
    });

    const fromIntake = meetingsStore();
    await reconcileCalendar({
      provider: new FakeCalendarProvider([calEvent()]),
      store: {
        getSyncToken: () => null,
        setSyncState: () => {},
      } as never,
      clock: {
        list: () => [],
        remove: () => {},
        schedule: () => {},
      } as never,
      ownerEmail: "owner@example.com",
      meetings: fromIntake,
      now: NOW,
    });

    const historyMeeting = fromHistory.list()[0];
    const intakeMeeting = fromIntake.list()[0];
    expect(historyMeeting).toBeDefined();
    expect(intakeMeeting).toBeDefined();
    // The volatile identity differs; the record a reader sees does not depend
    // on which direction the read came from.
    expect(recordOf(historyMeeting)).toEqual(recordOf(intakeMeeting));
  });

  it("records a timed cancelled occurrence, not an all-day hold or an owner-only entry", async () => {
    const meetings = meetingsStore();
    const fake = new FakeCalendarProvider([
      calEvent({
        eventId: "evt_cancelled",
        status: "cancelled",
        summary: "Cancelled retro",
      }),
      calEvent({
        eventId: "evt_allday",
        isAllDay: true,
        startAt: "2026-06-16T00:00:00.000Z",
        endAt: "2026-06-17T00:00:00.000Z",
      }),
      calEvent({
        eventId: "evt_owner_only",
        attendees: [{ email: "owner@example.com", responseStatus: "accepted", self: true }],
      }),
    ]);

    const result = await collectMeetingHistory({
      provider: fake,
      meetings,
      oldestTranscriptAt: OLDEST,
      ownerEmail: "owner@example.com",
      now: NOW,
    });

    expect(result.recorded).toBe(1);
    expect(meetings.list()[0]).toMatchObject({ cancelled: true, ineligibleReason: "cancelled" });
  });

  it("is marked once it has run, and never reads again", async () => {
    const meetings = meetingsStore();
    const fake = new FakeCalendarProvider([calEvent()]);
    const { provider, windows } = spyingProvider(fake);
    const args = {
      provider,
      meetings,
      oldestTranscriptAt: OLDEST as string | null,
      ownerEmail: "owner@example.com",
      now: NOW,
    };

    await collectMeetingHistory(args);
    expect(await collectMeetingHistory(args)).toEqual({ recorded: 0, marked: true });
    expect(windows).toHaveLength(1);
  });

  it("collects nothing for a workspace with no Transcripts, and is not marked", async () => {
    const meetings = meetingsStore();
    const fake = new FakeCalendarProvider([calEvent()]);
    const { provider, windows } = spyingProvider(fake);

    const result = await collectMeetingHistory({
      provider,
      meetings,
      oldestTranscriptAt: null,
      ownerEmail: "owner@example.com",
      now: NOW,
    });

    expect(result).toEqual({ recorded: 0, marked: false });
    expect(windows).toEqual([]);
    expect(meetings.historyMark()).toBeNull();
  });
  it("leaves no mark on a failed read, so the next reconcile retries", async () => {
    const meetings = meetingsStore();
    const base = new FakeCalendarProvider([calEvent()]);
    let fail = true;
    const flaky: CalendarProvider = {
      watchChannel: (...callArgs) => base.watchChannel(...callArgs),
      stopChannel: (...callArgs) => base.stopChannel(...callArgs),
      async listEvents(args) {
        if (fail) throw new Error("calendar unavailable");
        return base.listEvents(args);
      },
    };

    await expect(
      collectMeetingHistory({
        provider: flaky,
        meetings,
        oldestTranscriptAt: OLDEST,
        ownerEmail: "owner@example.com",
        now: NOW,
      }),
    ).rejects.toThrow("calendar unavailable");
    expect(meetings.historyMark()).toBeNull();

    fail = false;
    const result = await collectMeetingHistory({
      provider: flaky,
      meetings,
      oldestTranscriptAt: OLDEST,
      ownerEmail: "owner@example.com",
      now: NOW,
    });
    expect(result.recorded).toBe(1);
    expect(meetings.historyMark()?.from).toBe(OLDEST);
  });
});

describe("the transcript bound (issue #152)", () => {
  it("is the oldest transcript's meeting date, falling back to ingestion date", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "hist-bound-"));
    const store = new TranscriptCatalogStore(workspaceDir);
    store.saveTranscript({
      id: "drive_a_r1",
      source: {
        sourceSystem: "drive",
        externalFileId: "a",
        fileName: "a",
        sourceUrl: null,
        checksum: "x",
        observedRevision: 1,
        modifiedAt: null,
      },
      ingestedAt: "2026-08-01T00:00:00.000Z",
      extractorVersion: 1,
      normalizedText: "",
      meetingDate: "2026-06-01T00:00:00.000Z",
      occurrence: null,
      speakers: [],
      speakerIdentityMappings: [],
      roster: [],
      meetingId: null,
    });
    store.saveTranscript({
      meetingId: null,
      id: "drive_b_r1",
      source: {
        sourceSystem: "drive",
        externalFileId: "b",
        fileName: "b",
        sourceUrl: null,
        checksum: "y",
        observedRevision: 1,
        modifiedAt: null,
      },
      ingestedAt: "2026-05-15T00:00:00.000Z",
      extractorVersion: 1,
      normalizedText: "",
      meetingDate: null,
      occurrence: null,
      speakers: [],
      speakerIdentityMappings: [],
      roster: [],
    });
    expect(store.oldestRecordedDate()).toBe("2026-05-15T00:00:00.000Z");
  });

  it("is null for a workspace with no transcripts", () => {
    const store = new TranscriptCatalogStore(mkdtempSync(join(tmpdir(), "hist-empty-")));
    expect(store.oldestRecordedDate()).toBeNull();
  });
});

describe("the production wiring collects history (issue #152)", () => {
  it("reconcile collects history once the host carries the transcript bound", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "hist-host-"));
    const fake = new FakeCalendarProvider([calEvent()]);
    const host = new MeetingBriefHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      now: () => new Date(NOW),
      calendarProvider: fake,
      getOwnerEmail: () => "owner@example.com",
      oldestTranscriptAt: () => OLDEST,
      log: () => {},
    });

    await host.reconcileCalendar({ forceFullSync: true });

    const meetings = new WorkspaceMeetings(workspaceDir, () => new Date(NOW));
    expect(meetings.list().map((meeting) => meeting.title)).toContain("Old planning");
    expect(meetings.historyMark()?.from).toBe(OLDEST);
  });

  it("a workspace whose catalog has no transcripts collects no history and does not fail", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "hist-host-empty-"));
    const host = new MeetingBriefHost({
      runs: openRuns(workspaceDir),
      workspaceDir,
      now: () => new Date(NOW),
      calendarProvider: new FakeCalendarProvider([calEvent()]),
      getOwnerEmail: () => "owner@example.com",
      oldestTranscriptAt: () => new TranscriptCatalogStore(workspaceDir).oldestRecordedDate(),
      log: () => {},
    });

    await expect(host.reconcileCalendar({ forceFullSync: true })).resolves.toBeDefined();
    // Forward intake may still record what the provider returns; what must
    // not happen is a backward read being marked as done without a bound.
    expect(new WorkspaceMeetings(workspaceDir).historyMark()).toBeNull();
  });
});

// The store's marker file lives beside meetings.json; assert the path shape the
// generated-data clear and the migration inventory rely on.
describe("the history mark (issue #152)", () => {
  it("survives a store restart and tolerates a corrupt file", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "hist-mark-"));
    const meetings = new WorkspaceMeetings(workspaceDir);
    expect(meetings.historyMark()).toBeNull();
    meetings.writeHistoryMark({ collectedAt: NOW.toISOString(), from: OLDEST });
    expect(new WorkspaceMeetings(workspaceDir).historyMark()).toEqual({
      collectedAt: NOW.toISOString(),
      from: OLDEST,
    });

    atomicWriteJson(join(workspaceDir, "meetings", "history.json"), { collectedAt: 3 });
    expect(meetings.historyMark()).toBeNull();
  });
});
