import type { MeetingDebriefExtraction } from "@chief-of-staff-demo/shared";
import { describe, expect, it } from "vitest";
import type { TranscriptRecord } from "@chief-of-staff-demo/shared";
import {
  actionItemEvidence,
  buildDebriefMessages,
  clampDueDates,
  dropActionItemEvidence,
  stripFulfilledActionItems,
  stripRestatedDecisions,
  stripUnverifiedRecipientEmails,
} from "../../../apps/server/src/modules/meeting-debrief/extraction";
import type { DebriefIdentityReview } from "../../../apps/server/src/modules/meeting-debrief/host";

function makeRecord(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    id: "drive_fileA_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "fileA",
      fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
      sourceUrl: null,
      checksum: "deadbeef",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: "Alice: We decided to ship on Friday.\nBob: I will own the follow-up.\n",
    meetingDate: "2026-09-01",
    occurrence: null,
    speakers: ["Alice", "Bob"],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
    ...overrides,
  };
}

const EMPTY_IDENTITY: DebriefIdentityReview = { mentions: [], decisions: [], organizations: [] };

describe("meeting debrief trusted context", () => {
  it("anchors the meeting date with its weekday", () => {
    const messages = buildDebriefMessages(makeRecord(), EMPTY_IDENTITY);
    expect(messages.user).toContain("Meeting date: 2026-09-01 (Tuesday)");
  });

  it("lists the meeting week as a copyable date reference", () => {
    const messages = buildDebriefMessages(makeRecord(), EMPTY_IDENTITY);
    expect(messages.user).toContain("meeting day Tue 2026-09-01");
    expect(messages.user).toContain("Thu 2026-09-03");
    expect(messages.user).toContain("Sat 2026-09-05");
  });

  it("omits the date reference when the record has no parseable date", () => {
    const messages = buildDebriefMessages(makeRecord({ meetingDate: null }), EMPTY_IDENTITY);
    expect(messages.user).toContain("Meeting date: not provided");
    expect(messages.user).not.toContain("Date reference");
  });

  it("states empty identity so the model must leave mention ids null", () => {
    const messages = buildDebriefMessages(makeRecord(), EMPTY_IDENTITY);
    expect(messages.user).toContain("Identity review state: no mentions mined for this transcript");
  });
});

function makeExtraction(
  recipients: MeetingDebriefExtraction["suggestedRecipients"],
): MeetingDebriefExtraction {
  return {
    version: 1,
    summary: "summary",
    decisions: [],
    actionItems: [],
    openQuestions: [],
    effectivenessEvidence: "evidence",
    coachingAdvice: "advice",
    suggestedRecipients: recipients,
  };
}

describe("stripUnverifiedRecipientEmails", () => {
  it("strips a fabricated email but keeps the name", () => {
    const record = makeRecord({ normalizedText: "Alice: send this to Carol.\n" });
    const result = stripUnverifiedRecipientEmails(
      makeExtraction([{ name: "Carol", email: "carol@example.com" }]),
      record,
    );
    expect(result.suggestedRecipients).toEqual([{ name: "Carol", email: null }]);
  });

  it("keeps an email stated verbatim in the transcript", () => {
    const record = makeRecord({ normalizedText: "Alice: write to CAROL@Example.com please.\n" });
    const result = stripUnverifiedRecipientEmails(
      makeExtraction([{ name: "Carol", email: "carol@example.com" }]),
      record,
    );
    expect(result.suggestedRecipients).toEqual([{ name: "Carol", email: "carol@example.com" }]);
  });

  it("leaves a null email alone", () => {
    const result = stripUnverifiedRecipientEmails(
      makeExtraction([{ name: "Carol", email: null }]),
      makeRecord(),
    );
    expect(result.suggestedRecipients).toEqual([{ name: "Carol", email: null }]);
  });
});

describe("clampDueDates", () => {
  function withDueDates(dueDates: (string | null)[]): MeetingDebriefExtraction {
    return {
      ...makeExtraction([]),
      actionItems: dueDates.map((dueDate) => ({
        title: "Send the update",
        owner: null,
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate,
      })),
    };
  }

  it("keeps a dueDate the Date reference line can ground", () => {
    const clamped = clampDueDates(withDueDates(["2026-09-03"]), makeRecord());
    expect(clamped.actionItems[0]?.dueDate).toBe("2026-09-03");
  });

  it("nulls an invented dueDate outside the reference week", () => {
    const clamped = clampDueDates(withDueDates(["2026-07-28", null]), makeRecord());
    expect(clamped.actionItems.map((item) => item.dueDate)).toEqual([null, null]);
  });

  it("leaves the extraction untouched when the record has no meeting date", () => {
    const clamped = clampDueDates(withDueDates(["2026-07-28"]), makeRecord({ meetingDate: null }));
    expect(clamped.actionItems[0]?.dueDate).toBe("2026-07-28");
  });
});

describe("stripRestatedDecisions", () => {
  function withPair(decision: string, title: string): MeetingDebriefExtraction {
    return {
      ...makeExtraction([]),
      decisions: [{ statement: decision, evidence: null }],
      actionItems: [
        {
          title,
          owner: "Alice",
          ownerMentionId: null,
          ownerProfileId: null,
          dueDate: null,
        },
      ],
    };
  }

  it("drops a decision that embeds an action item's title", () => {
    const result = stripRestatedDecisions(
      withPair(
        "Richard will hold off on the YouTube ads this month",
        "Hold off on the YouTube ads",
      ),
    );
    expect(result.decisions).toEqual([]);
  });

  it("keeps a loose paraphrase that overlaps the action's content words", () => {
    // Same fact, different words: the scorer credits whichever phrasing
    // matches the golden, so the filter only removes containment twins.
    const result = stripRestatedDecisions(
      withPair(
        "We will put the prep document into the training content document folder",
        "Put the prep document into the training folder",
      ),
    );
    expect(result.decisions).toHaveLength(1);
  });

  it("keeps a decision phrased around the choice", () => {
    const result = stripRestatedDecisions(
      withPair("Scheduling for the first interaction runs through Calendly", "Set up Calendly"),
    );
    expect(result.decisions).toHaveLength(1);
  });

  it("keeps short statements where containment means nothing", () => {
    const result = stripRestatedDecisions(withPair("We decided on Calendly", "Send the email"));
    expect(result.decisions).toHaveLength(1);
  });
});

describe("stripFulfilledActionItems", () => {
  const transcript =
    "Alice: I already sent Bob the deck.\n" +
    "Alice: I sent the first half, and I'll send the rest tonight.\n" +
    "Bob: Can you add the glossary slide?\n";

  function withTitles(titles: string[]): MeetingDebriefExtraction {
    return {
      ...makeExtraction([]),
      actionItems: titles.map((title) => ({
        title,
        owner: null,
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
      })),
    };
  }

  const record = makeRecord({ normalizedText: transcript });

  it("drops an item whose own quote reports the work already done", () => {
    const stripped = stripFulfilledActionItems(
      withTitles(["Send Bob the deck", "Add the glossary slide"]),
      ["I already sent Bob the deck", "Can you add the glossary slide?"],
      record,
    );
    expect(stripped.actionItems.map((item) => item.title)).toEqual(["Add the glossary slide"]);
  });

  it("keeps an item whose quote also points forward", () => {
    const stripped = stripFulfilledActionItems(
      withTitles(["Send the rest of the deck"]),
      ["I sent the first half, and I'll send the rest tonight"],
      record,
    );
    expect(stripped.actionItems).toHaveLength(1);
  });

  it("keeps an item whose quote the transcript never says", () => {
    const stripped = stripFulfilledActionItems(
      withTitles(["Send the report"]),
      ["I already sent the report"],
      record,
    );
    expect(stripped.actionItems).toHaveLength(1);
  });

  it("keeps an item with no quote at all", () => {
    const stripped = stripFulfilledActionItems(withTitles(["Send the deck"]), [null], record);
    expect(stripped.actionItems).toHaveLength(1);
  });
});

describe("action item evidence quotes", () => {
  const raw = {
    version: 1,
    actionItems: [
      { evidence: "I'll send it over", title: "Send it", owner: "Alice" },
      { title: "Add the slide", owner: "Bob" },
    ],
  };

  it("reads one quote per action item, null where the model wrote none", () => {
    expect(actionItemEvidence(raw)).toEqual(["I'll send it over", null]);
  });

  it("drops the quotes so the Result Shape stays the Module's own", () => {
    const dropped = dropActionItemEvidence(raw) as typeof raw;
    expect(dropped.actionItems[0]).toEqual({ title: "Send it", owner: "Alice" });
    expect(dropped.version).toBe(1);
  });

  it("leaves a reply that carries no action items alone", () => {
    expect(dropActionItemEvidence({ version: 1 })).toEqual({ version: 1 });
    expect(actionItemEvidence(null)).toEqual([]);
  });
});
