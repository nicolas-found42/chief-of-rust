import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import { openRuns } from "../../../apps/server/src/runs";
import { MeetingBriefHost } from "../../../apps/server/src/modules/meeting-brief-generator/host";
import { completeFixtureBrief } from "../../../apps/server/src/modules/meeting-brief-generator/testRuntime";
import { ConfigStore } from "../../../apps/server/src/config";
import { FakeGmailProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail";
import { FakeCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory";
import { FakeDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive";
import { FakePublicIntelligenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/enrichment/publicIntelligence";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import type { MeetingTranscriptEvidenceProvider } from "../../../apps/server/src/modules/meeting-brief-generator/transcriptEvidence";

/* Ticket #138, AC 5 and AC 6 — late evidence.
 *
 * Confirming a suggestion after a Brief was already delivered must offer an
 * explicit regeneration and must not, by itself, send anything. The owner's
 * subsequent regeneration produces a new revision that supersedes the old
 * one and delivers under the unchanged owner-only policy. */

const DUE_AT = "2026-08-28T11:00:00.000Z";

const emptyHubSpot: HubSpotApi = {
  listContacts: () => Promise.resolve({ results: [] }),
  searchContactByEmail: () => Promise.resolve(null),
  getAssociatedCompanyIds: () => Promise.resolve([]),
  getCompany: () => Promise.resolve(null),
  getAssociatedDealIds: () => Promise.resolve([]),
  getDeal: () => Promise.resolve(null),
  getAssociatedDealIdsForCompany: () => Promise.resolve([]),
};

function fixtureEvent(): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_late_evidence",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Migration Review",
    startAt: "2026-08-28T15:00:00.000Z",
    endAt: "2026-08-28T15:30:00.000Z",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
      },
    ],
    attachments: [],
    status: "confirmed",
  };
}

/** One pending suggestion, which the owner will confirm after delivery. */
const transcriptEvidence: MeetingTranscriptEvidenceProvider = {
  collect: () =>
    Promise.resolve({
      links: [],
      semantic: [
        {
          transcriptId: "drive_late_r1",
          excerpt: "The rollout date moved to October.",
          score: 0.8,
          meetingDate: "2026-08-20",
          reviewState: "pending",
        },
      ],
    }),
};

function makeHost(): {
  host: MeetingBriefHost;
  sends: () => number;
  runs: ReturnType<typeof openRuns>;
} {
  const workspaceDir = mkdtempSync(join(tmpdir(), "mb-late-evidence-"));
  const runs = openRuns(workspaceDir);
  const configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  let sends = 0;
  const host = new MeetingBriefHost({
    runs,
    workspaceDir,
    configStore,
    now: () => new Date(DUE_AT),
    log: () => {},
    gmailDeliveryProvider: {
      findByDeliveryId: () => Promise.resolve(null),
      send: () => {
        sends += 1;
        return Promise.resolve({ messageId: `m-${sends}`, recipient: "owner@example.com" });
      },
    },
    completeBrief: completeFixtureBrief,
    enrichmentProviders: {
      gmailProvider: new FakeGmailProvider(),
      calendarHistoryProvider: new FakeCalendarHistoryProvider(),
      driveProvider: new FakeDriveProvider(),
      attendeeProfiles: new WorkspacePersonProfiles({
        store: new PersonProfileStore(mkdtempSync(join(tmpdir(), "mb-late-profiles-"))),
        now: () => new Date(DUE_AT),
        lifecycle: [],
      }),
      publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
      getHubSpotApi: () => emptyHubSpot,
      transcriptEvidence,
    },
    getInternalDomains: () => ["example.com"],
  });
  return { host, sends: () => sends, runs };
}

describe("Meeting Brief late transcript evidence (#138)", () => {
  it("offers regeneration on confirmation and sends nothing until the owner asks", async () => {
    const { host, sends, runs } = makeHost();
    host.scheduleOccurrence(fixtureEvent(), new Date(DUE_AT));
    const created = await host.processDueSchedules(new Date(DUE_AT));
    await host.idle();
    const runId = created[0];
    const deliveredSends = sends();

    /* The owner confirms the suggestion long after the Brief went out. */
    const affected = host.noteConfirmedTranscriptEvidence("drive_late_r1");
    expect(affected).toEqual([runId]);

    /* AC 5: a notice, not a revision. Nothing was regenerated and nothing
       was sent — a surprise second Brief in the owner's inbox is exactly
       what this must not do. */
    expect(sends()).toBe(deliveredSends);
    const notice = runs
      .detail(runId)!
      .events.find((event) => event.type === "brief_evidence_confirmed_late");
    expect(notice?.detail).toMatchObject({
      transcriptId: "drive_late_r1",
      action: "regenerate",
    });
    expect(runs.list({}).runs).toHaveLength(1);

    /* AC 6: the owner's explicit regeneration is what creates the revision,
       and it supersedes the Run the notice was attached to. */
    const regeneratedId = await host.regenerateRun(runId);
    await host.idle();
    expect(regeneratedId).not.toBe(runId);
    const entry = host.index().briefs.find((brief) => brief.runId === regeneratedId);
    expect(entry?.supersedes).toBe(runId);
  });
});
