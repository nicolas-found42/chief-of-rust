import { describe, expect, it } from "vitest";
import { meetingFileNameMeta, recordingKey } from "../../../apps/server/src/text/meetingFileName";

/**
 * A Transcript's file name is the primary evidence for its Meeting (issue
 * #153): the title and, when present, the full timestamp.
 */
describe("meetingFileNameMeta", () => {
  it("recovers the title and timestamp from a Fireflies export name", () => {
    expect(meetingFileNameMeta("Team Sync-2026-06-18T13-00-00.000Z.mp3")).toEqual({
      title: "Team Sync",
      timestamp: "2026-06-18T13:00:00.000Z",
      namesTime: true,
    });
  });

  it("recovers a leading date and time with the title that follows", () => {
    expect(meetingFileNameMeta("2026-06-18 13.00 Team Sync.txt")).toEqual({
      title: "Team Sync",
      timestamp: "2026-06-18T13:00:00.000Z",
      namesTime: true,
    });
  });

  it("recovers a trailing date as midnight UTC with the title before it", () => {
    expect(meetingFileNameMeta("Team Sync 2026-06-18.txt")).toEqual({
      title: "Team Sync",
      timestamp: "2026-06-18T00:00:00.000Z",
      // Midnight is padding here, not a time the name stated.
      namesTime: false,
    });
  });

  it("recovers a plain title with no timestamp", () => {
    expect(meetingFileNameMeta("Team Sync notes.txt")).toEqual({
      title: "Team Sync notes",
      timestamp: null,
      namesTime: false,
    });
  });

  it("returns neither title nor timestamp for a name carrying neither", () => {
    expect(meetingFileNameMeta("12345.mp3")).toEqual({
      title: null,
      timestamp: null,
      namesTime: false,
    });
  });

  it("keeps the timestamp when the remainder carries no words", () => {
    expect(meetingFileNameMeta("2026-06-18.txt")).toEqual({
      title: null,
      timestamp: "2026-06-18T00:00:00.000Z",
      namesTime: false,
    });
  });
});

/**
 * Grouping copies of one recording is a different question from naming a
 * meeting, so `recordingKey` is blunter than the display title on purpose.
 */
describe("recordingKey", () => {
  it("gives Drive's copies of one export the same key", () => {
    expect(recordingKey("Copy of Abhinav- Richard-transcript-2026-06-18T13-00-00.000Z.json")).toBe(
      recordingKey("Copy of Copy of Abhinav- Richard-transcript-2026-06-18T13-00-00.000Z.json"),
    );
  });

  it("gives two export formats of one meeting the same key", () => {
    expect(recordingKey("Team Sync-transcript-2026-06-18T13-00-00.000Z.json")).toBe(
      recordingKey("Team Sync-transcript-2026-06-18T13-00-00.000Z.md"),
    );
  });

  it("gives a transcript and its summary the same key", () => {
    expect(recordingKey("Team Sync_transcript.txt")).toBe(recordingKey("Team Sync_summary.txt"));
  });

  it("keeps two occurrences of a recurring meeting apart", () => {
    expect(recordingKey("Team Sync-transcript-2026-06-18T13-00-00.000Z.md")).not.toBe(
      recordingKey("Team Sync-transcript-2026-06-19T13-00-00.000Z.md"),
    );
  });

  it("keeps two different meetings apart", () => {
    expect(recordingKey("Team Sync-transcript-2026-06-18T13-00-00.000Z.md")).not.toBe(
      recordingKey("Board Review-transcript-2026-06-18T13-00-00.000Z.md"),
    );
  });

  it("has no key for a name that says nothing to group on", () => {
    expect(recordingKey("12345.mp3")).toBeNull();
  });
});
