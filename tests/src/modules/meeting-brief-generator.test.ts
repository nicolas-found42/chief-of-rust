import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MEETING_BRIEF_MODULE_ID,
  MEETING_BRIEF_MODULE_VERSION,
  MEETING_BRIEF_STAGES,
  type MeetingBrief,
  type MeetingBriefEvent,
  type MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { meetingBriefModule } from "../../../apps/server/src/modules/meeting-brief-generator/module";
import {
  FakeCalendarProvider,
  type CalendarProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/calendar";
import {
  completeFixtureBrief,
  fixtureGmailDeliveryProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/testRuntime";

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_fixture_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Fixture Sync with External Guest",
    description: "Discuss roadmap",
    startAt: new Date("2026-08-28T15:00:00.000Z").toISOString(),
    endAt: new Date("2026-08-28T16:00:00.000Z").toISOString(),
    location: "https://meet.example.com/abc",
    conferenceLink: "https://meet.example.com/abc",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      { email: "alice@external.co", displayName: "Alice External", responseStatus: "accepted" },
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
    ],
    attachments: [],
    ...overrides,
    status: overrides.status ?? "confirmed",
  };
}

let workspaceDir: string;
let runs: Runs;
let now: Date;
let host: MeetingBriefHost;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "mbf-"));
  runs = openRuns(workspaceDir);
  now = new Date("2026-08-28T09:00:00.000Z");

  let enrichCalls = 0;
  host = new MeetingBriefHost({
    runs,
    workspaceDir,
    now: () => new Date(now),
    log: () => {},
    enrich: async (_input, ctx) => {
      enrichCalls += 1;
      void enrichCalls;
      // Simulate bounded evidence: Gmail, Calendar, HubSpot, Profile, Drive, Search via fixture composite.
      ctx.event("fixture_enrich", { guest: "alice@external.co" });
      return {
        sections: [
          {
            source: "gmail",
            guest: "alice@external.co",
            status: "completed",
            evidence: ["gmail thread with alice"],
            references: ["https://mail.example.com/thread/1"],
          },
          {
            source: "hubspot",
            guest: "alice@external.co",
            status: "completed",
            evidence: ["hubspot company fixture"],
            references: ["https://hubspot.example.com/company/1"],
          },
        ],
        evidence: ["gmail thread with alice", "hubspot company fixture"],
      };
    },
    completeBrief: async (input): Promise<MeetingBrief> => {
      return {
        version: 1,
        eventId: input.eventId,
        occurrenceId: input.occurrenceId,
        eventVersion: input.version,
        generatedAt: new Date(now).toISOString(),
        logistics: {
          title: input.summary,
          startAt: input.startAt,
          endAt: input.endAt,
          location: input.location ?? null,
          conferenceLink: input.conferenceLink ?? null,
          organizer: input.organizer
            ? input.organizer.displayName !== undefined
              ? { email: input.organizer.email, displayName: input.organizer.displayName }
              : { email: input.organizer.email }
            : null,
        },
        summary: `Brief for ${input.summary}`,
        guests: [
          {
            email: "alice@external.co",
            name: "Alice External",
            role: "CTO at External Co",
            background: "Fixture background",
            relationshipHistory: ["Prior sync 2026-08-01"],
            crmContext: "HubSpot: deal open",
            talkingPoints: ["Talk about roadmap"],
            uncertainty: [],
            evidenceReferences: ["https://mail.example.com/thread/1"],
          },
        ],
        companies: [
          {
            name: "External Co",
            domain: "external.co",
            hubspotContext: "Open deal $50k",
            docs: ["Drive: External Co proposal"],
            news: ["External Co raised Series A"],
            industry: ["Industry news fixture"],
            uncertainty: [],
            evidenceReferences: ["https://mail.example.com/thread/1"],
          },
        ],
        conversationStarters: [
          "What prompted the roadmap shift?",
          "How does External Co measure success?",
        ],
        sourceReferences: ["https://mail.example.com/thread/1"],
        missingEvidence: [],
        uncertainty: [],
      };
    },
    gmailDeliveryProvider: fixtureGmailDeliveryProvider("fixture-msg-123"),
  });
});

describe("Meeting Brief Generator v1 — live Module contract", () => {
  it("exists as live with exactly 4 fixed Stages", () => {
    expect(MEETING_BRIEF_MODULE_ID).toBe("meeting-brief-generator");
    expect(MEETING_BRIEF_MODULE_VERSION).toBe(1);
    expect([...MEETING_BRIEF_STAGES]).toEqual(["snapshot", "enrich", "compose", "deliver"]);
    const mod = meetingBriefModule({ now: () => new Date(now) });
    expect(mod.id).toBe(MEETING_BRIEF_MODULE_ID);
    expect(mod.version).toBe(MEETING_BRIEF_MODULE_VERSION);
  });
});

describe("durable Intake schedule via host (Shell durable clock)", () => {
  it("upcoming holds a seeded fixture event without creating a blocked Run", () => {
    const event = fixtureEvent();
    const dueAt = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(event, dueAt);

    const upcoming = host.listUpcoming();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.occurrenceKey).toBe("evt_fixture_1::2026-08-28T15:00:00Z");
    expect(upcoming[0]?.dueAt).toBe(dueAt.toISOString());

    const runList = runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs;
    expect(runList).toHaveLength(0);

    // Also ensure index upcoming reflects it (Cross-Run index derived on read).
    const index = host.index();
    expect(index.upcoming).toHaveLength(1);
    expect(index.briefs).toHaveLength(0);
  });

  it("atomically replaces a schedule when the same occurrence is rescheduled", () => {
    const event = fixtureEvent({ version: "v1" });
    const firstDue = new Date("2026-08-28T11:00:00.000Z");
    const secondDue = new Date("2026-08-28T12:30:00.000Z");
    host.scheduleOccurrence(event, firstDue);
    host.scheduleOccurrence({ ...event, version: "v2" }, secondDue);

    const upcoming = host.listUpcoming();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.dueAt).toBe(secondDue.toISOString());
    expect(upcoming[0]?.version).toBe("v2");
  });
});

describe("fixture event → one Run at due time via real Runner/Runs/Workspace (no blocked future Run)", () => {
  it("does not write the owner-only Gmail output until the owner Profile is confirmed", async () => {
    let confirmed = false;
    let sends = 0;
    const gatedHost = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      enrich: async () => ({ sections: [], evidence: [] }),
      completeBrief: completeFixtureBrief,
      getOwnerEmail: () => "owner@example.com",
      isOwnerProfileConfirmed: () => confirmed,
      gmailDeliveryProvider: {
        findByDeliveryId: async () => null,
        send: async () => {
          sends += 1;
          return { messageId: "gated-message", recipient: "owner@example.com" };
        },
      },
    });
    gatedHost.scheduleOccurrence(fixtureEvent(), new Date(now));

    const [runId] = await gatedHost.processDueSchedules(new Date(now));
    await gatedHost.idle();

    expect(runs.detail(runId)?.failedStage).toBe("deliver");
    expect(sends).toBe(0);

    confirmed = true;
    await gatedHost.retryRun(runId);
    await gatedHost.idle();

    expect(runs.detail(runId)?.status).toBe("done");
    expect(sends).toBe(1);
  });

  it("does not send when owner confirmation is invalidated during the pre-send reconciliation", async () => {
    let confirmed = true;
    let sends = 0;
    const reconciliationStarted = Promise.withResolvers<void>();
    const releaseReconciliation = Promise.withResolvers<void>();
    const gatedHost = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      enrich: async () => ({ sections: [], evidence: [] }),
      completeBrief: completeFixtureBrief,
      getOwnerEmail: () => "owner@example.com",
      isOwnerProfileConfirmed: () => confirmed,
      gmailDeliveryProvider: {
        async findByDeliveryId() {
          reconciliationStarted.resolve();
          await releaseReconciliation.promise;
          return null;
        },
        async send() {
          sends += 1;
          return { messageId: "must-not-send", recipient: "owner@example.com" };
        },
      },
    });
    gatedHost.scheduleOccurrence(fixtureEvent(), new Date(now));

    const [runId] = await gatedHost.processDueSchedules(new Date(now));
    await reconciliationStarted.promise;
    confirmed = false;
    releaseReconciliation.resolve();
    await gatedHost.idle();

    expect(sends).toBe(0);
    expect(runs.detail(runId)?.failedStage).toBe("deliver");
    expect(runs.open(runId)?.readArtifact("delivery.json")).toContain("owner_not_confirmed");
  });

  it("retries enrich from the frozen snapshot without fabricating Calendar input", async () => {
    const retryWorkspace = mkdtempSync(join(tmpdir(), "mbf-retry-"));
    const retryRuns = openRuns(retryWorkspace);
    const event = fixtureEvent();
    const calendar = new FakeCalendarProvider([{ ...event, status: "confirmed" }]);
    const strictCalendar: CalendarProvider = {
      watchChannel: (args) => calendar.watchChannel(args),
      stopChannel: (args) => calendar.stopChannel(args),
      async listEvents(args) {
        if (args.calendarId !== event.calendarId) {
          throw new Error(`Unexpected Calendar id ${args.calendarId}`);
        }
        return calendar.listEvents(args);
      },
    };
    let enrichAttempts = 0;
    const retryHost = new MeetingBriefHost({
      runs: retryRuns,
      workspaceDir: retryWorkspace,
      now: () => new Date(now),
      calendarProvider: strictCalendar,
      getInternalDomains: () => ["example.com"],
      getOwnerEmail: () => "owner@example.com",
      enrich: async () => {
        enrichAttempts += 1;
        if (enrichAttempts === 1) throw new Error("temporary required-provider outage");
        return { sections: [], evidence: [] };
      },
      completeBrief: completeFixtureBrief,
      gmailDeliveryProvider: fixtureGmailDeliveryProvider("retry-msg"),
    });

    retryHost.scheduleOccurrence(event, new Date(now));
    const [runId] = await retryHost.processDueSchedules(new Date(now));
    await retryHost.idle();
    expect(retryRuns.detail(runId)?.failedStage).toBe("enrich");

    await retryHost.retryRun(runId);
    await retryHost.idle();

    const retried = retryRuns.detail(runId);
    expect(retried?.status).toBe("done");
    expect((retried?.result as MeetingBriefRunResult | undefined)?.eventVersion).toBe("v1");
    expect(enrichAttempts).toBe(2);
  });

  it("prepares a scheduled brief on demand, before its due time, through the same path", async () => {
    const event = fixtureEvent();
    const dueAt = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(event, dueAt);

    /* Well before the Module would wake itself: the operator should not have to
       wait for the clock to see a brief. */
    now = new Date("2026-08-28T09:00:00.000Z");
    expect(await host.processDueSchedules(new Date(now))).toHaveLength(0);

    const runId = await host.prepareNow(host.listUpcoming()[0].occurrenceKey);
    expect(runId).toBeTruthy();
    await host.idle();

    const runList = runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs;
    expect(runList).toHaveLength(1);
    expect(runs.detail(runList[0].id)!.status).toBe("done");
    // The schedule is spent, exactly as a due-time Run would leave it.
    expect(host.listUpcoming()).toHaveLength(0);
  });

  it("refuses to prepare an occurrence that is not scheduled", async () => {
    await expect(host.prepareNow("no-such-occurrence")).rejects.toThrow(/not scheduled/i);
  });

  it("creates exactly one Run at due time and completes 4 Stages with fixture brief, artifacts, timeline, delivery", async () => {
    const event = fixtureEvent();
    const dueAt = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(event, dueAt);

    // Before due: no Run.
    now = new Date("2026-08-28T10:00:00.000Z");
    expect(await host.processDueSchedules(new Date(now))).toHaveLength(0);
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(0);
    expect(host.listUpcoming()).toHaveLength(1);

    // At due: one Run created via real Runner.
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();

    // Schedule removed, upcoming empty, completed index populated.
    expect(host.listUpcoming()).toHaveLength(0);
    const runList = runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs;
    expect(runList).toHaveLength(1);

    const runId = created[0];
    const detail = runs.detail(runId)!;
    expect(detail.status).toBe("done");
    const meta = runs.open(runId)!.read();
    expect(meta.externalId).toBe("evt_fixture_1::2026-08-28T15:00:00Z");
    expect(meta.status).toBe("done");
    expect(meta.wait).toBeNull();

    // Timeline has exactly 4 stage_started in fixed order, plus fixture events.
    const stageStarts = detail.events
      .filter((e) => e.type === "stage_started")
      .map((e) => e.detail?.stage);
    expect(stageStarts).toEqual(["snapshot", "enrich", "compose", "deliver"]);

    // Artifacts retained.
    const files = detail.files;
    expect(files).toContain("snapshot.json");
    expect(files).toContain("enrich.json");
    expect(files).toContain("result.json");
    expect(files).toContain("delivery.json");

    const snapshotRaw = runs.open(runId)!.readArtifact("snapshot.json")!;
    const snapshot = JSON.parse(snapshotRaw) as Record<string, unknown>;
    expect(snapshot.eventId).toBe("evt_fixture_1");
    expect(snapshot.version).toBe("v1");
    expect(snapshot.occurrenceKey).toBe("evt_fixture_1::2026-08-28T15:00:00Z");

    const result = detail.result as MeetingBriefRunResult;
    expect(result.eventId).toBe("evt_fixture_1");
    expect(result.occurrenceId).toBe("2026-08-28T15:00:00Z");
    expect(result.eventVersion).toBe("v1");
    expect(result.meetingBrief.guests[0]?.email).toBe("alice@external.co");
    expect(result.meetingBrief.conversationStarters.length).toBeGreaterThanOrEqual(2);
    expect(result.delivery.status).toBe("sent");
    expect(result.delivery.messageId).toBe("fixture-msg-123");
    expect(result.delivery.recipient).toBe("owner@example.com");

    // Module surface renders completed fixture state via public host behavior.
    const index = host.index();
    expect(index.upcoming).toHaveLength(0);
    expect(index.briefs).toHaveLength(1);
    expect(index.briefs[0]?.runId).toBe(runId);
    expect(index.briefs[0]?.meetingBrief?.guests[0]?.email).toBe("alice@external.co");
    expect(index.briefs[0]?.delivery?.messageId).toBe("fixture-msg-123");

    // Idempotent: duplicate wake-up at same version creates no second Run.
    const dup = await host.processDueSchedules(new Date(now));
    expect(dup).toHaveLength(0);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);

    // No future blocked Run exists — status is done, not blocked.
    const all = runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs;
    for (const summary of all) {
      const d = runs.detail(summary.id)!;
      expect(d.status).not.toBe("blocked");
    }
  });

  it("recovers a due schedule across a simulated restart", async () => {
    const event = fixtureEvent();
    const dueAt = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(event, dueAt);

    // Simulate restart before due: new host with same workspaceDir reads durable schedule.
    const now2 = new Date("2026-08-28T10:00:00.000Z");
    const host2 = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now2),
      log: () => {},
      enrich: async () => ({ sections: [], evidence: [] }),
      completeBrief: completeFixtureBrief,
      gmailDeliveryProvider: fixtureGmailDeliveryProvider("restart-msg"),
    });
    expect(host2.listUpcoming()).toHaveLength(1);

    // Advance past due and process via restarted host — creates exactly one Run.
    const later = new Date("2026-08-28T11:00:00.000Z");
    const created = await host2.processDueSchedules(later);
    expect(created).toHaveLength(1);
    await host2.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);

    // Original host sees the same state (workspace-backed).
    expect(host.listUpcoming()).toHaveLength(0);
    expect(host.index().briefs).toHaveLength(1);
  });

  it("does not create a Run before due, even though the Intake schedule exists (no blocked future Run)", async () => {
    const event = fixtureEvent({ summary: "Future meeting" });
    const farFuture = new Date("2026-09-01T11:00:00.000Z");
    host.scheduleOccurrence(event, farFuture);
    now = new Date("2026-08-28T11:00:00.000Z");
    expect(await host.processDueSchedules(new Date(now))).toHaveLength(0);
    const runList = runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs;
    expect(runList).toHaveLength(0);
    // The only durable state is the Intake schedule, not a blocked Run.
    const detail = runs.detail("run_20260828-110000_aaaaaaaa");
    expect(detail).toBeNull();
  });
});
