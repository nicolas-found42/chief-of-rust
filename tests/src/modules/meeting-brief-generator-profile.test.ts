import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fastify from "fastify";
import type { MeetingBriefEvent, MeetingBriefRunResult } from "@chief-of-staff-demo/shared";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { openRuns, type Runs } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { FakeGmailProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail";
import { FakeCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory";
import { FakeDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive";
import { FakePublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import {
  completeFixtureBrief,
  fixtureGmailDeliveryProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/testRuntime";

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

const fixtureDeliver = fixtureGmailDeliveryProvider();

function fixtureEvent(overrides: Partial<MeetingBriefEvent> = {}): MeetingBriefEvent {
  return {
    calendarId: "cal_primary",
    eventId: "evt_profile_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Profile sync",
    startAt: "2026-08-28T15:00:00.000Z",
    endAt: "2026-08-28T15:30:00.000Z",
    attendees: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
      { email: "alice@external.co", displayName: "Alice External", responseStatus: "accepted" },
      { email: "bob@external.co", displayName: "Bob External", responseStatus: "needsAction" },
    ],
    ...overrides,
    status: overrides.status ?? "confirmed",
  };
}

describe("Meeting Brief pinned Person Profile consumption (issue #124, #136)", () => {
  let workspaceDir: string;
  let runs: Runs;
  let now: Date;

  it("consumes the pinned Person Profile revision without a Guest Profile endpoint", async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "mbf-profile-"));
    runs = openRuns(workspaceDir);
    now = new Date("2026-08-28T10:00:00.000Z");
    const store = new PersonProfileStore(workspaceDir);
    const attendeeProfiles = new WorkspacePersonProfiles({
      store,
      now: () => new Date(now),
      lifecycle: [],
    });
    store.save({
      id: "person_alice",
      revision: 1,
      createdAt: "2026-08-28T09:00:00.000Z",
      updatedAt: "2026-08-28T09:00:00.000Z",
      fullName: "Alice External",
      primaryEmail: "alice@external.co",
      emails: ["alice@external.co"],
      handles: {},
      profileUrls: ["https://example.com/alice"],
      employerHints: [],
      role: "Founder",
      background: "Builds evidence-backed products",
      currentEmployer: "Example Labs",
      socialProfiles: [],
      websites: ["https://example.com/alice"],
      feeds: [{ url: "https://example.com/alice/feed.xml", title: "Alice's feed" }],
      publications: [],
      mentions: [],
      evidence: [],
      sourceDiagnostics: [{ source: "public-web", status: "completed", detail: "profile matched" }],
      archivedAt: null,
    });
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date(now),
      log: () => {},
      gmailDeliveryProvider: fixtureDeliver,
      completeBrief: completeFixtureBrief,
      getInternalDomains: () => ["example.com"],
      enrichmentProviders: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        attendeeProfiles,
        getHubSpotApi: () => stubHubSpotApi(),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      },
    });
    const event = fixtureEvent({
      version: "v_person_profile_1",
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
        {
          email: "alice@external.co",
          displayName: "Alice External",
          responseStatus: "accepted",
        },
      ],
    });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    now = new Date("2026-08-28T11:00:00.000Z");
    const [runId] = await host.processDueSchedules(new Date(now));
    await host.idle();

    expect(runs.detail(runId)!.status).toBe("done");
    // The existing Profile was reused, not resolved or duplicated, and the
    // Run pins the exact id + revision it consumed (issue #124).
    expect(store.list()).toHaveLength(2);
    expect(attendeeProfiles.get("person_alice")?.revision).toBe(1);
    const pins = JSON.parse(runs.open(runId)!.readArtifact("attendee-profiles.json")!) as Array<{
      email: string;
      profileId: string;
      profileRevision: number;
      origin: string;
    }>;
    expect(pins).toContainEqual({
      email: "alice@external.co",
      profileId: "person_alice",
      profileRevision: 1,
      origin: "reused",
    });
    expect(runs.detail(runId)!.files).toContain(
      "person-profile-alice_external_co-v_person_profile_1.json",
    );
    const snapshot = JSON.parse(
      runs.open(runId)!.readArtifact("person-profile-alice_external_co-v_person_profile_1.json")!,
    ) as { profileId: string; profileRevision: number; currentEmployer: string | null };
    expect(snapshot.profileId).toBe("person_alice");
    expect(snapshot.profileRevision).toBe(1);
    expect(snapshot.currentEmployer).toBe("Example Labs");
    const result = runs.detail(runId)!.result as MeetingBriefRunResult;
    // Every attendee's pinned Profile is a recorded consumer link (issue://136):
    // the internal owner's shell and the external guest's reused Profile.
    const links = result.personProfileLinks ?? [];
    const ownerLink = links.find((link) => link.guestEmail === "owner@example.com");
    expect(ownerLink?.profileRevision).toBe(1);
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({
      guestEmail: "alice@external.co",
      profileId: "person_alice",
      profileRevision: 1,
    });
  });
});

describe("Meeting Brief delivery rechecks pinned Person Profiles", () => {
  it("fails visibly before send, and again on retry, when a repair lands after composition", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mbf-profile-delivery-"));
    const runs = openRuns(workspaceDir);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(workspaceDir),
      now: () => new Date("2026-08-28T10:00:00.000Z"),
      lifecycle: [],
    });
    const profile = people.create({
      fullName: "Alice External",
      primaryEmail: "alice@external.co",
      role: "CTO",
    });
    let repaired = false;
    let sends = 0;
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date("2026-08-28T11:00:00.000Z"),
      getInternalDomains: () => ["example.com"],
      getOwnerEmail: () => "owner@example.com",
      personProfiles: people,
      enrich: async () => {
        const current = people.get(profile.id)!;
        return {
          sections: [],
          evidence: [],
          personProfileLinks: [
            {
              guestEmail: "alice@external.co",
              profileId: current.id,
              profileRevision: current.revision,
            },
          ],
        };
      },
      completeBrief: completeFixtureBrief,
      gmailDeliveryProvider: {
        async findByDeliveryId() {
          if (!repaired) {
            repaired = true;
            people.correct(profile.id, { role: "Founder", note: "Corrected before delivery." });
          }
          return null;
        },
        async send() {
          sends += 1;
          return { messageId: "must-not-send", recipient: "owner@example.com" };
        },
      },
    });
    const event = fixtureEvent({ version: "v_profile_repair_delivery" });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    const [runId] = await host.processDueSchedules(new Date("2026-08-28T11:00:00.000Z"));
    await host.idle();

    expect(runs.detail(runId)).toMatchObject({ status: "failed", failedStage: "deliver" });
    expect((runs.detail(runId)?.result as MeetingBriefRunResult | undefined)?.delivery.status).toBe(
      "failed",
    );
    expect(runs.detail(runId)?.events).toContainEqual(
      expect.objectContaining({
        type: "brief_delivery_blocked",
        detail: expect.objectContaining({ reason: "person_profile_refresh_required" }),
      }),
    );
    expect(sends).toBe(0);

    await expect(host.retryRun(runId)).rejects.toThrow(/require regeneration/);
    expect(runs.detail(runId)).toMatchObject({ status: "failed", failedStage: "deliver" });
    expect(sends).toBe(0);

    const staleArtifact = runs.open(runId)!.readArtifact("result.json");
    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();
    const [firstRefresh, concurrentRefresh] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/meeting-brief/runs/${runId}/regenerate`,
      }),
      app.inject({
        method: "POST",
        url: `/api/meeting-brief/runs/${runId}/regenerate`,
      }),
    ]);
    expect(firstRefresh.statusCode).toBe(202);
    expect(concurrentRefresh.statusCode).toBe(202);
    const refreshedRunId = firstRefresh.json<{ runId: string }>().runId;
    expect(concurrentRefresh.json<{ runId: string }>().runId).toBe(refreshedRunId);
    expect(refreshedRunId).not.toBe(runId);
    await host.idle();

    expect(runs.detail(refreshedRunId)).toMatchObject({ status: "done", failedStage: null });
    expect(runs.detail(refreshedRunId)?.result as MeetingBriefRunResult).toMatchObject({
      supersedes: runId,
      profileRefreshOf: runId,
      delivery: { status: "sent" },
      personProfileLinks: [{ profileId: profile.id, profileRevision: 2 }],
    });
    expect(sends).toBe(1);
    expect(runs.open(runId)!.readArtifact("result.json")).toBe(staleArtifact);
    expect(runs.detail(runId)).toMatchObject({ status: "failed", failedStage: "deliver" });

    const repeatedRefresh = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${runId}/regenerate`,
    });
    expect(repeatedRefresh.statusCode).toBe(202);
    expect(repeatedRefresh.json<{ runId: string }>().runId).toBe(refreshedRunId);

    const currentRefresh = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${refreshedRunId}/regenerate`,
    });
    expect(currentRefresh.statusCode).toBe(409);
    expect(currentRefresh.json()).toMatchObject({
      error: "meeting-brief-profile-refresh-not-required",
    });
    await app.close();
  });

  it("sends one distinct Profile refresh and reconciles that message on retry", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mbf-profile-refresh-delivery-"));
    const runs = openRuns(workspaceDir);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(workspaceDir),
      now: () => new Date("2026-08-28T10:00:00.000Z"),
      lifecycle: [],
    });
    const profile = people.create({
      fullName: "Alice External",
      primaryEmail: "alice@external.co",
      role: "CTO",
    });
    const sent = new Map<string, { messageId: string; recipient: string }>();
    let sendCalls = 0;
    let refreshedMessageId: string | null = null;
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      now: () => new Date("2026-08-28T11:00:00.000Z"),
      getInternalDomains: () => ["example.com"],
      getOwnerEmail: () => "owner@example.com",
      personProfiles: people,
      enrich: async () => {
        const current = people.get(profile.id)!;
        return {
          sections: [],
          evidence: [],
          personProfileLinks: [
            {
              guestEmail: "alice@external.co",
              profileId: current.id,
              profileRevision: current.revision,
            },
          ],
        };
      },
      completeBrief: completeFixtureBrief,
      gmailDeliveryProvider: {
        async findByDeliveryId(deliveryId) {
          return sent.get(deliveryId) ?? null;
        },
        async send({ deliveryId }) {
          sendCalls += 1;
          const delivered = {
            messageId: `message-${sendCalls}`,
            recipient: "owner@example.com",
          };
          sent.set(deliveryId, delivered);
          if (sendCalls === 2) {
            refreshedMessageId = delivered.messageId;
            throw new Error("Lost acknowledgement after refreshed Gmail send");
          }
          return delivered;
        },
      },
    });
    const event = fixtureEvent({ version: "v_profile_refresh_delivery" });
    host.scheduleOccurrence(event, new Date("2026-08-28T11:00:00.000Z"));
    const [originalRunId] = await host.processDueSchedules(new Date("2026-08-28T11:00:00.000Z"));
    await host.idle();
    const original = runs.detail(originalRunId)?.result as MeetingBriefRunResult;
    expect(original.delivery).toMatchObject({ status: "sent", messageId: "message-1" });

    people.correct(profile.id, { role: "Founder", note: "Corrected after original delivery." });
    const app = fastify({ logger: false });
    await host.routes(app);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: `/api/meeting-brief/runs/${originalRunId}/regenerate`,
    });
    expect(response.statusCode).toBe(202);
    const refreshedRunId = response.json<{ runId: string }>().runId;
    await host.idle();

    const failedRefresh = runs.detail(refreshedRunId)?.result as MeetingBriefRunResult;
    expect(runs.detail(refreshedRunId)).toMatchObject({ status: "failed", failedStage: "deliver" });
    expect(failedRefresh).toMatchObject({
      profileRefreshOf: originalRunId,
      personProfileLinks: [{ profileId: profile.id, profileRevision: 2 }],
    });
    expect(failedRefresh.delivery.deliveryId).not.toBe(original.delivery.deliveryId);
    expect(sendCalls).toBe(2);
    expect(sent.size).toBe(2);

    await host.retryRun(refreshedRunId);
    await host.idle();

    const reconciledRefresh = runs.detail(refreshedRunId)?.result as MeetingBriefRunResult;
    expect(reconciledRefresh.delivery).toMatchObject({
      status: "reconciled",
      deliveryId: failedRefresh.delivery.deliveryId,
      messageId: refreshedMessageId,
    });
    expect(sendCalls).toBe(2);
    expect(sent.size).toBe(2);
    await app.close();
  });
});
