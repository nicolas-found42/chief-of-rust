import type { Meeting } from "@chief-of-staff-demo/shared";

/**
 * The Meetings of one day, for the Meeting Wizard home (issue #151): the
 * browser's local day, in start order whatever order the Meeting store
 * returned. A cancelled Meeting still belongs to its day — the record
 * survives, and its page says so (ADR-0050).
 */
export function todaysMeetings(meetings: Meeting[], now: Date): Meeting[] {
  const dayOf = (at: string): string => {
    const date = new Date(at);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  };
  const today = dayOf(now.toISOString());
  return meetings
    .filter((meeting) => dayOf(meeting.startAt) === today)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}
