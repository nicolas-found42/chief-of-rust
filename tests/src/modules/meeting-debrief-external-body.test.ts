import { describe, expect, it } from "vitest";
import type { MeetingDebriefExtraction } from "@chief-of-staff-demo/shared";
import { composeExternalDebriefBody } from "../../../apps/server/src/modules/meeting-debrief/externalBody";

/* Ticket #141, AC 3 and AC 4 — the external-safe body.
 *
 * The draft goes to people outside the Workspace. It carries what the meeting
 * produced and nothing about how the owner performed in it, nothing the
 * Catalog has not resolved, and no raw transcript quotation. */

const EXTRACTION: MeetingDebriefExtraction = {
  version: 1,
  summary: "We agreed the migration cutover date and who owns each step.",
  decisions: [
    {
      statement: "The cutover happens on 14 October.",
      /* A transcript quote: private evidence, and never external. */
      evidence: "Alice said 'look, the fourteenth is the only date that works, honestly'.",
    },
  ],
  actionItems: [
    {
      title: "Confirm the rollback plan",
      owner: "Alice",
      ownerMentionId: "mention_alice",
      ownerProfileId: "prof_alice",
      dueDate: "2026-10-07",
    },
    {
      title: "Chase the unresolved vendor question",
      owner: "Priya",
      ownerMentionId: "mention_priya",
      ownerProfileId: null,
      dueDate: null,
    },
    {
      /* The owner dropped this one in review; it is not a retained action. */
      title: "Rewrite the internal onboarding doc",
      owner: "Owner",
      ownerMentionId: null,
      ownerProfileId: "prof_owner",
      dueDate: null,
    },
  ],
  openQuestions: [{ question: "Who signs off the vendor contract?", raisedBy: "Alice" }],
  effectivenessEvidence: "The meeting ran twenty minutes over and lost the thread twice.",
  coachingAdvice: "Interrupt less and restate decisions before moving on.",
  suggestedRecipients: [{ name: "Priya", email: null }],
};

describe("Meeting Debrief external-safe body (#141)", () => {
  const body = composeExternalDebriefBody(EXTRACTION, [2]);

  it("carries what the meeting produced", () => {
    expect(body).toContain("We agreed the migration cutover date");
    expect(body).toContain("The cutover happens on 14 October.");
    /* A retained action with its owner and its date. */
    expect(body).toContain("Confirm the rollback plan");
    expect(body).toContain("Alice");
    expect(body).toContain("2026-10-07");
    expect(body).toContain("Who signs off the vendor contract?");
  });

  it("carries nothing about how the meeting went or what it quoted", () => {
    /* Coaching and effectiveness stay in Meeting Wizard (AC 4). */
    expect(body).not.toContain("Interrupt less");
    expect(body).not.toContain("twenty minutes over");
    /* The decision's transcript quote is source excerpt and private evidence. */
    expect(body).not.toContain("the only date that works");
    /* The dropped action is not a retained action. */
    expect(body).not.toContain("Rewrite the internal onboarding doc");
    /* Identity state is diagnostics: the reader sees a name, never whether
       the Catalog resolved it to a Profile. */
    expect(body).not.toContain("prof_alice");
    expect(body).not.toContain("mention_priya");
  });
});
