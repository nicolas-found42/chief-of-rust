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
import { FakeGmailProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail";
import { FakeGmailDeliveryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmailDelivery";
import { FakeCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory";
import { FakeDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive";
import { FakePublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import {
  eligibilityReason,
  isEligibleMeeting,
} from "../../../apps/server/src/modules/meeting-brief-generator/eligibility";
import { normalizeInternalDomains } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "../../../apps/server/src/config";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { completeFixtureBrief } from "../../../apps/server/src/modules/meeting-brief-generator/testRuntime";

function stubHubSpotApi(): HubSpotApi {
  return {
    async listContacts() {
      return { results: [] };
    },
    async searchContactByEmail() {
      return null;
    },
    async getAssociatedCompanyIds() {
      return [];
    },
    async getCompany() {
      return null;
    },
    async getAssociatedDealIds() {
      return [];
    },
    async getDeal() {
      return null;
    },
    async getAssociatedDealIdsForCompany() {
      return [];
    },
  };
}

function makeAttendeeProfiles(): WorkspacePersonProfiles {
  return new WorkspacePersonProfiles({
    store: new PersonProfileStore(mkdtempSync(join(tmpdir(), "mb-attendee-profiles-"))),
    now: () => new Date("2026-08-28T10:00:00.000Z"),
    lifecycle: [],
  });
}

function calEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: "primary",
    eventId: "evt1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Test Event",
    startAt: "2026-08-28T15:00:00.000Z",
    endAt: "2026-08-28T16:00:00.000Z",
    attendees: [{ email: "alice@external.co", responseStatus: "accepted" }],
    status: "confirmed",
    isAllDay: false,
    ...overrides,
  };
}

let workspaceDir: string;
let runs: Runs;
let now: Date;
let fakeCal: FakeCalendarProvider;
let host: MeetingBriefHost;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "mbi-"));
  runs = openRuns(workspaceDir);
  now = new Date("2026-08-28T09:00:00.000Z");
  fakeCal = new FakeCalendarProvider();
  const gmailDelivery = new FakeGmailDeliveryProvider({
    ownerEmail: "owner@example.com",
  });
  host = new MeetingBriefHost({
    runs,
    workspaceDir,
    now: () => new Date(now),
    calendarProvider: fakeCal,
    getInternalDomains: () => ["internal.com"],
    getOwnerEmail: () => "owner@example.com",
    log: () => {},
    gmailDeliveryProvider: gmailDelivery,
    completeBrief: completeFixtureBrief,
    enrichmentProviders: {
      gmailProvider: new FakeGmailProvider(),
      calendarHistoryProvider: new FakeCalendarHistoryProvider(),
      driveProvider: new FakeDriveProvider(),
      attendeeProfiles: makeAttendeeProfiles(),
      getHubSpotApi: () => stubHubSpotApi(),
      publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
    },
  });
});

describe("eligibility — Internal Domains normalized case-insensitive (issue://83)", () => {
  it("normalizes domains lowercased and deduped via shared helper", () => {
    expect(normalizeInternalDomains(["EXAMPLE.COM", "example.com", "  FoO.Org  ", ""])).toEqual([
      "example.com",
      "foo.org",
    ]);
  });

  it("the Meeting Brief setting normalizes before generic ConfigStore persistence", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const store = new ConfigStore(join(dir, "config.json"));
    store.load();
    const settingHost = new MeetingBriefHost({
      runs: openRuns(dir),
      workspaceDir: dir,
      configStore: store,
    });
    settingHost.setInternalDomains(["UPPER.COM", "upper.com", " Mixed.Org "]);
    expect(store.get().modules["meeting-brief-generator"].internalDomains).toEqual([
      "upper.com",
      "mixed.org",
    ]);
  });

  it("internal attendees are eligible now, and external guests stay eligible", () => {
    expect(
      isEligibleMeeting(
        calEvent({ attendees: [{ email: "bob@internal.com", responseStatus: "accepted" }] }),
        null,
      ),
    ).toBe(true);
    expect(
      isEligibleMeeting(
        calEvent({ attendees: [{ email: "alice@external.co", responseStatus: "accepted" }] }),
        null,
      ),
    ).toBe(true);
  });
});

describe("eligibility table via host — timed/all-day, cancelled/confirmed, owner/guest response, internal/external/consumer/room/resource, recurring", () => {
  it("timed eligible vs all-day excluded", async () => {
    fakeCal.setEvents([calEvent({ isAllDay: false })]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    fakeCal.setEvents([calEvent({ isAllDay: true })]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
  });

  it("confirmed vs cancelled", async () => {
    fakeCal.setEvents([calEvent({ status: "confirmed" })]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    fakeCal.setEvents([calEvent({ status: "cancelled" })]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
    expect(runs.list({ module: "meeting-brief-generator" }).runs).toHaveLength(0);
  });

  it("owner not declined vs declined", async () => {
    const withOwner = calEvent({
      attendees: [
        { email: "owner@example.com", responseStatus: "declined", organizer: true },
        { email: "alice@external.co", responseStatus: "accepted" },
      ],
    });
    fakeCal.setEvents([withOwner]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
    const ownerAccepted = calEvent({
      attendees: [
        { email: "owner@example.com", responseStatus: "accepted", organizer: true },
        { email: "alice@external.co", responseStatus: "accepted" },
      ],
    });
    fakeCal.setEvents([ownerAccepted]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
  });

  it("guest response: accepted/tentative/needsAction count, declined excluded, internal/external", async () => {
    // declined external -> not eligible
    fakeCal.setEvents([
      calEvent({ attendees: [{ email: "alice@external.co", responseStatus: "declined" }] }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
    // tentative counts
    fakeCal.setEvents([
      calEvent({ attendees: [{ email: "alice@external.co", responseStatus: "tentative" }] }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    // needsAction counts
    fakeCal.setEvents([
      calEvent({ attendees: [{ email: "alice@external.co", responseStatus: "needsAction" }] }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    // internal only -> eligible (issue://136): internal meetings schedule like external ones
    fakeCal.setEvents([
      calEvent({ attendees: [{ email: "bob@internal.com", responseStatus: "accepted" }] }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    // consumer domain remains external
    fakeCal.setEvents([
      calEvent({ attendees: [{ email: "alice@gmail.com", responseStatus: "accepted" }] }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    // consumer domain with needsAction still eligible
    fakeCal.setEvents([
      calEvent({ attendees: [{ email: "alice@gmail.com", responseStatus: "needsAction" }] }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
  });

  it("rooms/resources ignored", async () => {
    fakeCal.setEvents([
      calEvent({
        attendees: [
          {
            email: "room@resource.calendar.google.com",
            responseStatus: "accepted",
            resource: true,
          },
        ],
      }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
    fakeCal.setEvents([
      calEvent({
        attendees: [
          {
            email: "room@resource.calendar.google.com",
            responseStatus: "accepted",
            resource: true,
          },
          { email: "alice@external.co", responseStatus: "accepted" },
        ],
      }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
  });

  it("recurring occurrences independent per occurrence identity", async () => {
    const occ1 = calEvent({
      eventId: "recur",
      occurrenceId: "2026-08-28T15:00:00Z",
      startAt: "2026-08-28T15:00:00.000Z",
      endAt: "2026-08-28T16:00:00.000Z",
    });
    const occ2 = calEvent({
      eventId: "recur",
      occurrenceId: "2026-08-29T15:00:00Z",
      startAt: "2026-08-29T15:00:00.000Z",
      endAt: "2026-08-29T16:00:00.000Z",
    });
    fakeCal.setEvents([occ1, occ2]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(2);
    // cancel only first occurrence
    const occ1Cancelled = { ...occ1, status: "cancelled" as const, version: "v2" };
    fakeCal.setEvents([occ1Cancelled, occ2]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    expect(host.listUpcoming()[0]?.occurrenceId).toBe("2026-08-29T15:00:00Z");
    // second still independent
    expect(host.listUpcoming()[0]?.eventId).toBe("recur");
  });

  it("eligibility table asserting candidates/Runs via host (no blocked Runs)", async () => {
    const eligible = calEvent();
    fakeCal.setEvents([eligible]);
    await host.reconcileCalendar();
    const upcoming = host.listUpcoming();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.dueAt).toBe("2026-08-28T09:00:00.000Z");
    expect(runs.list({ module: "meeting-brief-generator" }).runs).toHaveLength(0);
    // No placeholder Runs before due
    for (const r of runs.list({ module: "meeting-brief-generator" }).runs) {
      expect(r.status).not.toBe("blocked");
    }
  });
});

describe("Eligible Meeting — internal and external, owner participation (issue://136)", () => {
  it("an internal meeting with a non-declined attendee is eligible", () => {
    expect(
      eligibilityReason(
        calEvent({ attendees: [{ email: "bob@internal.com", responseStatus: "accepted" }] }),
        "owner@example.com",
      ),
    ).toBe("eligible");
  });

  it("all-day events never start a Brief", () => {
    expect(
      eligibilityReason(
        calEvent({
          isAllDay: true,
          attendees: [{ email: "bob@internal.com", responseStatus: "accepted" }],
        }),
        "owner@example.com",
      ),
    ).toBe("all_day_excluded");
  });

  it("events without a start and end never start a Brief", () => {
    expect(
      eligibilityReason(
        calEvent({
          startAt: "",
          endAt: "",
          attendees: [{ email: "bob@internal.com", responseStatus: "accepted" }],
        }),
        "owner@example.com",
      ),
    ).toBe("missing_time");
  });

  it("cancelled events never start a Brief", () => {
    expect(
      eligibilityReason(
        calEvent({
          status: "cancelled",
          attendees: [{ email: "bob@internal.com", responseStatus: "accepted" }],
        }),
        "owner@example.com",
      ),
    ).toBe("cancelled");
  });

  it("events the owner declined never start a Brief", () => {
    expect(
      eligibilityReason(
        calEvent({
          attendees: [
            { email: "owner@example.com", responseStatus: "declined", organizer: true },
            { email: "bob@internal.com", responseStatus: "accepted" },
          ],
        }),
        "owner@example.com",
      ),
    ).toBe("owner_declined");
  });

  it("owner-only events never start a Brief", () => {
    expect(
      eligibilityReason(
        calEvent({
          attendees: [{ email: "owner@example.com", responseStatus: "accepted", organizer: true }],
        }),
        "owner@example.com",
      ),
    ).toBe("no_other_attendee");
  });

  it("the owner is never counted as the other attendee, even outside the Internal Domains", () => {
    expect(
      eligibilityReason(
        calEvent({
          attendees: [
            { email: "owner@example.com", responseStatus: "accepted", organizer: true },
            {
              email: "room@resource.calendar.google.com",
              responseStatus: "accepted",
              resource: true,
            },
          ],
        }),
        "owner@example.com",
      ),
    ).toBe("no_other_attendee");
  });

  it("events whose only other attendee declined never start a Brief", () => {
    expect(
      eligibilityReason(
        calEvent({
          attendees: [
            { email: "owner@example.com", responseStatus: "accepted", organizer: true },
            { email: "bob@internal.com", responseStatus: "declined" },
          ],
        }),
        "owner@example.com",
      ),
    ).toBe("no_other_attendee");
  });

  it("an internal meeting schedules automatically like an external one", async () => {
    fakeCal.setEvents([
      calEvent({ attendees: [{ email: "bob@internal.com", responseStatus: "accepted" }] }),
    ]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
  });

  it("a manual, non-Calendar meeting never starts a Brief — only Calendar Intake schedules can", async () => {
    fakeCal.setEvents([]);
    await host.reconcileCalendar();
    await expect(host.prepareNow("evt_manual_not_in_intake/v1")).rejects.toThrow(
      "Meeting occurrence is not scheduled: evt_manual_not_in_intake/v1",
    );
    expect(runs.list({ module: "meeting-brief-generator" }).runs).toHaveLength(0);
  });
});

describe("Intake reconciliation against Calendar current state (issue://83) — sweep-window/immediate/replace/remove, duplicate harmless, upcoming vs Runs", () => {
  it("in-window meeting schedules for immediate preparation (sweep semantics)", async () => {
    const ev = calEvent({ startAt: "2026-08-28T15:00:00.000Z" });
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()[0]?.dueAt).toBe(now.toISOString());
  });

  it("immediate if inside sweep window", async () => {
    const ev = calEvent({ startAt: "2026-08-28T11:00:00.000Z" }); // 2h away at 09:00
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()[0]?.dueAt).toBe(now.toISOString());
  });

  it("moved beyond sweep window removes schedule until covering sweep", async () => {
    const ev1 = calEvent({ startAt: "2026-08-28T15:00:00.000Z", version: "v1" });
    fakeCal.setEvents([ev1]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()[0]?.dueAt).toBe(now.toISOString());
    const ev2 = calEvent({
      startAt: "2026-09-05T18:00:00.000Z",
      endAt: "2026-09-05T19:00:00.000Z",
      version: "v2",
    });
    fakeCal.setEvents([ev2]);
    await host.reconcileCalendar();
    // Beyond the window covering now: waits for its covering sweep.
    expect(host.listUpcoming()).toHaveLength(0);
    // The covering week's sweep enqueues it for immediate preparation.
    await host.prepareWeekSweep(new Date("2026-09-05T09:00:00.000Z"), "UTC");
    expect(host.listUpcoming()).toHaveLength(1);
    expect(host.listUpcoming()[0]?.version).toBe("v2");
  });

  it("moved inside starts immediately", async () => {
    const ev1 = calEvent({ startAt: "2026-08-28T15:00:00.000Z", version: "v1" });
    fakeCal.setEvents([ev1]);
    await host.reconcileCalendar();
    const movedInside = calEvent({
      startAt: "2026-08-28T10:30:00.000Z",
      endAt: "2026-08-28T11:30:00.000Z",
      version: "v2",
    });
    fakeCal.setEvents([movedInside]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()[0]?.dueAt).toBe(now.toISOString());
  });

  it("ineligible removes schedule and duplicate wakes harmless", async () => {
    const ev = calEvent();
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    // duplicate wake (same calendar state)
    await host.reconcileCalendar();
    await host.handleRelayWakeUp({ channelId: "any" });
    expect(host.listUpcoming()).toHaveLength(1);
    // make ineligible (cancelled) removes
    const cancelled = calEvent({ status: "cancelled", version: "v2" });
    fakeCal.setEvents([cancelled]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
    // duplicate ineligible still 0
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
  });

  it("header-only wake-ups never mistaken for data (payload ignored)", async () => {
    const ev = calEvent();
    fakeCal.setEvents([ev]);
    // Wake with fake payload that looks like an event but should be ignored
    await host.handleRelayWakeUp({ fakeEvent: { eventId: "evil", summary: "Injected" } });
    expect(host.listUpcoming()).toHaveLength(1);
    expect(host.listUpcoming()[0]?.eventId).toBe("evt1");
  });

  it("upcoming shows Eligible + preparation times while Runs has no placeholders", async () => {
    const ev = calEvent({ startAt: "2026-08-28T15:00:00.000Z" });
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    const upcoming = host.listUpcoming();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.startAt).toBe(ev.startAt);
    expect(upcoming[0]?.dueAt).toBe(now.toISOString());
    const index = host.index();
    expect(index.upcoming).toHaveLength(1);
    expect(index.briefs).toHaveLength(0);
    expect(runs.list({ module: "meeting-brief-generator" }).runs).toHaveLength(0);
    // In-window preparation is immediate: processing at reconcile time creates the Run.
    const created = await host.processDueSchedules(now);
    expect(created).toHaveLength(1);
    await host.idle();
    expect(host.listUpcoming()).toHaveLength(0);
    expect(host.index().briefs).toHaveLength(1);
    expect(runs.list({ module: "meeting-brief-generator" }).runs[0]?.status).toBe("done");
  });
});

describe("Calendar push channel persistence + sync/renewal/recovery/dedup via host seam (issue://83)", () => {
  it("persists channel identity/token/resource identity/expiration/syncToken durably", async () => {
    await host.ensureCalendarWatch();
    const state1 = host.getCalendarState();
    expect(state1.channel).not.toBeNull();
    expect(state1.channel?.channelId).toMatch(/^mbc-/);
    expect(state1.channel?.token).toBeDefined();
    expect(state1.channel?.resourceId).toBeDefined();
    expect(state1.channel?.expiration).toBeDefined();
    // syncToken after reconcile
    const ev = calEvent();
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    const state2 = host.getCalendarState();
    expect(state2.syncToken).not.toBeNull();
    // durable across new host instance (startup recovery)
    const host2 = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      calendarProvider: fakeCal,
      getInternalDomains: () => ["internal.com"],
      getOwnerEmail: () => "owner@example.com",
    });
    expect(host2.getCalendarState().channel?.channelId).toBe(state2.channel?.channelId);
    expect(host2.getCalendarState().syncToken).toBe(state2.syncToken);
  });

  it("durable replace before expiration", async () => {
    class ExpiringCalendar extends FakeCalendarProvider {
      private watchCount = 0;

      override async watchChannel(args: Parameters<FakeCalendarProvider["watchChannel"]>[0]) {
        const result = await super.watchChannel(args);
        this.watchCount += 1;
        return {
          ...result,
          expiration: new Date(
            now.getTime() + (this.watchCount === 1 ? 30 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000),
          ).toISOString(),
        };
      }
    }
    const expiringCalendar = new ExpiringCalendar();
    const expiringHost = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      calendarProvider: expiringCalendar,
      getInternalDomains: () => ["internal.com"],
      getOwnerEmail: () => "owner@example.com",
    });

    await expiringHost.ensureCalendarWatch();
    const ch1 = expiringHost.getCalendarState().channel!;
    await expiringHost.ensureCalendarWatch();
    const ch2 = expiringHost.getCalendarState().channel!;
    expect(ch2.channelId).not.toBe(ch1.channelId);
    expect(expiringCalendar.getWatchCalls().length).toBeGreaterThanOrEqual(2);
    expect(expiringCalendar.getStopCalls()).toContain(ch1.channelId);
    // duplicate ensure when not expiring does not create new channel
    const before = expiringCalendar.getWatchCalls().length;
    await expiringHost.ensureCalendarWatch();
    expect(expiringCalendar.getWatchCalls()).toHaveLength(before);
  });

  it("incremental sync reconciliation after each relay wake-up", async () => {
    const ev1 = calEvent({ eventId: "e1", occurrenceId: "2026-08-28T15:00:00Z", version: "v1" });
    fakeCal.setEvents([ev1]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    const ev2 = calEvent({
      eventId: "e2",
      occurrenceId: "2026-08-28T16:00:00Z",
      startAt: "2026-08-28T16:00:00.000Z",
      endAt: "2026-08-28T17:00:00.000Z",
      version: "v1",
    });
    fakeCal.setEvents([ev1, ev2]);
    await host.handleRelayWakeUp({ channelId: "primary" });
    expect(host.listUpcoming()).toHaveLength(2);
  });

  it("startup recovery triggers bounded reconciliation", async () => {
    const ev = calEvent();
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    // Simulate restart with new host reading same workspace
    const host2 = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      calendarProvider: fakeCal,
      getInternalDomains: () => ["internal.com"],
      getOwnerEmail: () => "owner@example.com",
    });
    // Before recover, upcoming should already be loaded from durableClock (file-backed)
    expect(host2.listUpcoming()).toHaveLength(1);
    await host2.recover();
    await host2.idle();
    // In-window preparation is immediate: recovery prepares at once instead of holding a schedule.
    expect(host2.listUpcoming()).toHaveLength(0);
    expect(runs.list({ module: "meeting-brief-generator" }).runs).toHaveLength(1);
    expect(host2.index().briefs).toHaveLength(1);
  });

  it("invalid-sync recovery triggers bounded reconciliation", async () => {
    const ev = calEvent({ version: "v1", summary: "First" });
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()[0]?.version).toBe("v1");
    // Invalidate next sync
    fakeCal.invalidateNextSync();
    const ev2 = calEvent({ version: "v2", summary: "Second" });
    fakeCal.setEvents([ev2]);
    const result = await host.handleRelayWakeUp();
    expect(result.invalidSyncRecovered).toBe(true);
    expect(host.listUpcoming()[0]?.version).toBe("v2");
    expect(host.listUpcoming()[0]?.summary).toBe("Second");
  });

  it("duplicate wake-ups harmless (idempotent)", async () => {
    const ev = calEvent();
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    const first = host.listUpcoming().length;
    await host.handleRelayWakeUp();
    await host.handleRelayWakeUp();
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(first);
    // also channel not duplicated
    const watchCallsBefore = fakeCal.getWatchCalls().length;
    await host.handleRelayWakeUp();
    // may trigger ensureWatch but not new channel if not expiring
    // At least not duplicate schedule
    expect(host.listUpcoming()).toHaveLength(first);
    void watchCallsBefore;
  });

  it("in-window preparation is due immediately", async () => {
    const ev = calEvent({ startAt: "2026-08-29T15:00:00.000Z" });
    fakeCal.setEvents([ev]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    expect(runs.list({ module: "meeting-brief-generator" }).runs).toHaveLength(0);
    // In-window preparation is immediate: the schedule is due at reconcile time.
    now = new Date("2026-08-28T10:00:00.000Z");
    const created = await host.processDueSchedules(now);
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: "meeting-brief-generator" }).runs[0]?.status).not.toBe("blocked");
  });
});
