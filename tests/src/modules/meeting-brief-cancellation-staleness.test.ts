import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import { openRuns } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import {
  FakeCalendarProvider,
  type CalendarEvent,
} from "../../../apps/server/src/modules/meeting-brief-generator/calendar";
import { FakeGmailDeliveryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmailDelivery";
import type { MeetingBriefGeneratorOptions } from "../../../apps/server/src/modules/meeting-brief-generator/generator";

/**
 * Late cancellation marks the day/week briefings stale (issue #162 AC1).
 *
 * The gap: the reconcile snapshot only fingerprinted
 * id/startAt/title/occurrenceKey, so a cancellation landing after its Intake
 * schedule was consumed changed neither snapshot and never touched the
 * briefings. The build functions also listed cancelled meetings, so even a
 * regen kept serving them.
 */

const MONDAY = new Date("2026-08-31T12:00:00.000Z");

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "cal_primary",
    eventId: "evt_cancel_stale",
    occurrenceId: "2026-08-31T14:00:00Z",
    version: "v1",
    summary: "Acme negotiation",
    startAt: "2026-08-31T14:00:00.000Z",
    endAt: "2026-08-31T15:00:00.000Z",
    attendees: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
    ],
    ...overrides,
    status: overrides.status ?? "confirmed",
  };
}

function calFromFixture(f: MeetingBriefEvent): CalendarEvent {
  return {
    calendarId: f.calendarId,
    eventId: f.eventId,
    occurrenceId: f.occurrenceId,
    version: f.version,
    summary: f.summary,
    ...(f.description !== undefined ? { description: f.description } : {}),
    startAt: f.startAt,
    endAt: f.endAt,
    location: f.location ?? null,
    conferenceLink: f.conferenceLink ?? null,
    ...(f.organizer !== undefined ? { organizer: f.organizer } : {}),
    attendees: f.attendees,
    status: f.status,
    ...(f.attachments !== undefined ? { attachments: f.attachments } : {}),
  };
}

function defaultEnrich(): MeetingBriefGeneratorOptions["enrich"] {
  return async (_input, ctx) => {
    ctx.event("fixture_enrich", {});
    return {
      sections: [
        {
          source: "gmail",
          guest: "alice@external.co",
          status: "completed",
          evidence: ["e"],
          references: ["https://example.com"],
        },
      ],
      evidence: ["e"],
    };
  };
}

function defaultCompleteBrief(nowRef: () => Date): MeetingBriefGeneratorOptions["completeBrief"] {
  return async (input: MeetingBriefEvent) => {
    return {
      version: 1 as const,
      eventId: input.eventId,
      occurrenceId: input.occurrenceId,
      eventVersion: input.version,
      generatedAt: new Date(nowRef()).toISOString(),
      logistics: {
        title: input.summary,
        startAt: input.startAt,
        endAt: input.endAt,
        location: input.location ?? null,
        conferenceLink: input.conferenceLink ?? null,
        organizer: input.organizer
          ? { email: input.organizer.email, displayName: input.organizer.displayName }
          : null,
      },
      summary: `Brief for ${input.summary}`,
      guests: [
        {
          email: "alice@external.co",
          name: "Alice",
          role: "CTO",
          background: "bg",
          relationshipHistory: [],
          crmContext: null,
          talkingPoints: [],
          uncertainty: [],
          evidenceReferences: [],
        },
      ],
      companies: [],
      conversationStarters: ["starter 1", "starter 2"],
      sourceReferences: [],
      missingEvidence: [],
      uncertainty: [],
    } as never;
  };
}

interface CancelStaleHarness {
  host: MeetingBriefHost;
  fakeCal: FakeCalendarProvider;
  getNow: () => Date;
  setNow: (d: Date) => void;
}

function makeHost(): CancelStaleHarness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "mb-cancel-stale-"));
  const runs = openRuns(workspaceDir);
  let now = new Date(MONDAY);
  const fakeCal = new FakeCalendarProvider();
  const fakeGmail = new FakeGmailDeliveryProvider({
    ownerEmail: "owner@example.com",
    mode: "normal",
  });
  const host = new MeetingBriefHost({
    runs,
    workspaceDir,
    now: () => new Date(now),
    log: () => {},
    calendarProvider: fakeCal,
    calendarUse: "recheck",
    gmailDeliveryProvider: fakeGmail,
    getOwnerEmail: () => "owner@example.com",
    getTimezone: () => "UTC",
    enrich: defaultEnrich(),
    completeBrief: defaultCompleteBrief(() => now),
  });
  return {
    host,
    fakeCal,
    getNow: () => new Date(now),
    setNow: (d: Date) => {
      now = new Date(d);
    },
  };
}

async function seedFreshBriefings(ctx: CancelStaleHarness) {
  const { host, fakeCal, getNow } = ctx;
  fakeCal.setEvents([calFromFixture(fixtureEvent())]);
  await host.reconcileCalendar();
  await host.processDueSchedules(getNow());
  await host.idle();
  const daily = host.refreshDailyBriefing(getNow(), "UTC");
  const weekly = host.refreshWeeklyBriefing(getNow(), "UTC");
  expect(daily.stale).toBe(false);
  expect(daily.briefing?.meetings).toHaveLength(1);
  expect(weekly.stale).toBe(false);
  expect(weekly.briefing?.meetings).toHaveLength(1);
}

describe("late cancellation marks briefings stale (issue #162 AC1)", () => {
  it("serves the previous briefing stale right after the cancel reconcile", async () => {
    const ctx = makeHost();
    const { host, fakeCal, getNow } = ctx;
    fakeCal.setEvents([calFromFixture(fixtureEvent())]);
    await host.reconcileCalendar();
    host.refreshDailyBriefing(getNow(), "UTC");
    host.refreshWeeklyBriefing(getNow(), "UTC");

    // A no-op tick changes nothing: the routine full sync cannot keep the
    // briefings permanently stale.
    await host.reconcileCalendar();
    expect(host.getDailyBriefing(getNow(), "UTC").stale).toBe(false);
    expect(host.getWeeklyBriefing(getNow(), "UTC").stale).toBe(false);

    // Consume the Intake schedule, then re-baseline fresh: the only
    // remaining fingerprint that can observe the cancellation is the
    // meetings snapshot — the pre-fix tuple missed it entirely.
    await host.processDueSchedules(getNow());
    await host.idle();
    const freshDaily = host.refreshDailyBriefing(getNow(), "UTC");
    const freshWeekly = host.refreshWeeklyBriefing(getNow(), "UTC");
    expect(freshDaily.briefing?.meetings).toHaveLength(1);
    expect(freshWeekly.briefing?.meetings).toHaveLength(1);

    fakeCal.setEvents([calFromFixture(fixtureEvent({ status: "cancelled", version: "v2" }))]);
    await host.reconcileCalendar();

    const daily = host.getDailyBriefing(getNow(), "UTC");
    expect(daily.stale).toBe(true);
    expect(daily.briefing?.meetings.map((m) => m.title)).toEqual(["Acme negotiation"]);
    const weekly = host.getWeeklyBriefing(getNow(), "UTC");
    expect(weekly.stale).toBe(true);
    expect(weekly.briefing?.meetings.map((m) => m.title)).toEqual(["Acme negotiation"]);
  });

  it("quiet-expiry regen drops the cancelled meeting without any read in between", async () => {
    const ctx = makeHost();
    const { host, fakeCal, getNow, setNow } = ctx;
    await seedFreshBriefings(ctx);

    fakeCal.setEvents([calFromFixture(fixtureEvent({ status: "cancelled", version: "v2" }))]);
    await host.reconcileCalendar();

    // No getter runs here: only a reconcile-time touch lets the maintenance
    // tick fire the one coalesced rebuild. The derivation fallback in the
    // getters never runs, so without the snapshot fix the tick rebuilds
    // nothing and the cancelled meeting keeps serving.
    setNow(new Date(getNow().getTime() + 16 * 60 * 1000));
    await host.maintenanceTick(getNow());

    const daily = host.getDailyBriefing(getNow(), "UTC");
    expect(daily.stale).toBe(false);
    expect(daily.briefing).toBeNull();
    const weekly = host.getWeeklyBriefing(getNow(), "UTC");
    expect(weekly.stale).toBe(false);
    expect(weekly.briefing).toBeNull();
  });
});
