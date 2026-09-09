import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fastify from "fastify";
import type {
  MeetingBrief,
  MeetingBriefEvent,
  MeetingBriefRunResult,
} from "@chief-of-staff-demo/shared";
import { openRuns } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { FakeGmailDeliveryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmailDelivery";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";

/**
 * Single-email policy (issue #163): preparation never emails per-Brief — the
 * Brief completes in-app and the owner sends it explicitly — while the Daily
 * and Weekly Briefings each email the owner once per period.
 */

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_single_email",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Fixture Sync with External Guest",
    description: "Discuss roadmap",
    startAt: new Date("2026-08-28T15:00:00.000Z").toISOString(),
    endAt: new Date("2026-08-28T16:00:00.000Z").toISOString(),
    location: null,
    conferenceLink: null,
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

function fixtureBrief(input: MeetingBriefEvent, now: Date): MeetingBrief {
  return {
    version: 1,
    eventId: input.eventId,
    occurrenceId: input.occurrenceId,
    eventVersion: input.version,
    generatedAt: now.toISOString(),
    logistics: {
      title: input.summary,
      startAt: input.startAt,
      endAt: input.endAt,
      location: null,
      conferenceLink: null,
      organizer: { email: "owner@example.com", displayName: "Owner" },
    },
    summary: `Brief for ${input.summary}`,
    guests: [
      {
        email: "alice@external.co",
        name: "Alice External",
        role: "CTO at External Co",
        background: "Fixture background",
        relationshipHistory: [],
        crmContext: null,
        talkingPoints: ["Talk about roadmap"],
        uncertainty: [],
        evidenceReferences: [],
      },
    ],
    companies: [],
    conversationStarters: ["What prompted the roadmap shift?"],
    sourceReferences: [],
    missingEvidence: [],
    uncertainty: [],
  };
}

function seedMeeting(
  workspaceDir: string,
  now: Date,
  overrides: { occurrenceKey: string; title: string; startAt: string; endAt: string },
): void {
  const meetings = new WorkspaceMeetings(workspaceDir, () => new Date(now));
  meetings.upsertFromCalendar({
    occurrenceKey: overrides.occurrenceKey,
    calendarEventId: overrides.occurrenceKey.split("::")[0] ?? overrides.occurrenceKey,
    occurrenceId: overrides.occurrenceKey.split("::")[1] ?? overrides.occurrenceKey,
    title: overrides.title,
    startAt: overrides.startAt,
    endAt: overrides.endAt,
    participants: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
        self: true,
      },
      {
        email: "alice@external.co",
        displayName: "Alice",
        responseStatus: "accepted",
        organizer: false,
        self: false,
      },
    ],
    cancelled: false,
    ineligibleReason: null,
  });
}

describe("single-email policy (issue #163)", () => {
  it("preparation defers the per-Brief email; the explicit retry sends exactly once", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mb-single-email-"));
    const runs = openRuns(workspaceDir);
    const fakeGmail = new FakeGmailDeliveryProvider({ ownerEmail: "owner@example.com" });
    const now = new Date("2026-08-28T09:00:00.000Z");
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      getTimezone: () => "UTC",
      getOwnerEmail: () => "owner@example.com",
      gmailDeliveryProvider: fakeGmail,
      perBriefAutoSend: false,
      briefingEmails: true,
      enrich: async (_input, ctx) => {
        ctx.event("fixture_enrich", {});
        return { sections: [], evidence: [] };
      },
      completeBrief: async (input) => fixtureBrief(input, now),
    });

    const dueAt = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(fixtureEvent(), dueAt);
    const [runId] = await host.processDueSchedules(dueAt);
    await host.idle();

    // Composed and available in-app, but nothing emailed.
    const prepared = runs.detail(runId);
    expect(prepared?.status).toBe("done");
    const preparedResult = prepared?.result as MeetingBriefRunResult;
    expect(preparedResult.meetingBrief).not.toBeNull();
    expect(preparedResult.delivery.status).toBe("pending");
    expect(fakeGmail.count).toBe(0);
    expect(prepared?.events.some((event) => event.type === "brief_delivery_deferred")).toBe(true);

    // The explicit retry is the manual send.
    const retried = await host.retryRun(runId);
    expect(retried.status).toBe("done");
    await host.idle();
    const sent = runs.detail(runId)?.result as MeetingBriefRunResult;
    expect(sent.delivery.status).toBe("sent");
    expect(sent.delivery.recipient).toBe("owner@example.com");
    expect(fakeGmail.count).toBe(1);
    expect(fakeGmail.messages[0]?.to).toBe("owner@example.com");

    // A sent Brief never resends: the completed Run is not retryable again.
    await expect(host.retryRun(runId)).rejects.toThrow();
    expect(fakeGmail.count).toBe(1);
  });

  it("keeps auto-send when the flag is left at its historical default", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mb-single-email-legacy-"));
    const runs = openRuns(workspaceDir);
    const fakeGmail = new FakeGmailDeliveryProvider({ ownerEmail: "owner@example.com" });
    const now = new Date("2026-08-28T09:00:00.000Z");
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fakeGmail,
      enrich: async (_input, ctx) => {
        ctx.event("fixture_enrich", {});
        return { sections: [], evidence: [] };
      },
      completeBrief: async (input) => fixtureBrief(input, now),
    });

    const dueAt = new Date("2026-08-28T11:00:00.000Z");
    host.scheduleOccurrence(fixtureEvent(), dueAt);
    const [runId] = await host.processDueSchedules(dueAt);
    await host.idle();

    expect(runs.detail(runId)?.status).toBe("done");
    expect((runs.detail(runId)?.result as MeetingBriefRunResult | undefined)?.delivery.status).toBe(
      "sent",
    );
    expect(fakeGmail.count).toBe(1);
  });

  it("emails the Daily Briefing once per day across ticks and retries", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mb-daily-email-"));
    const runs = openRuns(workspaceDir);
    const fakeGmail = new FakeGmailDeliveryProvider({ ownerEmail: "owner@example.com" });
    const morning = new Date("2026-08-28T07:00:00.000Z");
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(morning),
      log: () => {},
      getTimezone: () => "UTC",
      getOwnerEmail: () => "owner@example.com",
      gmailDeliveryProvider: fakeGmail,
      perBriefAutoSend: false,
      briefingEmails: true,
      enrich: async () => ({ sections: [], evidence: [] }),
      completeBrief: async (input) => fixtureBrief(input, morning),
    });
    seedMeeting(workspaceDir, morning, {
      occurrenceKey: "evt-a::occ-a",
      title: "Acme negotiation",
      startAt: "2026-08-28T14:00:00.000Z",
      endAt: "2026-08-28T15:00:00.000Z",
    });

    await host.maintenanceTick(new Date(morning));
    expect(fakeGmail.count).toBe(1);
    expect(fakeGmail.messages[0]?.subject).toBe("Daily Briefing: 2026-08-28");
    expect(fakeGmail.messages[0]?.to).toBe("owner@example.com");

    // A second tick the same morning converges to the one email.
    await host.maintenanceTick(new Date("2026-08-28T07:30:00.000Z"));
    expect(fakeGmail.count).toBe(1);

    // So does the explicit retry path.
    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();
    const retry = await app.inject({ method: "POST", url: "/api/meeting-brief/daily/retry" });
    expect(retry.statusCode).toBe(200);
    expect(fakeGmail.count).toBe(1);
    await app.close();
  });

  it("no longer emails a Weekly Briefing — the Weekly Summary owns that (issue #197)", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mb-weekly-email-"));
    const runs = openRuns(workspaceDir);
    const fakeGmail = new FakeGmailDeliveryProvider({ ownerEmail: "owner@example.com" });
    const monday = new Date("2026-08-31T07:00:00.000Z");
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(monday),
      log: () => {},
      getTimezone: () => "UTC",
      getOwnerEmail: () => "owner@example.com",
      gmailDeliveryProvider: fakeGmail,
      perBriefAutoSend: false,
      briefingEmails: true,
      enrich: async () => ({ sections: [], evidence: [] }),
      completeBrief: async (input) => fixtureBrief(input, monday),
    });
    seedMeeting(workspaceDir, monday, {
      occurrenceKey: "evt-b::occ-b",
      title: "Acme negotiation",
      startAt: "2026-09-01T14:00:00.000Z",
      endAt: "2026-09-01T15:00:00.000Z",
    });

    /* The week's read model is still refreshed on Monday; the message is not
       sent from here any more, because two weekly emails would be one too
       many and the Weekly Summary is the one the owner asked for. */
    await host.maintenanceTick(new Date(monday));
    expect(fakeGmail.messages).toEqual([]);

    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();
    const retry = await app.inject({ method: "POST", url: "/api/meeting-brief/weekly/retry" });
    expect(retry.statusCode).toBe(200);
    expect(fakeGmail.count).toBe(0);
    await app.close();
  });
});
