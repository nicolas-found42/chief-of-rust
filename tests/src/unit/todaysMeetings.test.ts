import type { Meeting } from "@chief-of-staff-demo/shared";
import { describe, expect, it } from "vitest";
import { todaysMeetings } from "../../../apps/web/src/todaysMeetings";

/**
 * The Meeting Wizard home lists today's Meetings (issue #151): the day window
 * is the browser's local day, and the list is in start order regardless of the
 * order the Meeting store returned. Every date below is built from a local
 * midnight, so the assertions hold in the runner's own timezone.
 */

const DAY = new Date(2026, 8, 2); // local midnight, 2026-09-02
const NOW = new Date(DAY.getTime() + 10 * 60 * 60 * 1000);

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting_1",
    occurrenceKey: null,
    calendarEventId: null,
    occurrenceId: null,
    title: "A meeting",
    startAt: new Date(DAY.getTime() + 15 * 60 * 60 * 1000).toISOString(),
    endAt: new Date(DAY.getTime() + 15.5 * 60 * 60 * 1000).toISOString(),
    participants: [],
    cancelled: false,
    ineligibleReason: null,
    createdAt: new Date(DAY.getTime() + 9 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(DAY.getTime() + 9 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const at = (hours: number) => new Date(DAY.getTime() + hours * 60 * 60 * 1000).toISOString();

describe("todaysMeetings", () => {
  it("keeps only meetings whose start falls on the current local day", () => {
    const meetings = [
      meeting({ id: "yesterday", startAt: at(-1) }),
      meeting({ id: "first", startAt: at(1) }),
      meeting({ id: "second", startAt: at(15) }),
      meeting({ id: "tomorrow", startAt: at(24) }),
    ];
    expect(todaysMeetings(meetings, NOW).map((m) => m.id)).toEqual(["first", "second"]);
  });

  it("returns the day's meetings in start order whatever order the store returned", () => {
    const meetings = [
      meeting({ id: "second", startAt: at(17) }),
      meeting({ id: "first", startAt: at(9) }),
    ];
    expect(todaysMeetings(meetings, NOW).map((m) => m.id)).toEqual(["first", "second"]);
  });

  it("still lists a cancelled meeting — the record survives, its page says so", () => {
    const meetings = [meeting({ id: "gone", cancelled: true, startAt: at(9) })];
    expect(todaysMeetings(meetings, NOW).map((m) => m.id)).toEqual(["gone"]);
  });

  it("says nothing for a day with no meetings", () => {
    const meetings = [meeting({ startAt: "2026-08-28T15:00:00.000Z" })];
    expect(todaysMeetings(meetings, NOW)).toEqual([]);
  });
});
