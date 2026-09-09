import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Meeting, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";
import {
  MeetingJoinError,
  WorkspaceMeetingJoin,
  type MeetingJoinDeps,
} from "../../../apps/server/src/meetings/join";

/**
 * One deep module owns the Transcript ↔ Meeting join (issue #165): the
 * standing match-plus-attach pass, the idempotent single attach, and the
 * orphan merge all cross this interface, so no caller sequences Meeting file
 * reads around it.
 */
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

function harness(seed: { meetings: Meeting[]; transcripts: TranscriptRecord[] }) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-meeting-join-"));
  const meetings = new WorkspaceMeetings(workspaceDir);
  for (const seedMeeting of seed.meetings) {
    meetings.upsertFromCalendar({
      occurrenceKey: seedMeeting.occurrenceKey!,
      calendarEventId: seedMeeting.calendarEventId!,
      occurrenceId: seedMeeting.occurrenceId!,
      title: seedMeeting.title,
      startAt: seedMeeting.startAt,
      endAt: seedMeeting.endAt,
      participants: seedMeeting.participants,
      cancelled: seedMeeting.cancelled,
      ineligibleReason: seedMeeting.ineligibleReason,
    });
  }
  // The store owns Meeting ids; the calendar shell is found by occurrence key.
  const calendarId = meetings.findByOccurrenceKey("evt_a::2026-06-18T15:00:00Z")!.id;
  const transcripts = seed.transcripts.map((record) => ({
    ...record,
    meetingId: record.meetingId === "meeting_a" ? calendarId : record.meetingId,
  }));
  const attachMeeting = vi.fn(async (transcriptId: string, matched: { id: string }) => {
    const record = transcripts.find((candidate) => candidate.id === transcriptId);
    if (!record) throw new Error(`Unknown transcript: ${transcriptId}`);
    record.meetingId = matched.id;
    return record;
  });
  const deps: MeetingJoinDeps = {
    meetings,
    listTranscripts: () => transcripts.map((record) => ({ ...record })),
    attachMeeting,
  };
  return { join: new WorkspaceMeetingJoin(deps), meetings, calendarId, transcripts, attachMeeting };
}

describe("WorkspaceMeetingJoin.attachTranscript", () => {
  it("attaching the same Transcript twice writes once", async () => {
    const seeded = harness({ meetings: [meeting()], transcripts: [transcript()] });
    const matched = {
      id: seeded.calendarId,
      occurrenceKey: "evt_a::2026-06-18T15:00:00Z",
      calendarEventId: "evt_a",
      roster: [],
    };
    await seeded.join.attachTranscript("t_1", matched);
    await seeded.join.attachTranscript("t_1", matched);
    expect(seeded.attachMeeting).toHaveBeenCalledTimes(1);
    expect(seeded.transcripts.find((record) => record.id === "t_1")?.meetingId).toBe(
      seeded.calendarId,
    );
  });
});

describe("WorkspaceMeetingJoin.mergeTranscriptShell", () => {
  it("a near-miss merge deletes no Meeting data", async () => {
    const seeded = harness({
      meetings: [meeting()],
      transcripts: [transcript({ id: "t_orphan" })],
    });
    // The Transcript owns its Meeting shell; the near-miss target is unknown.
    const source = seeded.meetings.createFromTranscript({
      transcriptId: "t_orphan",
      title: "Orphan sync",
      speakers: ["Owner", "Bob"],
      modifiedAt: "2026-06-19T15:00:00.000Z",
    });
    seeded.transcripts.find((record) => record.id === "t_orphan")!.meetingId = source.id;
    await expect(
      seeded.join.mergeTranscriptShell(source.id, "evt_missing::2026-06-19T15:00:00Z"),
    ).rejects.toMatchObject({ code: "target-meeting-not-found" });
    expect(seeded.meetings.get(source.id)).not.toBeNull();
    expect(seeded.meetings.get(seeded.calendarId)).not.toBeNull();
    expect(seeded.attachMeeting).not.toHaveBeenCalled();
    expect(seeded.transcripts.find((record) => record.id === "t_orphan")?.meetingId).toBe(
      source.id,
    );
  });

  it("carries the shell's Transcripts across, then forgets the shell", async () => {
    const seeded = harness({ meetings: [meeting()], transcripts: [] });
    const source = seeded.meetings.createFromTranscript({
      transcriptId: "t_orphan",
      title: "Orphan sync",
      speakers: ["Owner", "Bob"],
      modifiedAt: "2026-06-19T15:00:00.000Z",
    });
    seeded.transcripts.push(transcript({ id: "t_orphan", meetingId: source.id }));
    const merged = await seeded.join.mergeTranscriptShell(source.id, "evt_a::2026-06-18T15:00:00Z");
    expect(merged.id).toBe(seeded.calendarId);
    expect(seeded.meetings.get(source.id)).toBeNull();
    expect(seeded.meetings.get(seeded.calendarId)).not.toBeNull();
    expect(seeded.transcripts.find((record) => record.id === "t_orphan")?.meetingId).toBe(
      seeded.calendarId,
    );
  });
});

describe("WorkspaceMeetingJoin.associateTranscripts", () => {
  it("gives every unlinked transcript a Meeting, matched or its own", async () => {
    const seeded = harness({
      meetings: [meeting()],
      transcripts: [
        transcript({ id: "t_match" }),
        transcript({
          id: "t_linked",
          meetingId: "meeting_a",
          roster: [{ displayName: "Owner", email: "owner@example.com" }],
        }),
        transcript({
          id: "t_nomatch",
          source: {
            sourceSystem: "drive",
            externalFileId: "file_nomatch",
            fileName: "12345.mp3",
            sourceUrl: null,
            checksum: "sum_nomatch",
            observedRevision: 1,
            modifiedAt: null,
          },
        }),
      ],
    });
    const result = await seeded.join.associateTranscripts();
    /* Both unlinked transcripts get a Meeting: one matches the Calendar
       occurrence, and one whose file name says nothing usable owns its own.
       A meeting only a transcript attests to still happened, and the Meeting
       Wizard is where the workspace looks for it. The already-linked record is
       left alone. */
    expect(result).toEqual({ linked: 2 });
    expect(seeded.attachMeeting).toHaveBeenCalledTimes(2);
    expect(seeded.attachMeeting).toHaveBeenCalledWith(
      "t_match",
      expect.objectContaining({ id: seeded.calendarId }),
    );
    expect(seeded.attachMeeting).toHaveBeenCalledWith(
      "t_nomatch",
      expect.objectContaining({ occurrenceKey: null }),
    );
    expect(seeded.attachMeeting).not.toHaveBeenCalledWith("t_linked", expect.anything());
  });

  it("re-matches a Transcript sitting on a Meeting it owns once Calendar has the occurrence", async () => {
    /* Calendar arrives late — the backward history read is one reconcile
       behind the first join, and an occurrence can be created after its own
       transcript. A Transcript that fell back to owning a Meeting is not a
       settled placement, so it is offered to the match again, and the shell it
       leaves behind is forgotten. */
    const seeded = harness({ meetings: [meeting()], transcripts: [transcript({ id: "t_shell" })] });
    // The state the broken history read left behind: the Transcript owns a
    // Meeting of its own even though its occurrence is on the Calendar.
    const shell = seeded.meetings.createFromTranscript({
      transcriptId: "t_shell",
      title: "Internal planning",
      speakers: [],
      modifiedAt: null,
      meetingDate: "2026-06-18",
    });
    seeded.transcripts.find((record) => record.id === "t_shell")!.meetingId = shell.id;

    const result = await seeded.join.associateTranscripts();

    expect(result).toEqual({ linked: 1 });
    expect(seeded.transcripts.find((record) => record.id === "t_shell")?.meetingId).toBe(
      seeded.calendarId,
    );
    expect(seeded.meetings.get(shell.id)).toBeNull();
  });

  it("keeps the shell when nothing on Calendar matches it", async () => {
    const seeded = harness({ meetings: [meeting()], transcripts: [] });
    const shell = seeded.meetings.createFromTranscript({
      transcriptId: "t_nomatch",
      title: "Unplaceable",
      speakers: [],
      modifiedAt: null,
    });
    seeded.transcripts.push(
      transcript({
        id: "t_nomatch",
        meetingId: shell.id,
        source: {
          sourceSystem: "drive",
          externalFileId: "file_nomatch",
          fileName: "12345.mp3",
          sourceUrl: null,
          checksum: "sum_nomatch",
          observedRevision: 1,
          modifiedAt: null,
        },
      }),
    );

    const result = await seeded.join.associateTranscripts();

    expect(result).toEqual({ linked: 0 });
    expect(seeded.meetings.get(shell.id)).not.toBeNull();
    expect(seeded.attachMeeting).not.toHaveBeenCalled();
  });

  it("carries Calendar's attendees across with the association", async () => {
    /* The association wrote the occurrence but never the roster, so a linked
       Transcript still had an empty one — and its Debrief asked the owner to
       type in the attendees the Meeting beside it already held. */
    const seeded = harness({ meetings: [meeting()], transcripts: [transcript({ id: "t_match" })] });

    await seeded.join.associateTranscripts();

    expect(seeded.attachMeeting).toHaveBeenCalledWith(
      "t_match",
      expect.objectContaining({
        id: seeded.calendarId,
        roster: [
          { displayName: "Owner", email: "owner@example.com" },
          { displayName: "Bob", email: "bob@internal.example.com" },
        ],
      }),
    );
  });

  it("gives a Meeting a Transcript owns no Calendar roster to carry", async () => {
    const seeded = harness({
      meetings: [meeting()],
      transcripts: [
        transcript({
          id: "t_nomatch",
          source: {
            sourceSystem: "drive",
            externalFileId: "file_nomatch",
            fileName: "12345.mp3",
            sourceUrl: null,
            checksum: "sum_nomatch",
            observedRevision: 1,
            modifiedAt: null,
          },
        }),
      ],
    });

    await seeded.join.associateTranscripts();

    expect(seeded.attachMeeting).toHaveBeenCalledWith(
      "t_nomatch",
      expect.objectContaining({ occurrenceKey: null, roster: [] }),
    );
  });

  it("never re-matches a Transcript already on a Calendar Meeting", async () => {
    const seeded = harness({
      meetings: [meeting()],
      transcripts: [
        transcript({
          id: "t_linked",
          meetingId: "meeting_a",
          roster: [{ displayName: "Owner", email: "owner@example.com" }],
        }),
      ],
    });

    const result = await seeded.join.associateTranscripts();

    expect(result).toEqual({ linked: 0 });
    expect(seeded.attachMeeting).not.toHaveBeenCalled();
  });

  it("gives a settled Transcript the roster its Meeting holds, without re-matching it", async () => {
    /* An earlier build wrote the occurrence and nothing else. The placement
       stays exactly as it was; only the attendees it was missing arrive. */
    const seeded = harness({
      meetings: [meeting()],
      transcripts: [transcript({ id: "t_linked", meetingId: "meeting_a", roster: [] })],
    });

    const result = await seeded.join.associateTranscripts();

    expect(result).toEqual({ linked: 0 });
    expect(seeded.attachMeeting).toHaveBeenCalledWith(
      "t_linked",
      expect.objectContaining({
        id: seeded.calendarId,
        roster: [
          { displayName: "Owner", email: "owner@example.com" },
          { displayName: "Bob", email: "bob@internal.example.com" },
        ],
      }),
    );
  });
});

describe("MeetingJoinError", () => {
  it("carries its code", () => {
    expect(new MeetingJoinError("meeting-not-found").code).toBe("meeting-not-found");
  });
});
