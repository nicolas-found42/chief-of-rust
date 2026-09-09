import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptRecord } from "@chief-of-staff-demo/shared";
import { TranscriptRelevanceService } from "../../../apps/server/src/transcript-catalog/relevance";
import { TranscriptRelevanceStore } from "../../../apps/server/src/transcript-catalog/relevance-store";
import { catalogTranscriptEvidence } from "../../../apps/server/src/modules/meeting-brief-generator/catalogTranscriptEvidence";

/* Ticket #138, AC 1 and AC 2 against the real Catalog rather than a fake:
 * confirmed person, organization and meeting-series links are built from what
 * the Workspace already holds, and semantic discovery returns unlinked
 * candidates only. */

function transcript(overrides: Partial<TranscriptRecord> & { id: string }): TranscriptRecord {
  return {
    source: {
      sourceSystem: "drive",
      externalFileId: `file_${overrides.id}`,
      fileName: `${overrides.id}.txt`,
      sourceUrl: null,
      checksum: `sum_${overrides.id}`,
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-01T00:00:00.000Z",
    extractorVersion: 1,
    normalizedText: "Nothing much was said.",
    meetingDate: "2026-08-01",
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
    ...overrides,
  };
}

describe("Catalog-backed transcript evidence (#138)", () => {
  it("builds one link per Transcript at its strongest lane and leaves linked Transcripts out of discovery", async () => {
    const records: TranscriptRecord[] = [
      /* Alice is in the room today and was in this one: person lane. */
      transcript({
        id: "t_person",
        normalizedText: "Alice agreed to own the migration plan.",
        roster: [{ displayName: "Alice", email: "alice@external.co" }],
      }),
      /* Nobody from today, but someone at Alice's company: organization lane. */
      transcript({
        id: "t_org",
        normalizedText: "Acme's procurement team reviewed the contract.",
        roster: [{ displayName: "Bob", email: "bob@external.co" }],
      }),
      /* No roster overlap at all, but a prior occurrence of this series. */
      transcript({
        id: "t_series",
        normalizedText: "Last week's standing review covered the rollout.",
        roster: [{ displayName: "Carol", email: "carol@elsewhere.io" }],
        occurrence: { occurrenceKey: "evt_series::2026-08-21", calendarEventId: "evt_series" },
      }),
      /* Unrelated, and reachable only by similarity. */
      transcript({
        id: "t_unrelated",
        normalizedText: "A migration was mentioned by someone unrelated.",
        roster: [{ displayName: "Dave", email: "dave@other.net" }],
      }),
    ];

    const relevance = new TranscriptRelevanceService({
      corpus: { listTranscripts: () => records },
      store: new TranscriptRelevanceStore(mkdtempSync(join(tmpdir(), "mb-cat-relevance-"))),
      now: () => new Date("2026-08-28T11:00:00.000Z"),
    });

    const provider = catalogTranscriptEvidence({
      listTranscripts: () => records,
      relevance,
    });

    const collected = await provider.collect({
      occurrenceKey: "evt_series::2026-08-28",
      calendarEventId: "evt_series",
      title: "Migration Review",
      attendees: ["alice@external.co"],
      organizations: ["external.co"],
    });

    expect(collected.links.map((link) => [link.transcriptId, link.via])).toEqual([
      ["t_person", "person"],
      ["t_org", "organization"],
      ["t_series", "meeting-series"],
    ]);

    /* t_person is linked and matches the meeting vocabulary, so the index
       returned it — but it arrives as evidence through its link, not as a
       second review item. Only the genuinely unlinked hit is a suggestion,
       and it is pending until the owner says otherwise. */
    expect(collected.semantic.map((item) => item.transcriptId)).toEqual(["t_unrelated"]);
    expect(collected.semantic[0]?.reviewState).toBe("pending");
  });
});
