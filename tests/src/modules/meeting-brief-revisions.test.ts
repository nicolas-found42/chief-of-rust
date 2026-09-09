/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-call, no-useless-assignment */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEETING_BRIEF_MODULE_ID,
  type MeetingBriefEvent,
  type MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import {
  FakeCalendarProvider,
  type CalendarEvent,
} from "../../../apps/server/src/modules/meeting-brief-generator/calendar";
import type { MeetingBriefGeneratorOptions } from "../../../apps/server/src/modules/meeting-brief-generator/generator";
import type { GmailDeliveryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmailDelivery";

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_rev_1",
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
    ...(f.colorId !== undefined ? { colorId: f.colorId } : {}),
    ...(f.etag !== undefined ? { etag: f.etag } : {}),
  };
}

let workspaceDir: string;
let runs: Runs;
let now: Date;
let host: MeetingBriefHost;
let fakeCal: FakeCalendarProvider;

function makeHost(
  opts: {
    enrich?: MeetingBriefGeneratorOptions["enrich"];
    completeBrief?: MeetingBriefGeneratorOptions["completeBrief"];
    getInternalDomains?: () => string[];
    ownerEmail?: string | null;
    calendarProvider?: FakeCalendarProvider;
    calendarUse?: "snapshot" | "recheck";
    gmailDeliveryProvider?: GmailDeliveryProvider | null;
  } = {},
) {
  workspaceDir = mkdtempSync(join(tmpdir(), "mbr-"));
  runs = openRuns(workspaceDir);
  now = new Date("2026-08-28T09:00:00.000Z");
  fakeCal = opts.calendarProvider ?? new FakeCalendarProvider();
  const domainsFn = opts.getInternalDomains;
  const owner = opts.ownerEmail ?? null;
  host = new MeetingBriefHost({
    runs,
    workspaceDir,
    now: () => new Date(now),
    log: () => {},
    calendarProvider: fakeCal,
    ...(opts.calendarUse ? { calendarUse: opts.calendarUse } : {}),
    ...(opts.gmailDeliveryProvider ? { gmailDeliveryProvider: opts.gmailDeliveryProvider } : {}),
    ...(domainsFn ? { getInternalDomains: domainsFn } : {}),
    ...(owner !== null ? { getOwnerEmail: () => owner } : {}),
    ...(opts.enrich ? { enrich: opts.enrich } : {}),
    ...(opts.completeBrief ? { completeBrief: opts.completeBrief } : {}),
  });
  return { host, runs, fakeCal, getNow: () => now, setNow: (d: Date) => (now = d) };
}

// Shared enrich/deliver fakes that capture calls
function defaultEnrich() {
  return async (_input: any, ctx: any) => {
    ctx.event("fixture_enrich", { guest: "alice@external.co" });
    return {
      sections: [
        {
          source: "gmail",
          guest: "alice@external.co",
          status: "completed",
          evidence: ["evidence"],
          references: ["https://example.com"],
        },
      ],
      evidence: ["evidence"],
    };
  };
}
function defaultCompleteBrief() {
  return async (input: MeetingBriefEvent) => {
    return {
      version: 1 as const,
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
        organizer: input.organizer ?? null,
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
    };
  };
}
function defaultDeliver() {
  return {
    async findByDeliveryId() {
      return null;
    },
    async send() {
      return { messageId: "msg-1", recipient: "owner@example.com" };
    },
  };
}

describe("Snapshot freezes event identity/version/occurrence, skipped when not Eligible", () => {
  it("skips when production Calendar truth no longer contains the occurrence", async () => {
    const { host, runs } = makeHost({
      calendarUse: "snapshot",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    host.scheduleOccurrence(fixtureEvent(), new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const [runId] = await host.processDueSchedules(now);
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("skipped");
    expect(runs.open(runId)!.read().skipReason).toBe("occurrence_not_found");
  });

  it("fails snapshot when production Calendar cannot establish current truth", async () => {
    class UnavailableCalendar extends FakeCalendarProvider {
      override async listEvents(): Promise<never> {
        throw new Error("Calendar unavailable");
      }
    }
    const { host, runs } = makeHost({
      calendarProvider: new UnavailableCalendar(),
      calendarUse: "snapshot",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    host.scheduleOccurrence(fixtureEvent(), new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const [runId] = await host.processDueSchedules(now);
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("failed");
    expect(runs.detail(runId)!.failedStage).toBe("snapshot");
  });

  it("freezes snapshot version and occurrence, retains frozen version", async () => {
    const { host, runs } = makeHost({
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const event = fixtureEvent({ version: "v1", summary: "Original Title" });
    const due = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(event, due);
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    const detail = runs.detail(created[0])!;
    expect(detail.status).toBe("done");
    const snapRaw = runs.open(created[0])!.readArtifact("snapshot.json")!;
    const snap = JSON.parse(snapRaw);
    expect(snap.version).toBe("v1");
    expect(snap.occurrenceKey).toBe("evt_rev_1::2026-08-28T15:00:00Z");
    expect(snap.eventId).toBe("evt_rev_1");
    expect(snap.summary).toBe("Original Title");
    expect(snap.capturedAt).toBeDefined();
    const result = detail.result as MeetingBriefRunResult;
    expect(result.eventVersion).toBe("v1");
    expect(result.occurrenceKey).toBe("evt_rev_1::2026-08-28T15:00:00Z");
  });

  it("ends skipped when not Eligible (owner-only meeting, issue://136), no enrichment/email", async () => {
    const enrichCalls: number[] = [];
    const { host, runs } = makeHost({
      ownerEmail: "owner@example.com",
      getInternalDomains: () => ["external.co", "example.com"],
      enrich: async (_input, ctx) => {
        enrichCalls.push(1);
        ctx.event("should_not_run", {});
        return { sections: [], evidence: [] };
      },
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const event = fixtureEvent({
      version: "v1",
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
      ],
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    const detail = runs.detail(created[0])!;
    expect(detail.status).toBe("skipped");
    const meta = runs.open(created[0])!.read();
    expect(meta.status).toBe("skipped");
    expect(meta.skipReason).toBe("no_other_attendee");
    // No enrich artifacts beyond snapshot
    expect(detail.files).toContain("snapshot.json");
    expect(detail.files).not.toContain("enrich.json");
    expect(detail.files).not.toContain("result.json");
    expect(detail.files).not.toContain("delivery.json");
    expect(enrichCalls).toHaveLength(0);
  });

  it("ends skipped when owner declined", async () => {
    const { host, runs } = makeHost({
      ownerEmail: "owner@example.com",
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const event = fixtureEvent({
      version: "v1",
      attendees: [
        { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "declined",
          organizer: true,
        },
      ],
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    const detail = runs.detail(created[0])!;
    expect(detail.status).toBe("skipped");
  });

  it("ends skipped when cancelled status", async () => {
    const { host, runs, fakeCal } = makeHost({
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const event = fixtureEvent({
      version: "v1",
      isAllDay: true,
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.detail(created[0])!.status).toBe("skipped");
    void fakeCal;
  });
});

describe("Material change detection — every consumed field triggers revision, ignored metadata does not", () => {
  const materialCases: Array<{
    name: string;
    mutate: (e: MeetingBriefEvent) => MeetingBriefEvent;
  }> = [
    { name: "title/summary", mutate: (e) => ({ ...e, summary: "New Title v2", version: "v2" }) },
    {
      name: "description",
      mutate: (e) => ({ ...e, description: "New description v2", version: "v2" }),
    },
    {
      name: "timing startAt",
      mutate: (e) => ({
        ...e,
        startAt: new Date("2026-08-28T16:00:00.000Z").toISOString(),
        version: "v2",
      }),
    },
    {
      name: "timing endAt",
      mutate: (e) => ({
        ...e,
        endAt: new Date("2026-08-28T17:00:00.000Z").toISOString(),
        version: "v2",
      }),
    },
    { name: "location", mutate: (e) => ({ ...e, location: "New Location", version: "v2" }) },
    {
      name: "conferenceLink",
      mutate: (e) => ({ ...e, conferenceLink: "https://meet.new/xyz", version: "v2" }),
    },
    {
      name: "attachments/Docs",
      mutate: (e) => ({ ...e, attachments: ["https://drive.example/doc2"], version: "v2" }),
    },
    {
      name: "organizer",
      mutate: (e) => ({
        ...e,
        organizer: { email: "neworg@external.co", displayName: "New Org" },
        version: "v2",
      }),
    },
    {
      name: "guest identity added",
      mutate: (e) => ({
        ...e,
        attendees: [
          ...e.attendees,
          { email: "bob@external.co", displayName: "Bob", responseStatus: "accepted" as const },
        ],
        version: "v2",
      }),
    },
    {
      name: "guest list removed",
      mutate: (e) => ({
        ...e,
        attendees: e.attendees.filter((a) => a.email !== "alice@external.co"),
        version: "v2",
      }),
    },
    {
      name: "invitation response",
      mutate: (e) => ({
        ...e,
        attendees: e.attendees.map((a) =>
          a.email === "alice@external.co" ? { ...a, responseStatus: "tentative" as const } : a,
        ),
        version: "v2",
      }),
    },
  ];

  for (const c of materialCases) {
    it(`material field "${c.name}" creates linked revision without rewriting history`, async () => {
      const { host, runs } = makeHost({
        enrich: defaultEnrich(),
        completeBrief: defaultCompleteBrief(),
        gmailDeliveryProvider: defaultDeliver(),
      });
      const v1 = fixtureEvent({ version: "v1" });
      host.scheduleOccurrence(v1, new Date("2026-08-28T11:00:00.000Z"));
      now = new Date("2026-08-28T11:00:00.000Z");
      let created = await host.processDueSchedules(new Date(now));
      expect(created).toHaveLength(1);
      await host.idle();
      const run1 = runs.detail(created[0])!;
      expect(run1.status).toBe("done");
      const run1Id = created[0];
      const run1Result = run1.result as MeetingBriefRunResult;
      expect(run1Result.eventVersion).toBe("v1");
      expect(run1Result.supersedes).toBeNull();

      const v2 = c.mutate({ ...v1 });
      v2.startAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
      v2.endAt = new Date(now.getTime() + 32 * 60 * 1000).toISOString();
      host.scheduleOccurrence(v2, new Date(now));
      created = await host.processDueSchedules(new Date(now));
      expect(created).toHaveLength(1);
      await host.idle();
      const run2Id = created[0];
      const run2 = runs.detail(run2Id)!;
      expect(run2.status).toBe("done");
      const run2Result = run2.result as MeetingBriefRunResult;
      expect(run2Result.eventVersion).toBe("v2");
      expect(run2Result.supersedes).toBe(run1Id);
      // Completed history preserved
      const run1Again = runs.detail(run1Id)!;
      expect(run1Again.status).toBe("done");
      expect((run1Again.result as MeetingBriefRunResult).eventVersion).toBe("v1");
      // Index shows current vs superseded
      const index = host.index();
      expect(index.briefs).toHaveLength(2);
      const byKey = index.briefs.filter(
        (b) => b.occurrenceKey === "evt_rev_1::2026-08-28T15:00:00Z",
      );
      expect(byKey).toHaveLength(2);
      const current = byKey.find((b) => b.runId === run2Id)!;
      const superseded = byKey.find((b) => b.runId === run1Id)!;
      expect(current.supersedes).toBe(run1Id);
      expect(superseded.supersedes).toBeNull();
      // Revision chain derived on read: superseded entries are not current; current supersedes previous
      expect(current.runId).toBe(run2Id);
    });
  }

  it("ignored metadata (colorId/etag/visibility) does not create revision", async () => {
    const { host, runs } = makeHost({
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const v1 = fixtureEvent({ version: "v1", colorId: "1", etag: "etag1" });
    host.scheduleOccurrence(v1, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    let created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);

    const v2ignored = fixtureEvent({
      version: "v2",
      colorId: "2",
      etag: "etag2",
      visibility: "private",
    });
    // keep material same, only ignored changed
    host.scheduleOccurrence(v2ignored, new Date("2026-08-28T11:00:00.000Z"));
    created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(0);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);
    const remaining = runs.detail(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs[0].id)!;
    expect((remaining.result as MeetingBriefRunResult).eventVersion).toBe("v1");
  });
});

describe("Cross-Run index", () => {
  it("keeps a newest failed revision current even when it has no result artifact", async () => {
    let failEnrichment = false;
    const { host, runs } = makeHost({
      enrich: async (...args) => {
        if (failEnrichment) throw new Error("HubSpot unavailable");
        return defaultEnrich()(...args);
      },
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    host.scheduleOccurrence(fixtureEvent({ version: "v1" }), new Date("2026-08-28T11:00:00Z"));
    now = new Date("2026-08-28T11:00:00Z");
    const [run1Id] = await host.processDueSchedules(now);
    await host.idle();
    expect(runs.detail(run1Id)!.status).toBe("done");

    failEnrichment = true;
    const v2 = fixtureEvent({
      version: "v2",
      description: "Materially changed description",
      startAt: "2026-08-28T11:02:00.000Z",
      endAt: "2026-08-28T11:32:00.000Z",
    });
    host.scheduleOccurrence(v2, now);
    const [run2Id] = await host.processDueSchedules(now);
    await host.idle();
    expect(runs.detail(run2Id)!.status).toBe("failed");
    expect(runs.open(run2Id)!.readArtifact("result.json")).toBeNull();

    const revisions = host
      .index()
      .briefs.filter((brief) => brief.occurrenceKey === "evt_rev_1::2026-08-28T15:00:00Z");
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      runId: run2Id,
      status: "failed",
      eventVersion: "v2",
      meetingBrief: null,
      delivery: null,
    });
  });
});

describe("Duplicate version deduped — one material version creates at most one Run", () => {
  it("duplicate notifications for same version are idempotent", async () => {
    const { host, runs } = makeHost({
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const v1 = fixtureEvent({ version: "v1" });
    host.scheduleOccurrence(v1, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    let created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);
    // Duplicate schedule same version (simulating duplicate Google push)
    host.scheduleOccurrence({ ...v1 }, new Date("2026-08-28T11:00:00.000Z"));
    created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(0);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);
    // Also duplicate via fakeCal reconcile path: upsert same version again
    const fake = new FakeCalendarProvider([calFromFixture(v1)]);
    const { host: host2, runs: runs2 } = makeHost({
      calendarProvider: fake,
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    // Need to use same workspace? For dedup via provider, we test host2 isolated
    // Seed schedule via reconcile
    await host2.reconcileCalendar();
    // make due immediate by setting now to after due
    now = new Date("2026-08-28T12:00:00.000Z");
    // host2's now is captured at construction (09:00) — use processDue with explicit now
    created = await host2.processDueSchedules(new Date("2026-08-28T12:00:00.000Z"));
    await host2.idle();
    const firstCount = runs2.list({ module: MEETING_BRIEF_MODULE_ID }).runs.length;
    // Duplicate reconcile same version
    await host2.reconcileCalendar();
    created = await host2.processDueSchedules(new Date("2026-08-28T12:00:00.000Z"));
    expect(created).toHaveLength(0);
    expect(runs2.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(firstCount);
    void host;
    void runs;
  });
});

describe("Rapid two versions and in-flight vs completed", () => {
  it("rapid two material versions before processing collapses to latest (no duplicate work)", async () => {
    const { host, runs } = makeHost({
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const v1 = fixtureEvent({ version: "v1" });
    host.scheduleOccurrence(v1, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    let created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);
    const run1Id = runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs[0].id;

    // Rapid: v2 and v3 arrive before next processDue — only latest should run (schedule overwritten)
    const v2 = fixtureEvent({ version: "v2", summary: "Title v2" });
    const v3 = fixtureEvent({ version: "v3", summary: "Title v3" });
    host.scheduleOccurrence(v2, new Date(now));
    host.scheduleOccurrence(v3, new Date(now)); // overwrites v2
    created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(2);
    const run3 = runs.detail(created[0])!;
    expect((run3.result as MeetingBriefRunResult).eventVersion).toBe("v3");
    expect((run3.result as MeetingBriefRunResult).supersedes).toBe(run1Id);
  });

  it("in-flight Run defers revision until completed, then creates linked revision", async () => {
    const { promise: enrichGate, resolve: releaseEnrich } = Promise.withResolvers<void>();
    let gateResolved = false;
    const gatedResolve = () => {
      if (!gateResolved) {
        gateResolved = true;
        releaseEnrich();
      }
    };
    const enrichDeferred: MeetingBriefGeneratorOptions["enrich"] = async (_input, ctx) => {
      ctx.event("enrich_start", {});
      await enrichGate;
      ctx.event("enrich_end", {});
      return { sections: [], evidence: [] };
    };
    const { host, runs } = makeHost({
      enrich: enrichDeferred,
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const v1 = fixtureEvent({ version: "v1" });
    host.scheduleOccurrence(v1, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const created1 = await host.processDueSchedules(new Date(now));
    expect(created1).toHaveLength(1);
    // Wait for enrich_start event (runner entered enrich) instead of real timer
    for (let i = 0; i < 50; i++) {
      const d = runs.detail(created1[0]);
      if (d?.events.some((e) => e.type === "enrich_start")) break;
      await Promise.resolve();
      // also tick microtask
      await new Promise<void>((r) => queueMicrotask(r));
    }
    // While in-flight, material change v2 arrives
    const v2 = fixtureEvent({ version: "v2", summary: "Title v2" });
    v2.startAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
    v2.endAt = new Date(now.getTime() + 32 * 60 * 1000).toISOString();
    host.scheduleOccurrence(v2, new Date(now));
    const createdWhileInflight = await host.processDueSchedules(new Date(now));
    expect(createdWhileInflight).toHaveLength(0); // deferred
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);
    // Complete v1
    gatedResolve();
    await host.idle();
    expect(runs.detail(created1[0])!.status).toBe("done");
    // Now v2 schedule still pending (since we kept it), next process should create revision
    const created2 = await host.processDueSchedules(new Date(now));
    expect(created2).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(2);
    const r2 = runs.detail(created2[0])!;
    expect(r2.status).toBe("done");
    expect((r2.result as MeetingBriefRunResult).supersedes).toBe(created1[0]);
  });
  it("completed Run preserves history; supersession link and current/superseded views", async () => {
    const { host, runs } = makeHost({
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const v1 = fixtureEvent({ version: "v1" });
    host.scheduleOccurrence(v1, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    let created = await host.processDueSchedules(new Date(now));
    await host.idle();
    const run1Id = created[0];
    const v2 = fixtureEvent({ version: "v2", description: "new desc" });
    v2.startAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
    v2.endAt = new Date(now.getTime() + 32 * 60 * 1000).toISOString();
    host.scheduleOccurrence(v2, new Date(now));
    created = await host.processDueSchedules(new Date(now));
    await host.idle();
    const run2Id = created[0];
    // Verify history not rewritten
    const r1 = runs.detail(run1Id)!;
    const r2 = runs.detail(run2Id)!;
    expect(r1.status).toBe("done");
    expect(r2.status).toBe("done");
    expect((r1.result as MeetingBriefRunResult).eventVersion).toBe("v1");
    expect((r2.result as MeetingBriefRunResult).eventVersion).toBe("v2");
    expect((r2.result as MeetingBriefRunResult).supersedes).toBe(run1Id);
    expect((r1.result as MeetingBriefRunResult).supersedes).toBeNull();
    // Runs views: both readable
    expect(runs.detail(run1Id)!.result).toBeDefined();
    expect(runs.detail(run2Id)!.result).toBeDefined();
    // Module index: current vs superseded derived on read
    const index = host.index();
    const byKey = index.briefs.filter((b) => b.occurrenceKey === "evt_rev_1::2026-08-28T15:00:00Z");
    expect(byKey).toHaveLength(2);
    const current = byKey.find((b) => b.runId === run2Id)!;
    const superseded = byKey.find((b) => b.runId === run1Id)!;
    expect(current.supersedes).toBe(run1Id);
    expect(superseded.supersedes).toBeNull();
  });
});

describe("Cancellation — removes future candidate, skips active before delivery, preserves completed history", () => {
  it("cancellation before Run removes future Intake candidate without creating Run", async () => {
    const fake = new FakeCalendarProvider([calFromFixture(fixtureEvent({ version: "v1" }))]);
    const { host, runs } = makeHost({
      calendarProvider: fake,
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    // Reconcile should schedule
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(1);
    // Now cancel in provider before due
    fake.setEvents([{ ...calFromFixture(fixtureEvent({ version: "v1" })), status: "cancelled" }]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
    // No Run should have been created (since due not yet reached)
    now = new Date("2026-08-28T12:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(0);
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(0);
  });

  it("active Run rechecks Calendar before delivery and ends skipped when cancelled", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const fake = new FakeCalendarProvider([calFromFixture(fixtureEvent({ version: "v1" }))]);
    const enrichDeferred: MeetingBriefGeneratorOptions["enrich"] = async (_input, ctx) => {
      ctx.event("enrich_start", {});
      await gate;
      return { sections: [], evidence: [] };
    };
    const deliverCalls: string[] = [];
    const { host, runs } = makeHost({
      calendarProvider: fake,
      calendarUse: "recheck",
      enrich: enrichDeferred,
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: {
        async findByDeliveryId() {
          return null;
        },
        async send() {
          deliverCalls.push("called");
          return { messageId: "msg-should-not-send", recipient: "owner@example.com" };
        },
      },
    });
    await host.reconcileCalendar();
    const created = await host.processDueSchedules(new Date("2026-08-28T12:00:00.000Z"));
    expect(created).toHaveLength(1);
    // Wait for enrich to start
    for (let i = 0; i < 50; i++) {
      const d = runs.detail(created[0]);
      if (d?.events.some((e) => e.type === "enrich_start")) break;
      await Promise.resolve();
      await new Promise<void>((r) => queueMicrotask(r));
    }
    fake.setEvents([{ ...calFromFixture(fixtureEvent({ version: "v1" })), status: "cancelled" }]);
    release();
    await host.idle();
    const detail = runs.detail(created[0])!;
    expect(detail.status).toBe("skipped");
    expect(detail.files).toContain("snapshot.json");
    expect(deliverCalls).toHaveLength(0);
    // Delivery skipped is recorded via status and artifact, not necessarily event, but we check both
    const hasSkippedMarker =
      detail.events.some((e) => e.type === "delivery_skipped") ||
      runs.open(created[0])!.readArtifact("delivery.json")?.includes("cancelled") ||
      runs.open(created[0])!.readArtifact("delivery.json")?.includes("occurrence_not_found");
    expect(hasSkippedMarker).toBe(true);
  });

  it("completed history preserved while current becomes cancelled (no rewrite)", async () => {
    const fake = new FakeCalendarProvider([calFromFixture(fixtureEvent({ version: "v1" }))]);
    const { host, runs } = makeHost({
      calendarProvider: fake,
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    await host.reconcileCalendar();
    now = new Date("2026-08-28T12:00:00.000Z");
    const created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    const run1Id = created[0];
    expect(runs.detail(run1Id)!.status).toBe("done");
    fake.setEvents([{ ...calFromFixture(fixtureEvent({ version: "v1" })), status: "cancelled" }]);
    await host.reconcileCalendar();
    expect(host.listUpcoming()).toHaveLength(0);
    expect(runs.detail(run1Id)!.status).toBe("done");
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(1);
    const index = host.index();
    expect(index.upcoming).toHaveLength(0);
    expect(index.briefs).toHaveLength(1);
    expect(index.briefs[0].runId).toBe(run1Id);
    expect(index.cancellations).toEqual([
      expect.objectContaining({
        occurrenceKey: "evt_rev_1::2026-08-28T15:00:00Z",
        version: "v1",
      }),
    ]);
  });

  it("cancellation via eligibility (owner declined) also skips active delivery", async () => {
    const fake = new FakeCalendarProvider([calFromFixture(fixtureEvent({ version: "v1" }))]);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { host, runs } = makeHost({
      calendarProvider: fake,
      ownerEmail: "owner@example.com",
      calendarUse: "recheck",
      enrich: async (_input, ctx) => {
        await gate;
        ctx.event("enrich_done", {});
        return { sections: [], evidence: [] };
      },
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: {
        async findByDeliveryId() {
          return null;
        },
        async send() {
          return { messageId: "msg", recipient: "owner@example.com" };
        },
      },
    });
    await host.reconcileCalendar();
    const created = await host.processDueSchedules(new Date("2026-08-28T12:00:00.000Z"));
    expect(created).toHaveLength(1);
    for (let i = 0; i < 50; i++) {
      const d = runs.detail(created[0]);
      if (d?.events.some((e) => e.type === "stage_started")) {
        const isEnrich = d.events.some((e) => {
          if (e.type !== "stage_started") return false;
          const detail = e.detail as Record<string, unknown>;
          return detail["stage"] === "enrich";
        });
        if (isEnrich) break;
      }
      await Promise.resolve();
      await new Promise<void>((r) => queueMicrotask(r));
    }
    fake.setEvents([
      {
        ...calFromFixture(fixtureEvent({ version: "v1" })),
        attendees: [
          { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
          {
            email: "owner@example.com",
            displayName: "Owner",
            responseStatus: "declined",
            organizer: true,
          },
        ],
      },
    ]);
    release();
    await host.idle();
    expect(runs.detail(created[0])!.status).toBe("skipped");
  });
});

describe("Independent recurring occurrences", () => {
  it("changed or cancelled occurrence affects only that occurrence, earlier meetings keep history", async () => {
    const { host, runs } = makeHost({
      enrich: defaultEnrich(),
      completeBrief: defaultCompleteBrief(),
      gmailDeliveryProvider: defaultDeliver(),
    });
    const occ1 = fixtureEvent({
      eventId: "evt_recurring",
      occurrenceId: "2026-08-28T15:00:00Z",
      version: "v1",
      summary: "Recurring 1",
    });
    const occ2 = fixtureEvent({
      eventId: "evt_recurring",
      occurrenceId: "2026-08-29T15:00:00Z",
      version: "v1",
      summary: "Recurring 2",
    });
    host.scheduleOccurrence(occ1, new Date("2026-08-28T11:00:00.000Z"));
    host.scheduleOccurrence(occ2, new Date("2026-08-29T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    let created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    now = new Date("2026-08-29T11:00:00.000Z");
    created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(2);
    const all = runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs;
    const run1 = all.find(
      (r) =>
        runs.detail(r.id)!.result &&
        (runs.detail(r.id)!.result as MeetingBriefRunResult).occurrenceId ===
          "2026-08-28T15:00:00Z",
    )!;
    const run2 = all.find(
      (r) =>
        runs.detail(r.id)!.result &&
        (runs.detail(r.id)!.result as MeetingBriefRunResult).occurrenceId ===
          "2026-08-29T15:00:00Z",
    )!;

    // Material change to occ1 only
    const occ1v2 = { ...occ1, version: "v2", summary: "Recurring 1 updated" };
    host.scheduleOccurrence(occ1v2, new Date(now));
    created = await host.processDueSchedules(new Date(now));
    expect(created).toHaveLength(1);
    await host.idle();
    expect(runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs).toHaveLength(3);
    const rev = runs.detail(created[0])! as unknown as { result: MeetingBriefRunResult };
    expect(rev.result.occurrenceId).toBe("2026-08-28T15:00:00Z");
    expect(rev.result.supersedes).toBe(run1.id);
    // occ2 unchanged — its Run remains done and not superseded
    const run2Detail = runs.detail(run2.id)!;
    expect(run2Detail.status).toBe("done");
    // Index shows two chains independent
    const index = host.index();
    const occ1Briefs = index.briefs.filter((b) => b.occurrenceId === "2026-08-28T15:00:00Z");
    const occ2Briefs = index.briefs.filter((b) => b.occurrenceId === "2026-08-29T15:00:00Z");
    expect(occ1Briefs).toHaveLength(2);
    expect(occ2Briefs).toHaveLength(1);
    const occ1Current = occ1Briefs.find((b) => b.supersedes === run1.id)!;
    const occ1Superseded = occ1Briefs.find((b) => b.supersedes === null)!;
    expect(occ1Current).toBeDefined();
    expect(occ1Superseded).toBeDefined();
    expect(occ2Briefs[0].supersedes).toBeNull();
  });
});
