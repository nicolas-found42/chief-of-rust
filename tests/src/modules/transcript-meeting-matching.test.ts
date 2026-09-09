import { describe, expect, it } from "vitest";
import type { Meeting, TranscriptRecord } from "@chief-of-staff-demo/shared";
import {
  MEETING_MATCH_TOLERANCE_MS,
  MEETING_NAME_TIME_TOLERANCE_MS,
  findMatchingMeeting,
} from "../../../apps/server/src/meetings/matching";
/**
 * A Transcript finds its Meeting by file-name evidence plus corroboration
 * (issue #153): a bare title never links, an empty name never matches, and
 * ambiguity resolves to no match rather than a winner.
 */

describe("MEETING_MATCH_TOLERANCE_MS", () => {
  it("pins the stated one-day corroboration window", () => {
    expect(MEETING_MATCH_TOLERANCE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("pins the tighter window a name that states a time is held to", () => {
    expect(MEETING_NAME_TIME_TOLERANCE_MS).toBe(2 * 60 * 60 * 1000);
    // Narrower than a day, or a daily meeting is ambiguous with every name.
    expect(MEETING_NAME_TIME_TOLERANCE_MS).toBeLessThan(MEETING_MATCH_TOLERANCE_MS);
  });
});
const START = "2026-06-18T15:00:00.000Z";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting_a",
    occurrenceKey: "evt_a::2026-06-18T15:00:00Z",
    calendarEventId: "evt_a",
    occurrenceId: "2026-06-18T15:00:00Z",
    title: "Internal planning",
    startAt: START,
    endAt: "2026-06-18T16:00:00.000Z",
    participants: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
        self: true,
      },
      {
        email: "bob@internal.example.com",
        displayName: "Bob",
        responseStatus: "accepted",
        organizer: false,
        self: false,
      },
    ],
    cancelled: false,
    ineligibleReason: null,
    createdAt: "2026-06-18T09:00:00.000Z",
    updatedAt: "2026-06-18T09:00:00.000Z",
    ...overrides,
  };
}

function transcript(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    id: "t_1",
    source: {
      sourceSystem: "drive",
      externalFileId: "file_t_1",
      fileName: "Internal planning 2026-06-18.txt",
      sourceUrl: null,
      checksum: "sum_t_1",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-06-18T17:00:00.000Z",
    extractorVersion: 1,
    normalizedText: "Nothing much was said.",
    meetingDate: "2026-06-18",
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
    ...overrides,
  };
}

describe("findMatchingMeeting", () => {
  it("matches on filename timestamp plus title", () => {
    const found = findMatchingMeeting(transcript(), [meeting()]);
    expect(found?.id).toBe("meeting_a");
  });

  it("never links on a title alone without corroboration", () => {
    const lone = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_lone",
        fileName: "Internal planning notes.txt",
        sourceUrl: null,
        checksum: "sum_lone",
        observedRevision: 1,
        modifiedAt: null,
      },
      speakers: [],
    });
    expect(findMatchingMeeting(lone, [meeting()])).toBeNull();
  });

  it("links a title-only name with a speaker on the roster", () => {
    const withSpeaker = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_spk",
        fileName: "Internal planning notes.txt",
        sourceUrl: null,
        checksum: "sum_spk",
        observedRevision: 1,
        modifiedAt: null,
      },
      speakers: ["bob"],
    });
    expect(findMatchingMeeting(withSpeaker, [meeting()])?.id).toBe("meeting_a");
  });

  it("links a title-only name with a modification time inside tolerance", () => {
    const withMtime = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_mtime",
        fileName: "Internal planning notes.txt",
        sourceUrl: null,
        checksum: "sum_mtime",
        observedRevision: 1,
        modifiedAt: "2026-06-18T20:00:00.000Z",
      },
      speakers: [],
    });
    expect(findMatchingMeeting(withMtime, [meeting()])?.id).toBe("meeting_a");
  });

  it("never matches a name carrying neither title nor timestamp", () => {
    const empty = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_empty",
        fileName: "12345.mp3",
        sourceUrl: null,
        checksum: "sum_empty",
        observedRevision: 1,
        modifiedAt: "2026-06-18T15:30:00.000Z",
      },
      speakers: ["Bob"],
    });
    expect(findMatchingMeeting(empty, [meeting()])).toBeNull();
  });

  it("returns no match when the timestamp sits outside tolerance", () => {
    const far = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_far",
        fileName: "Internal planning 2026-06-10.txt",
        sourceUrl: null,
        checksum: "sum_far",
        observedRevision: 1,
        modifiedAt: null,
      },
      speakers: ["Bob"],
    });
    expect(findMatchingMeeting(far, [meeting()])).toBeNull();
  });

  it("returns no match when two meetings qualify rather than picking a winner", () => {
    const rivals = [
      meeting({ id: "meeting_a" }),
      meeting({
        id: "meeting_b",
        occurrenceKey: "evt_b::2026-06-18T15:00:00Z",
        calendarEventId: "evt_b",
      }),
    ];
    expect(findMatchingMeeting(transcript(), rivals)).toBeNull();
  });

  it("ignores transcript-owned Meetings, so a duplicate transcript cannot block the Calendar match", () => {
    /* Drive holds two copies of one meeting's transcript. The first copy's
       Meeting used to qualify alongside the real Calendar occurrence, making
       the count two and killing the match for both copies — which is why no
       transcript in the corpus was ever linked. A Meeting a Transcript owns is
       the outcome of failing to match, never a candidate for one. */
    const shell = meeting({
      id: "meeting_transcript_t_0",
      occurrenceKey: null,
      calendarEventId: null,
      occurrenceId: null,
    });
    const found = findMatchingMeeting(transcript(), [shell, meeting()]);

    expect(found?.id).toBe("meeting_a");
  });

  it("pins a name that states a time to that time, so a daily meeting stays unambiguous", () => {
    /* A stand-up held every weekday puts two or three occurrences inside a day
       of any exact timestamp, and the rule that refuses to pick a winner then
       refused every one of them — which is why no recurring meeting in the
       corpus ever linked. A stated time names the meeting's own start. */
    const named = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_named",
        fileName: "Internal planning-transcript-2026-06-18T15-00-00.000Z.md",
        sourceUrl: null,
        checksum: "sum_named",
        observedRevision: 1,
        modifiedAt: null,
      },
    });
    const daily = [
      meeting(),
      meeting({
        id: "meeting_yesterday",
        occurrenceKey: "evt_a::2026-06-17T15:00:00Z",
        occurrenceId: "2026-06-17T15:00:00Z",
        startAt: "2026-06-17T15:00:00.000Z",
        endAt: "2026-06-17T16:00:00.000Z",
      }),
      meeting({
        id: "meeting_tomorrow",
        occurrenceKey: "evt_a::2026-06-19T15:00:00Z",
        occurrenceId: "2026-06-19T15:00:00Z",
        startAt: "2026-06-19T15:00:00.000Z",
        endAt: "2026-06-19T16:00:00.000Z",
      }),
    ];

    expect(findMatchingMeeting(named, daily)?.occurrenceKey).toBe("evt_a::2026-06-18T15:00:00Z");
  });

  it("refuses a Meeting whose title disagrees, when the name states a title and a time", () => {
    /* A stand-up transcript was qualifying against an unrelated meeting ninety
       minutes away, corroborated only by a day-old file time — and the two
       qualifiers then cancelled each other out, so neither linked. */
    const named = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_named",
        fileName: "Internal planning-transcript-2026-06-18T15-00-00.000Z.md",
        sourceUrl: null,
        checksum: "sum_named",
        observedRevision: 1,
        modifiedAt: "2026-06-18T16:00:00.000Z",
      },
      speakers: ["Bob"],
    });
    const alsoNearby = meeting({
      id: "meeting_other",
      occurrenceKey: "evt_b::2026-06-18T16:30:00Z",
      calendarEventId: "evt_b",
      occurrenceId: "2026-06-18T16:30:00Z",
      title: "Real Meeting_1",
      startAt: "2026-06-18T16:30:00.000Z",
      endAt: "2026-06-18T17:00:00.000Z",
    });

    expect(findMatchingMeeting(named, [meeting(), alsoNearby])?.id).toBe("meeting_a");
  });

  it("keeps the day-wide window for a name that states only a date", () => {
    // `Internal planning 2026-06-18.txt` names no time; the meeting starts at
    // 15:00, so only the day window can reach it.
    expect(findMatchingMeeting(transcript(), [meeting()])?.id).toBe("meeting_a");
  });

  it("returns no match when only a transcript-owned Meeting would qualify", () => {
    const shell = meeting({
      id: "meeting_transcript_t_0",
      occurrenceKey: null,
      calendarEventId: null,
      occurrenceId: null,
    });
    expect(findMatchingMeeting(transcript(), [shell])).toBeNull();
  });
});

/* The standing pass lives behind the Meeting join (issue #165); its behavior
   is covered through WorkspaceMeetingJoin in meeting-join.test.ts. */
