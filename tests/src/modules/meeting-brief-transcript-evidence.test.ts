import { describe, expect, it } from "vitest";
import { selectTranscriptEvidence } from "../../../apps/server/src/modules/meeting-brief-generator/transcriptEvidence";

/**
 * #138's discrimination, as it now stands: strength of relationship orders the
 * evidence, and only an owner's rejection keeps a candidate out.
 *
 * Confirmation used to be required before a similarity hit could be cited,
 * which meant every one of them waited on a review queue no product surface
 * ever presented — the lane was always empty. Undecided similarity is cited,
 * ranked below every lane the Workspace can vouch for, and still offered for
 * review.
 */
describe("Meeting Brief transcript evidence selection (#138)", () => {
  it("cites links first, then confirmed similarity, then undecided similarity", () => {
    const selection = selectTranscriptEvidence({
      links: [
        {
          transcriptId: "drive_linked_r1",
          via: "person",
          excerpt: "Alice agreed to own the migration plan.",
          relevance: 0.4,
          meetingDate: "2026-02-01",
        },
      ],
      semantic: [
        {
          transcriptId: "drive_pending_r1",
          excerpt: "Someone mentioned a migration in another meeting.",
          score: 0.91,
          meetingDate: "2026-02-10",
          reviewState: "pending",
        },
        {
          transcriptId: "drive_confirmed_r1",
          excerpt: "We confirmed the migration date last week.",
          score: 0.62,
          meetingDate: "2026-02-05",
          reviewState: "confirmed",
        },
      ],
    });

    /* Relationship strength orders them: the person link, then the similarity
       the owner confirmed, then the undecided one — whose higher score still
       does not buy it past either. */
    expect(selection.evidence.map((item) => item.transcriptId)).toEqual([
      "drive_linked_r1",
      "drive_confirmed_r1",
      "drive_pending_r1",
    ]);

    /* Cited, and still offered for review, so the owner can confirm or reject
       it — rejecting is the one decision that removes it. */
    expect(selection.suggestions.map((item) => item.transcriptId)).toEqual(["drive_pending_r1"]);
  });
});

/**
 * AC 3: retrieval ranks relationship strength, meeting relevance and recency,
 * and passes a *bounded* cited excerpt set into composition. The order is
 * lexicographic over those three keys in that priority, so a strong
 * relationship outranks a strong similarity score rather than competing with
 * it on one blended number.
 */
describe("Meeting Brief transcript evidence ranking (#138)", () => {
  it("ranks relationship strength over relevance over recency and bounds the set", () => {
    const selection = selectTranscriptEvidence(
      {
        links: [
          {
            transcriptId: "series_older",
            via: "meeting-series",
            excerpt: "Standing agenda from the previous series meeting.",
            relevance: 0.9,
            meetingDate: "2026-01-05",
          },
          {
            transcriptId: "person_weak",
            via: "person",
            excerpt: "Alice mentioned the timeline in passing.",
            relevance: 0.1,
            meetingDate: "2026-01-02",
          },
          {
            transcriptId: "org_recent",
            via: "organization",
            excerpt: "Acme confirmed the contract terms.",
            relevance: 0.5,
            meetingDate: "2026-02-20",
          },
          {
            transcriptId: "person_recent",
            via: "person",
            excerpt: "Alice owns the migration plan.",
            relevance: 0.1,
            meetingDate: "2026-03-01",
          },
        ],
        semantic: [
          {
            transcriptId: "semantic_confirmed",
            excerpt: "A confirmed similarity hit with a very high score.",
            score: 0.99,
            meetingDate: "2026-04-01",
            reviewState: "confirmed",
          },
        ],
      },
      { limit: 3 },
    );

    /* person(2) before organization(1) before meeting-series(0), and a
       confirmed similarity hit ranks below every confirmed link however high
       it scored. Within `person`, equal relevance breaks to the more recent
       meeting. The bound then cuts the tail — meeting-series and the
       semantic hit fall out, and neither can be cited. */
    expect(selection.evidence.map((item) => item.transcriptId)).toEqual([
      "person_recent",
      "person_weak",
      "org_recent",
    ]);
  });
});
