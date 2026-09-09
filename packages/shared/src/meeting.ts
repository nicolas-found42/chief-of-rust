/**
 * The Workspace's durable record of one meeting (ADR-0050).
 *
 * A Meeting outlives the Calendar occurrence it came from: Calendar is read
 * forward only, and drops an occurrence once it is past, but a Transcript
 * always arrives afterwards. A Meeting therefore keeps the occurrence facts
 * itself, and may exist with no occurrence at all when only a Transcript
 * attests that the meeting happened.
 *
 * It holds no workflow state. The Meeting Brief and the Meeting Debrief stay
 * the results of their own separate Runs; this record is what they are about.
 */

/** One person on the meeting, as Calendar reported them. Rooms are excluded. */
export interface MeetingParticipant {
  email: string;
  displayName: string | null;
  responseStatus: "accepted" | "tentative" | "needsAction" | "declined";
  organizer: boolean;
  /** True for the workspace owner's own attendance. */
  self: boolean;
}

/**
 * Why a Meeting earns no Meeting Brief. `null` means it is an Eligible
 * Meeting. The strings are `eligibilityReason`'s vocabulary, so the Brief
 * surface can name the test rather than showing an unexplained empty panel.
 */
export type MeetingIneligibility =
  "all_day_excluded" | "missing_time" | "cancelled" | "owner_declined" | "no_other_attendee";

export interface Meeting {
  /**
   * Workspace identity, independent of Calendar (ADR-0050). A Meeting created
   * from a Transcript alone has no occurrence key to be addressed by, so the
   * occurrence key is an attribute this record carries, never its address.
   */
  id: string;
  /** `eventId::occurrenceId` when Calendar supplied the occurrence. */
  occurrenceKey: string | null;
  calendarEventId: string | null;
  occurrenceId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  participants: MeetingParticipant[];
  /** Calendar reported the occurrence cancelled. The record survives it. */
  cancelled: boolean;
  /** Null when the Meeting is an Eligible Meeting. */
  ineligibleReason: MeetingIneligibility | null;
  createdAt: string;
  updatedAt: string;
}

/** The list projection the Meeting Wizard reads. */
export interface MeetingIndex {
  meetings: Meeting[];
  /** Oldest start the Workspace holds, so a surface can say where history begins. */
  historyBeginsAt: string | null;
}
