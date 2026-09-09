/* oxlint-disable */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEETING_BRIEF_MODULE_ID,
  type MeetingBriefEvent,
  type MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import { openRuns } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import {
  FakeCalendarProvider,
  type CalendarEvent,
} from "../../../apps/server/src/modules/meeting-brief-generator/calendar";
import {
  FakeGmailDeliveryProvider,
  type GmailDeliveryProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/google/gmailDelivery";
import { deliveryIdFor } from "../../../apps/server/src/modules/meeting-brief-generator/deliver";
import type { MeetingBriefGeneratorOptions } from "../../../apps/server/src/modules/meeting-brief-generator/generator";

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "cal_primary",
    eventId: "evt_quiet_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Quiet period meeting",
    startAt: "2026-08-28T15:00:00.000Z",
    endAt: "2026-08-28T15:30:00.000Z",
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
    status: "confirmed",
    ...(f.attachments !== undefined ? { attachments: f.attachments } : {}),
  };
}

function defaultEnrich(): MeetingBriefGeneratorOptions["enrich"] {
  return async (_input: any, ctx: any) => {
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
    } as any;
  };
}

function makeHostWithFakeTime(
  initialNow: Date,
  opts: { gmailMode?: any; fakeCal?: FakeCalendarProvider } = {},
) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "mbq-"));
  const runs = openRuns(workspaceDir);
  let now = new Date(initialNow);
  const fakeCal = opts.fakeCal ?? new FakeCalendarProvider();
  const fakeGmail = new FakeGmailDeliveryProvider({
    ownerEmail: "owner@example.com",
    mode: opts.gmailMode ?? "normal",
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
    enrich: defaultEnrich(),
    completeBrief: defaultCompleteBrief(() => now),
  });
  const getNow = () => new Date(now);
  const setNow = (d: Date) => {
    now = new Date(d);
  };
  const advance = async (ms: number) => {
    now = new Date(now.getTime() + ms);
    await host.recover();
    await host.idle();
    await host.processDueSchedules(new Date(now));
    await host.idle();
    await host.recover();
    await host.idle();
  };
  return { workspaceDir, runs, fakeCal, fakeGmail, host, getNow, setNow, advance };
}

describe("Quiet period — initial immediate; revisions 5-min quiet via Runner wait", () => {
  it("fails deliver without sending when the immediate Calendar recheck is unavailable", async () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    const fakeCal = new FakeCalendarProvider();
    fakeCal.listEvents = async () => {
      throw new Error("Calendar unavailable during delivery recheck");
    };
    const { host, runs, fakeGmail } = makeHostWithFakeTime(now, { fakeCal });
    const event = fixtureEvent();

    host.scheduleOccurrence(event, now);
    const [runId] = await host.processDueSchedules(now);
    await host.idle();

    expect(runs.detail(runId!)?.status).toBe("failed");
    expect(runs.detail(runId!)?.failedStage).toBe("deliver");
    expect((runs.detail(runId!)?.result as MeetingBriefRunResult).delivery.status).toBe("failed");
    expect(fakeGmail.messages).toHaveLength(0);
  });

  it("skips delivery when the occurrence disappeared before the outward write", async () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    const fakeCal = new FakeCalendarProvider();
    const { host, runs, fakeGmail } = makeHostWithFakeTime(now, { fakeCal });
    const event = fixtureEvent();
    // Genuine deletion: the calendar still lists other events, but this occurrence is
    // gone. Absence within a non-empty read is evidence — delivery skips terminally.
    const bystander = fixtureEvent({
      eventId: "evt_bystander",
      summary: "Unrelated meeting",
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
        { email: "bob@external.co", displayName: "Bob", responseStatus: "accepted" },
      ],
    });
    fakeCal.setEvents([calFromFixture(event), calFromFixture(bystander)]);
    fakeCal.removeOccurrence(event.eventId, event.occurrenceId);
    host.scheduleOccurrence(event, now);
    const [runId] = await host.processDueSchedules(now);
    await host.idle();

    expect(runs.detail(runId!)?.status).toBe("skipped");
    expect((runs.detail(runId!)?.result as MeetingBriefRunResult).delivery.status).toBe("skipped");
    expect(fakeGmail.messages).toHaveLength(0);
  });
  it("fails deliver retryably when Calendar transiently returns an empty list, never terminal skip", async () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    const { host, runs, fakeCal, fakeGmail } = makeHostWithFakeTime(now);
    const event = fixtureEvent();
    fakeCal.setEvents([calFromFixture(event)]);
    // A transient empty read (e.g. a sync hiccup) at the deliver recheck carries no
    // evidence about the occurrence: it must fail the deliver Stage — Brief preserved,
    // retryable — not terminally skip a valid delivery.
    const realListEvents = fakeCal.listEvents.bind(fakeCal);
    let reads = 0;
    fakeCal.listEvents = async (args: { calendarId: string; syncToken?: string | null }) => {
      reads += 1;
      if (reads >= 2) return { events: [], nextSyncToken: null };
      return realListEvents(args);
    };

    host.scheduleOccurrence(event, now);
    const [runId] = await host.processDueSchedules(now);
    await host.idle();

    const detail = runs.detail(runId!);
    expect(detail?.status).toBe("failed");
    expect(detail?.failedStage).toBe("deliver");
    expect((detail?.result as MeetingBriefRunResult).delivery.status).toBe("failed");
    expect(fakeGmail.messages).toHaveLength(0);
  });

  it("fails deliver without sending when Gmail reconciliation is unavailable", async () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    const fakeCal = new FakeCalendarProvider();
    const event = fixtureEvent();
    fakeCal.setEvents([calFromFixture(event)]);
    let sends = 0;
    const gmail: GmailDeliveryProvider = {
      async findByDeliveryId() {
        throw new Error("Gmail reconciliation unavailable");
      },
      async send() {
        sends += 1;
        return { messageId: "should-not-send", recipient: "owner@example.com" };
      },
    };
    const workspaceDir = mkdtempSync(join(tmpdir(), "mbq-reconcile-"));
    const runs = openRuns(workspaceDir);
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => now,
      calendarProvider: fakeCal,
      gmailDeliveryProvider: gmail,
      getOwnerEmail: () => "owner@example.com",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(() => now),
    });

    host.scheduleOccurrence(event, now);
    const [runId] = await host.processDueSchedules(now);
    await host.idle();

    expect(runs.detail(runId!)?.status).toBe("failed");
    expect(runs.detail(runId!)?.failedStage).toBe("deliver");
    expect((runs.detail(runId!)?.result as MeetingBriefRunResult).delivery.status).toBe("failed");
    expect(sends).toBe(0);
  });

  it("fails deliver instead of manufacturing a sent message when no Output Adapter exists", async () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    const fakeCal = new FakeCalendarProvider();
    const event = fixtureEvent();
    fakeCal.setEvents([calFromFixture(event)]);
    const workspaceDir = mkdtempSync(join(tmpdir(), "mbq-no-output-"));
    const runs = openRuns(workspaceDir);
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => now,
      calendarProvider: fakeCal,
      getOwnerEmail: () => "owner@example.com",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(() => now),
    });

    host.scheduleOccurrence(event, now);
    const [runId] = await host.processDueSchedules(now);
    await host.idle();

    const detail = runs.detail(runId!);
    expect(detail?.status).toBe("failed");
    expect(detail?.failedStage).toBe("deliver");
    expect((detail?.result as MeetingBriefRunResult).delivery.status).toBe("failed");
  });

  it("initial brief sends immediately (no wait); revision waits 5min after latest material change", async () => {
    const startFar = new Date("2026-08-28T15:00:00.000Z");
    const nowInit = new Date("2026-08-28T10:00:00.000Z");
    const { host, runs, fakeCal, fakeGmail, getNow, advance } = makeHostWithFakeTime(nowInit);
    const v1 = fixtureEvent({
      version: "v1",
      summary: "Initial",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    expect(created).toHaveLength(1);
    await host.idle();
    const run1Id = created[0] as string;
    const d1 = runs.detail(run1Id)!;
    expect(d1.status).toBe("done");
    expect((d1.result as MeetingBriefRunResult).delivery.status).toBe("sent");
    expect(fakeGmail.messages).toHaveLength(1);
    expect(fakeGmail.messages[0]!.subject).toBe("Meeting Brief: Initial");
    expect((d1.result as MeetingBriefRunResult).eventVersion).toBe("v1");

    const v2 = fixtureEvent({
      version: "v2",
      summary: "Revised title",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    expect(created).toHaveLength(1);
    await host.idle();
    const run2Id = created[0] as string;
    const meta2 = runs.open(run2Id)!.read();
    expect(meta2.status).toBe("blocked");
    expect(meta2.wait?.reason).toBe("quiet_period");
    const waitTimeout = meta2.wait?.timeout;
    if (!waitTimeout || waitTimeout.kind !== "at") throw new Error("expected at timeout");
    const waitAt = Date.parse(waitTimeout.at);
    const expectedAt = getNow().getTime() + 5 * 60 * 1000;
    expect(Math.abs(waitAt - expectedAt)).toBeLessThan(1000);
    expect(fakeGmail.messages).toHaveLength(1);
    const deliveryPending = JSON.parse(runs.open(run2Id)!.readArtifact("delivery.json")!);
    expect(deliveryPending.status).toBe("pending");

    await advance(5 * 60 * 1000 + 1000);
    const d2 = runs.detail(run2Id)!;
    expect(d2.status).toBe("done");
    expect((d2.result as MeetingBriefRunResult).delivery.status).toBe("sent");
    expect(fakeGmail.messages).toHaveLength(2);
    expect(fakeGmail.messages[1]!.subject).toBe("Updated Meeting Brief: Revised title");
    expect((d2.result as MeetingBriefRunResult).eventVersion).toBe("v2");
    expect((d2.result as MeetingBriefRunResult).supersedes).toBe(run1Id);
    const deliveryId = deliveryIdFor("evt_quiet_1::2026-08-28T15:00:00Z", "v2");
    expect((d2.result as MeetingBriefRunResult).delivery.deliveryId).toBe(deliveryId);
  });

  it("every newer version resets effective quiet period and marks older revision delivery as superseded without email", async () => {
    const nowInit = new Date("2026-08-28T10:00:00.000Z");
    const { host, runs, fakeCal, fakeGmail, getNow, advance } = makeHostWithFakeTime(nowInit);
    const v1 = fixtureEvent({ version: "v1", summary: "V1" });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    const run1Id = created[0] as string;

    const v2 = fixtureEvent({ version: "v2", summary: "V2" });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    const run2Id = created[0] as string;
    expect(runs.open(run2Id)!.read().status).toBe("blocked");
    expect(fakeGmail.messages).toHaveLength(1);

    await advance(2 * 60 * 1000);
    expect(runs.open(run2Id)!.read().status).toBe("blocked");
    const v3 = fixtureEvent({ version: "v3", summary: "V3" });
    fakeCal.setEvents([calFromFixture(v3)]);
    host.scheduleOccurrence(v3, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    expect(created).toHaveLength(1);
    await host.idle();
    const run3Id = created[0] as string;
    expect(runs.open(run3Id)!.read().status).toBe("blocked");

    await advance(3 * 60 * 1000 + 1000);
    const d2 = runs.detail(run2Id)!;
    expect(d2.status).toBe("done");
    expect((d2.result as MeetingBriefRunResult).delivery.status).toBe("superseded");
    expect(fakeGmail.messages).toHaveLength(1);
    const events2 = runs.detail(run2Id)!.events;
    const hasSuperseded = events2.some(
      (e) => e.type === "delivery_superseded" || e.type === "brief_superseded",
    );
    expect(hasSuperseded).toBe(true);
    expect(runs.open(run3Id)!.read().status).toBe("blocked");
    expect(fakeGmail.messages).toHaveLength(1);
    await advance(2 * 60 * 1000 + 1000);
    const d3 = runs.detail(run3Id)!;
    expect(d3.status).toBe("done");
    expect((d3.result as MeetingBriefRunResult).delivery.status).toBe("sent");
    expect(fakeGmail.messages).toHaveLength(2);
    expect(fakeGmail.messages[1]!.subject).toContain("Updated Meeting Brief");
    expect((d3.result as MeetingBriefRunResult).eventVersion).toBe("v3");
    expect((d3.result as MeetingBriefRunResult).supersedes).toBe(run2Id);
    const d2again = runs.detail(run2Id)!;
    expect((d2again.result as MeetingBriefRunResult).supersedes).toBe(run1Id);
  });

  it("two rapid versions collapse to latest (schedule overwrites before processing)", async () => {
    const { host, runs, fakeCal, fakeGmail, getNow, advance } = makeHostWithFakeTime(
      new Date("2026-08-28T10:00:00.000Z"),
    );
    const v1 = fixtureEvent({ version: "v1", summary: "V1" });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    const run1Id = created[0] as string;
    const v2 = fixtureEvent({ version: "v2", summary: "V2" });
    const v3 = fixtureEvent({ version: "v3", summary: "V3" });
    host.scheduleOccurrence(v2, new Date(getNow()));
    host.scheduleOccurrence(v3, new Date(getNow()));
    fakeCal.setEvents([calFromFixture(v3)]);
    created = await host.processDueSchedules(new Date(getNow()));
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(2);
    const runId = created[0] as string;
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("blocked");
    expect(fakeGmail.messages).toHaveLength(1);
    await advance(5 * 60 * 1000 + 1000);
    const done = runs.detail(runId)!;
    expect(done.status).toBe("done");
    expect((done.result as MeetingBriefRunResult).eventVersion).toBe("v3");
    expect((done.result as MeetingBriefRunResult).supersedes).toBe(run1Id);
    expect(fakeGmail.messages).toHaveLength(2);
  });

  it("resume rechecks current revision and eligibility; imminent start bypasses remaining wait", async () => {
    const nearStart = new Date("2026-08-28T10:04:00.000Z");
    const nowInit = new Date("2026-08-28T10:00:00.000Z");
    const { host, runs, fakeCal, fakeGmail, getNow } = makeHostWithFakeTime(nowInit);
    const v1 = fixtureEvent({
      version: "v1",
      summary: "V1",
      startAt: new Date("2026-08-28T15:00:00.000Z").toISOString(),
      endAt: new Date("2026-08-28T15:30:00.000Z").toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    expect(
      (runs.detail(created[0] as string)!.result as MeetingBriefRunResult).delivery.status,
    ).toBe("sent");
    expect(fakeGmail.messages).toHaveLength(1);
    const v2 = fixtureEvent({
      version: "v2",
      summary: "V2 imminent",
      startAt: nearStart.toISOString(),
      endAt: new Date(nearStart.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    const run2Id = created[0] as string;
    const d2 = runs.detail(run2Id)!;
    expect(d2.status).toBe("done");
    expect((d2.result as MeetingBriefRunResult).delivery.status).toBe("sent");
    expect(fakeGmail.messages).toHaveLength(2);
    expect(fakeGmail.messages[1]!.subject).toContain("Updated Meeting Brief");
    const hasWait = d2.events.some(
      (e) => e.type === "run_blocked" && (e.detail as any)?.reason === "quiet_period",
    );
    expect(hasWait).toBe(false);
  });
  it("quiet wait arms from the current Calendar start, not the snapshot-frozen start, when the event moves mid-Run", async () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    const startFar = new Date("2026-08-28T20:00:00.000Z");
    const fakeCal = new FakeCalendarProvider();
    const fakeGmail = new FakeGmailDeliveryProvider({ ownerEmail: "owner@example.com" });
    const workspaceDir = mkdtempSync(join(tmpdir(), "mbq-midrun-"));
    const runs = openRuns(workspaceDir);
    const baseEnrich = defaultEnrich();
    let enrichCalls = 0;
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => now,
      log: () => {},
      calendarProvider: fakeCal,
      calendarUse: "recheck",
      gmailDeliveryProvider: fakeGmail,
      getOwnerEmail: () => "owner@example.com",
      enrich: async (input, ctx) => {
        enrichCalls += 1;
        if (enrichCalls === 2) {
          // A Calendar move lands while v2 is mid-Run (wake-up not yet reconciled):
          // the meeting now starts in three minutes, but v2's frozen snapshot start
          // is still 20:00. The quiet gate must consult Calendar, not the snapshot.
          fakeCal.setEvents([
            calFromFixture(
              fixtureEvent({
                version: "v3",
                summary: "Moved into window",
                startAt: new Date("2026-08-28T10:03:00.000Z").toISOString(),
                endAt: new Date("2026-08-28T10:33:00.000Z").toISOString(),
              }),
            ),
          ]);
        }
        return baseEnrich!(input, ctx);
      },
      completeBrief: defaultCompleteBrief(() => now),
    });

    const v1 = fixtureEvent({
      version: "v1",
      summary: "Initial",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, now);
    const created1 = await host.processDueSchedules(now);
    await host.idle();
    expect(
      (runs.detail(created1[0] as string)!.result as MeetingBriefRunResult).delivery.status,
    ).toBe("sent");

    const v2 = fixtureEvent({
      version: "v2",
      summary: "Revised title",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, now);
    const created2 = await host.processDueSchedules(now);
    await host.idle();

    // v2 is already obsolete (Calendar moved past it mid-Run), so it must not park
    // on a doomed five-minute quiet wait: it ends superseded immediately, no email.
    const d2 = runs.detail(created2[0] as string)!;
    expect(d2.status).toBe("done");
    expect((d2.result as MeetingBriefRunResult).delivery.status).toBe("superseded");
    const hasQuietWait = d2.events.some((e) => {
      if (e.type !== "run_blocked") return false;
      const detail: unknown = e.detail;
      return (
        typeof detail === "object" &&
        detail !== null &&
        "reason" in detail &&
        detail.reason === "quiet_period"
      );
    });
    expect(hasQuietWait).toBe(false);
    expect(fakeGmail.messages).toHaveLength(1);
  });
  it("cancellation marks revision as skipped (not superseded) and preserves completed history", async () => {
    const startFar = new Date("2026-08-28T15:00:00.000Z");
    const nowInit = new Date("2026-08-28T10:00:00.000Z");
    const { host, runs, fakeCal, fakeGmail, advance, getNow } = makeHostWithFakeTime(nowInit);
    const v1 = fixtureEvent({
      version: "v1",
      summary: "V1",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    const run1Id = created[0] as string;
    expect(runs.detail(run1Id)!.status).toBe("done");
    const v2 = fixtureEvent({
      version: "v2",
      summary: "V2",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    const run2Id = created[0] as string;
    await host.idle();
    expect(runs.open(run2Id)!.read().status).toBe("blocked");
    fakeCal.setEvents([{ ...calFromFixture(v2), status: "cancelled" } as any]);
    await advance(5 * 60 * 1000 + 1000);
    const d2 = runs.detail(run2Id)!;
    expect(d2.status).toBe("skipped");
    const delivery = JSON.parse(runs.open(run2Id)!.readArtifact("delivery.json")!);
    expect(delivery.status).toBe("skipped");
    expect(fakeGmail.messages).toHaveLength(1);
    expect(runs.detail(run1Id)!.status).toBe("done");
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(2);
    expect(host.index().cancellations).toEqual([
      expect.objectContaining({ occurrenceKey: `${v2.eventId}::${v2.occurrenceId}` }),
    ]);
  });

  it("supersession older Run remains readable but records why no email sent", async () => {
    const startFar = new Date("2026-08-28T15:00:00.000Z");
    const nowInit = new Date("2026-08-28T10:00:00.000Z");
    const { host, runs, fakeCal, advance, getNow } = makeHostWithFakeTime(nowInit);
    const v1 = fixtureEvent({ version: "v1" });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    void created[0];
    const v2 = fixtureEvent({
      version: "v2",
      summary: "V2",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    const run2Id = created[0] as string;
    await host.idle();
    const v3 = fixtureEvent({
      version: "v3",
      summary: "V3",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    // Advance past the quiet wait before introducing the revision: under
    // immediate preparation a reconcile during the advance would already
    // prepare v3, leaving nothing for the manual schedule below.
    await advance(2 * 60 * 1000);
    fakeCal.setEvents([calFromFixture(v3)]);
    host.scheduleOccurrence(v3, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    const run3Id = created[0] as string;
    await host.idle();
    await advance(3 * 60 * 1000 + 1000);
    const d2 = runs.detail(run2Id)!;
    expect(d2.status).toBe("done");
    expect((d2.result as MeetingBriefRunResult).delivery.status).toBe("superseded");
    const deliveryRaw = runs.open(run2Id)!.readArtifact("delivery.json")!;
    const deliveryJson = JSON.parse(deliveryRaw);
    expect(deliveryJson.supersededReason).toBe("obsolete_revision");
    expect(deliveryJson.currentVersion).toBe("v3");
    expect(runs.open(run2Id)!.readArtifact("snapshot.json")).toBeTruthy();
    expect(runs.open(run2Id)!.readArtifact("result.json")).toBeTruthy();
    expect(runs.open(run2Id)!.readArtifact("delivery.json")).toBeTruthy();
    await advance(2 * 60 * 1000 + 1000);
    const d3 = runs.detail(run3Id)!;
    expect(d3.status).toBe("done");
    expect((d3.result as MeetingBriefRunResult).delivery.status).toBe("sent");
  });

  it("restart (DurableClock + Runs recovery) — blocked wait survives restart and resumes correctly", async () => {
    const startFar = new Date("2026-08-28T15:00:00.000Z");
    const nowInit = new Date("2026-08-28T10:00:00.000Z");
    const { workspaceDir, runs, fakeCal, fakeGmail, host, getNow, setNow } =
      makeHostWithFakeTime(nowInit);
    const v1 = fixtureEvent({ version: "v1" });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    expect(fakeGmail.messages).toHaveLength(1);
    const v2 = fixtureEvent({
      version: "v2",
      summary: "V2",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    const run2Id = created[0] as string;
    expect(runs.open(run2Id)!.read().status).toBe("blocked");
    const blockedMetaBefore = runs.open(run2Id)!.read();
    const waitTimeoutBefore = blockedMetaBefore.wait?.timeout;
    if (!waitTimeoutBefore || waitTimeoutBefore.kind !== "at") throw new Error("expected at");
    const waitAt = waitTimeoutBefore.at;
    let now = getNow();
    now = new Date(now.getTime() + 1 * 60 * 1000);
    setNow(now);
    const host2 = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      calendarProvider: fakeCal,
      gmailDeliveryProvider: fakeGmail,
      getOwnerEmail: () => "owner@example.com",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(() => now),
    });
    await host2.recover();
    await host2.idle();
    expect(runs.open(run2Id)!.read().status).toBe("blocked");
    const waitAfter = runs.open(run2Id)!.read().wait?.timeout;
    if (!waitAfter || waitAfter.kind !== "at") throw new Error("expected at");
    expect(waitAfter.at).toBe(waitAt);
    now = new Date(Date.parse(waitAt) + 1000);
    await host2.recover();
    await host2.idle();
    const d2 = runs.detail(run2Id)!;
    expect(d2.status).toBe("done");
    expect((d2.result as MeetingBriefRunResult).delivery.status).toBe("sent");
    expect(fakeGmail.messages).toHaveLength(2);
    expect(fakeGmail.messages[1]!.subject).toContain("Updated Meeting Brief");
    let futureNow = new Date("2026-08-28T09:00:00.000Z");
    const hostA = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(futureNow),
      log: () => {},
      calendarProvider: fakeCal,
      gmailDeliveryProvider: fakeGmail,
      getOwnerEmail: () => "owner@example.com",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(() => futureNow),
    });
    const futureEvent = fixtureEvent({
      eventId: "evt_future",
      occurrenceId: "2026-08-29T15:00:00Z",
      version: "v1",
      startAt: new Date("2026-08-29T15:00:00.000Z").toISOString(),
      endAt: new Date("2026-08-29T15:30:00.000Z").toISOString(),
    });
    fakeCal.setEvents([calFromFixture(futureEvent), calFromFixture(v2), calFromFixture(v1)]);
    hostA.scheduleOccurrence(futureEvent, new Date("2026-08-29T11:00:00.000Z"));
    expect(hostA.listUpcoming().length).toBeGreaterThanOrEqual(1);
    const hostB = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(futureNow),
      log: () => {},
      calendarProvider: fakeCal,
      gmailDeliveryProvider: fakeGmail,
      getOwnerEmail: () => "owner@example.com",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(() => futureNow),
    });
    expect(hostB.listUpcoming().length).toBe(hostA.listUpcoming().length);
    futureNow = new Date("2026-08-29T11:00:00.000Z");
    const createdFuture = await hostB.processDueSchedules(new Date(futureNow));
    expect(createdFuture.length).toBeGreaterThanOrEqual(1);
    await hostB.idle();
  });

  it("duplicate wake-ups are harmless (no duplicate Runs, no duplicate emails)", async () => {
    const { host, runs, fakeCal, fakeGmail, getNow, advance } = makeHostWithFakeTime(
      new Date("2026-08-28T10:00:00.000Z"),
    );
    const v1 = fixtureEvent({ version: "v1" });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    expect(fakeGmail.messages).toHaveLength(1);
    void created[0];
    const v2 = fixtureEvent({ version: "v2", summary: "V2" });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    const run2Id = created[0] as string;
    expect(runs.open(run2Id)!.read().status).toBe("blocked");
    expect(fakeGmail.messages).toHaveLength(1);
    host.scheduleOccurrence(v2, new Date(getNow()));
    const dup = await host.processDueSchedules(new Date(getNow()));
    expect(dup).toHaveLength(0);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(2);
    expect(runs.open(run2Id)!.read().status).toBe("blocked");
    host.scheduleOccurrence(v2, new Date(getNow()));
    const dup2 = await host.processDueSchedules(new Date(getNow()));
    expect(dup2).toHaveLength(0);
    await advance(5 * 60 * 1000 + 1000);
    expect(fakeGmail.messages).toHaveLength(2);
    const d2 = runs.detail(run2Id)!;
    expect(d2.status).toBe("done");
    host.scheduleOccurrence(v2, new Date(getNow()));
    const dupAfterDone = await host.processDueSchedules(new Date(getNow()));
    expect(dupAfterDone).toHaveLength(0);
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(2);
  });

  it("permanent delivery failure preserves Meeting Brief, fails only deliver stage, retry still fails", async () => {
    const nowInit = new Date("2026-08-28T10:00:00.000Z");
    const workspaceDir = mkdtempSync(join(tmpdir(), "mbq-perm-"));
    const runs = openRuns(workspaceDir);
    let now = new Date(nowInit);
    const fakeCal = new FakeCalendarProvider();
    const fakeGmailPerm = new FakeGmailDeliveryProvider({
      ownerEmail: "owner@example.com",
      mode: "permanentFailure",
    });
    const v1 = fixtureEvent({ version: "v1", summary: "V1" });
    fakeCal.setEvents([calFromFixture(v1)]);
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      calendarProvider: fakeCal,
      gmailDeliveryProvider: fakeGmailPerm,
      getOwnerEmail: () => "owner@example.com",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(() => now),
    });
    host.scheduleOccurrence(v1, new Date(now));
    let created = await host.processDueSchedules(new Date(now));
    await host.idle();
    const runId = created[0] as string;
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("deliver");
    const resultRaw = runs.open(runId)!.readArtifact("result.json")!;
    const result = JSON.parse(resultRaw) as MeetingBriefRunResult;
    expect(result.meetingBrief).toBeDefined();
    expect(result.meetingBrief.eventVersion).toBe("v1");
    const deliveryRaw = runs.open(runId)!.readArtifact("delivery.json")!;
    const delivery = JSON.parse(deliveryRaw);
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBeGreaterThanOrEqual(1);
    expect(delivery.deliveryId).toBe(deliveryIdFor("evt_quiet_1::2026-08-28T15:00:00Z", "v1"));
    const beforeEnrich = runs.open(runId)!.readArtifact("enrich.json");
    await host.retryRun(runId);
    await host.idle();
    const after = runs.detail(runId)!;
    expect(after.status).toBe("failed");
    expect(after.failedStage).toBe("deliver");
    const afterResultRaw = runs.open(runId)!.readArtifact("result.json")!;
    const afterResult = JSON.parse(afterResultRaw) as MeetingBriefRunResult;
    expect(afterResult.meetingBrief.eventVersion).toBe("v1");
    const afterDeliveryRaw = runs.open(runId)!.readArtifact("delivery.json")!;
    const afterDelivery = JSON.parse(afterDeliveryRaw);
    expect(afterDelivery.status).toBe("failed");
    expect(afterDelivery.attempts).toBeGreaterThan(delivery.attempts);
    expect(runs.open(runId)!.readArtifact("enrich.json")).toBe(beforeEnrich);
  });

  it("delivered revisions labeled Updated Meeting Brief and retain revision and Gmail delivery identity (stable deliveryId, messageId)", async () => {
    const startFar = new Date("2026-08-28T15:00:00.000Z");
    const nowInit = new Date("2026-08-28T10:00:00.000Z");
    const { host, runs, fakeCal, fakeGmail, advance, getNow } = makeHostWithFakeTime(nowInit);
    const v1 = fixtureEvent({
      version: "v1",
      summary: "Initial",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v1)]);
    host.scheduleOccurrence(v1, new Date(getNow()));
    let created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    const d1 = runs.detail(created[0] as string)!;
    const m1 = fakeGmail.messages[0]!;
    expect(m1.subject).toBe("Meeting Brief: Initial");
    const deliveryId1 = (d1.result as MeetingBriefRunResult).delivery.deliveryId;
    expect(deliveryId1).toBe(deliveryIdFor("evt_quiet_1::2026-08-28T15:00:00Z", "v1"));
    const messageId1 = (d1.result as MeetingBriefRunResult).delivery.messageId;
    expect(messageId1).toBeTruthy();
    const v2 = fixtureEvent({
      version: "v2",
      summary: "Revised",
      startAt: startFar.toISOString(),
      endAt: new Date(startFar.getTime() + 30 * 60000).toISOString(),
    });
    fakeCal.setEvents([calFromFixture(v2)]);
    host.scheduleOccurrence(v2, new Date(getNow()));
    created = await host.processDueSchedules(new Date(getNow()));
    await host.idle();
    await advance(5 * 60 * 1000 + 1000);
    const run2Id = runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs.find((r) => {
      const d = runs.detail(r.id);
      return (d?.result as MeetingBriefRunResult)?.eventVersion === "v2";
    })!.id;
    const d2 = runs.detail(run2Id)!;
    const m2 = fakeGmail.messages[1]!;
    expect(m2.subject).toBe("Updated Meeting Brief: Revised");
    expect((d2.result as MeetingBriefRunResult).eventVersion).toBe("v2");
    expect((d2.result as MeetingBriefRunResult).delivery.deliveryId).toBe(
      deliveryIdFor("evt_quiet_1::2026-08-28T15:00:00Z", "v2"),
    );
    expect((d2.result as MeetingBriefRunResult).delivery.messageId).toBe(m2.messageId);
    expect((d2.result as MeetingBriefRunResult).delivery.messageId).not.toBe(messageId1);
    void fakeGmail;
    expect((d2.result as MeetingBriefRunResult).delivery.deliveryId).toBe(
      `mb-deliver-evt_quiet_1::2026-08-28T15:00:00Z-v2`,
    );
  });
});

describe("Calendar reads that look for one occurrence are bounded — issue #110", () => {
  it("sends a time window on every full read, so no Run pages the whole calendar", async () => {
    const now = new Date("2026-08-28T10:00:00.000Z");
    const fakeCal = new FakeCalendarProvider();
    const realListEvents = fakeCal.listEvents.bind(fakeCal);
    const calls: Array<{
      syncToken: string | null | undefined;
      timeMin: string | null | undefined;
      timeMax: string | null | undefined;
    }> = [];
    fakeCal.listEvents = async (args: {
      calendarId: string;
      syncToken?: string | null;
      timeMin?: string | null;
      timeMax?: string | null;
    }) => {
      calls.push({ syncToken: args.syncToken, timeMin: args.timeMin, timeMax: args.timeMax });
      return realListEvents(args);
    };
    const { host } = makeHostWithFakeTime(now, { fakeCal });
    const event = fixtureEvent();

    host.scheduleOccurrence(event, now);
    await host.processDueSchedules(now);
    await host.idle();

    // Both the snapshot freeze and the pre-send recheck are full reads.
    const fullReads = calls.filter((call) => !call.syncToken);
    expect(fullReads.length).toBeGreaterThanOrEqual(2);
    for (const read of fullReads) {
      expect(read.timeMin).toBeTruthy();
      expect(read.timeMax).toBeTruthy();
      // The window contains the occurrence it is looking for, and starts no
      // earlier than a day before now — never the beginning of the calendar.
      expect(Date.parse(read.timeMin!)).toBeLessThanOrEqual(Date.parse(event.startAt));
      expect(Date.parse(read.timeMax!)).toBeGreaterThanOrEqual(Date.parse(event.startAt));
      expect(Date.parse(read.timeMin!)).toBeGreaterThanOrEqual(
        now.getTime() - 24 * 60 * 60 * 1000 - 1,
      );
    }
  });
});
