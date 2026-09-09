import { describe, expect, it } from "vitest";
import type { MeetingBriefEnrichmentSection, MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import { composeBrief } from "../../../apps/server/src/modules/meeting-brief-generator/compose";
import { TRANSCRIPT_EVIDENCE_SOURCE_ID } from "../../../apps/server/src/modules/meeting-brief-generator/transcriptEvidence";

/* Ticket #138, AC 7 — unresolved identity mentions.
 *
 * A Transcript excerpt is quoted evidence, and quoted evidence names people.
 * None of those names is an attendee, a Related People fact, or anyone with
 * recipient authority: the Brief's guest list is the Calendar's, and nothing
 * a transcript says can add to it. The new lane feeds composition raw
 * transcript text, so that guarantee is worth pinning against this lane in
 * particular. */

const SNAPSHOT: MeetingBriefEvent & { occurrenceKey: string } = {
  occurrenceKey: "evt_unresolved::2026-08-28T15:00:00Z",
  calendarId: "primary",
  eventId: "evt_unresolved",
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

/* The excerpt names "Priya from the platform team" — a mention the Catalog
   has not resolved to any Profile. */
const SECTIONS: MeetingBriefEnrichmentSection[] = [
  {
    source: TRANSCRIPT_EVIDENCE_SOURCE_ID,
    status: "completed",
    evidence: ["Priya from the platform team owns the migration cutover."],
    references: [],
  },
];

describe("Meeting Brief unresolved identity mentions (#138)", () => {
  it("refuses a guest that came from a transcript mention rather than the Calendar", async () => {
    /* A model that reads the excerpt and helpfully promotes Priya to a guest,
       which is exactly the failure AC 7 forbids. */
    const complete = (): Promise<unknown> =>
      Promise.resolve({
        summary: "Migration review.",
        guests: [
          {
            email: "alice@external.co",
            name: "Alice",
            role: null,
            background: null,
            relationshipHistory: [],
            crmContext: null,
            talkingPoints: [],
            uncertainty: [],
            evidenceReferences: [],
          },
          {
            email: "priya@external.co",
            name: "Priya",
            role: "Platform team",
            background: null,
            relationshipHistory: [],
            crmContext: null,
            talkingPoints: [],
            uncertainty: [],
            evidenceReferences: [],
          },
        ],
        companies: [],
        conversationStarters: ["How is the cutover going?", "What is blocking the rollout?"],
        sourceReferences: [],
        missingEvidence: [],
        uncertainty: [],
      });

    await expect(
      composeBrief({
        now: () => new Date("2026-08-28T11:00:00.000Z"),
        getCompleteJson: () => complete,
        snapshot: SNAPSHOT,
        sections: SECTIONS,
        internalDomains: ["example.com"],
      }),
    ).rejects.toThrow(/priya@external\.co/i);
  });
});
