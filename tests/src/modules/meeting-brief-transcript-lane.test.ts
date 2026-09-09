import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MeetingBriefEnrichmentSection,
  MeetingBriefEvent,
  MeetingBriefProviderOutcomes,
} from "@chief-of-staff-demo/shared";
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
import {
  TRANSCRIPT_EVIDENCE_SOURCE_ID,
  type MeetingTranscriptEvidenceProvider,
} from "../../../apps/server/src/modules/meeting-brief-generator/transcriptEvidence";

/* Ticket #138 — the confirmed-transcript lane inside a real Brief Run.
 *
 * The unit test next door fixes the selection rule. This one fixes where the
 * rule sits in the pipeline: confirmed excerpts reach composition as one
 * enrichment section, pending similarity reaches only its own review
 * artifact, and the lane records a provider outcome like every other. */

const DUE_AT = "2026-08-28T11:00:00.000Z";
const START_AT = "2026-08-28T15:00:00.000Z";

function fixtureEvent(): MeetingBriefEvent {
  return {
    calendarId: "primary",
    eventId: "evt_transcript_lane",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Migration Review",
    startAt: START_AT,
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

/** The external attendee's bundle selects CRM; it has nothing to say here. */
const emptyHubSpot: HubSpotApi = {
  listContacts() {
    return Promise.resolve({ results: [] });
  },
  searchContactByEmail() {
    return Promise.resolve(null);
  },
  getAssociatedCompanyIds() {
    return Promise.resolve([]);
  },
  getCompany() {
    return Promise.resolve(null);
  },
  getAssociatedDealIds() {
    return Promise.resolve([]);
  },
  getDeal() {
    return Promise.resolve(null);
  },
  getAssociatedDealIdsForCompany() {
    return Promise.resolve([]);
  },
};

/** Both lanes, with one pending similarity hit that must never be composed. */
const transcriptEvidence: MeetingTranscriptEvidenceProvider = {
  collect() {
    return Promise.resolve({
      links: [
        {
          transcriptId: "drive_linked_r1",
          via: "person",
          excerpt: "Alice agreed to own the migration plan.",
          relevance: 0.4,
          meetingDate: "2026-08-01",
        },
      ],
      semantic: [
        {
          transcriptId: "drive_pending_r1",
          excerpt: "An unreviewed rumour about the migration slipping.",
          score: 0.97,
          meetingDate: "2026-08-20",
          reviewState: "pending",
        },
      ],
    });
  },
};

describe("Meeting Brief confirmed-transcript lane (#138)", () => {
  it("composes linked and undecided excerpts, and still offers the undecided for review", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "mb-transcript-lane-"));
    const runs = openRuns(workspaceDir);
    const configStore = new ConfigStore(join(workspaceDir, "config.json"));
    configStore.load();
    const host = new MeetingBriefHost({
      runs,
      workspaceDir,
      configStore,
      now: () => new Date(DUE_AT),
      log: () => {},
      gmailDeliveryProvider: {
        findByDeliveryId() {
          return Promise.resolve(null);
        },
        send() {
          return Promise.resolve({ messageId: "m-1", recipient: "owner@example.com" });
        },
      },
      completeBrief: completeFixtureBrief,
      enrichmentProviders: {
        gmailProvider: new FakeGmailProvider(),
        calendarHistoryProvider: new FakeCalendarHistoryProvider(),
        driveProvider: new FakeDriveProvider(),
        attendeeProfiles: new WorkspacePersonProfiles({
          store: new PersonProfileStore(mkdtempSync(join(tmpdir(), "mb-transcript-profiles-"))),
          now: () => new Date(DUE_AT),
          lifecycle: [],
        }),
        publicIntelligenceProvider: new FakePublicIntelligenceProvider(),
        getHubSpotApi: () => emptyHubSpot,
        transcriptEvidence,
      },
      getInternalDomains: () => ["example.com"],
    });

    host.scheduleOccurrence(fixtureEvent(), new Date(DUE_AT));
    const created = await host.processDueSchedules(new Date(DUE_AT));
    await host.idle();
    const runId = created[0];
    const run = runs.open(runId)!;

    const enrich = JSON.parse(run.readArtifact("enrich.json")!) as {
      sections: MeetingBriefEnrichmentSection[];
    };
    const section = enrich.sections.find((item) => item.source === TRANSCRIPT_EVIDENCE_SOURCE_ID);

    /* The confirmed link leads, and the undecided similarity follows it rather
       than being withheld: nothing in the product ever presented the queue that
       was supposed to confirm it, so requiring confirmation meant the lane was
       always empty. Its lower rank, not a gate, keeps it in its place. */
    expect(section?.status).toBe("completed");
    expect(section?.evidence).toEqual([
      "Alice agreed to own the migration plan.",
      "An unreviewed rumour about the migration slipping.",
    ]);

    /* Cited and still reviewable: the owner can reject it, which is the one
       decision that takes it back out. */
    const suggestions = JSON.parse(run.readArtifact("transcript-suggestions.json")!) as {
      suggestions: { transcriptId: string }[];
    };
    expect(suggestions.suggestions.map((item) => item.transcriptId)).toEqual(["drive_pending_r1"]);

    /* And the lane answers to the same completeness ledger as every other
       provider (#137), so a configured lane that fails is visible. */
    const ledger = JSON.parse(
      run.readArtifact("provider-outcomes.json")!,
    ) as MeetingBriefProviderOutcomes;
    expect(
      ledger.outcomes.find((outcome) => outcome.provider === TRANSCRIPT_EVIDENCE_SOURCE_ID)
        ?.outcome,
    ).toBe("completed");
  });
});
