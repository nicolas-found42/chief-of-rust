import type { MeetingDebriefDetail, MeetingDebriefIndexEntry } from "@chief-of-staff-demo/shared";

/**
 * What to call one Meeting Debrief on a product surface.
 *
 * A Debrief is addressed by its Run and keyed by its Transcript, so the only
 * name it carries of its own is the Drive file name — a title, the word
 * "transcript", an ISO timestamp and an extension, run together. The Meeting
 * it belongs to has the name a person would use, so ask the Meeting first and
 * keep the file name as the fallback for a Debrief whose Meeting is not known.
 */
export function meetingDebriefName(
  entry: Pick<MeetingDebriefIndexEntry, "meetingId" | "fileName" | "transcriptId">,
  meetingTitles: ReadonlyMap<string, string>,
): string {
  const title = entry.meetingId ? meetingTitles.get(entry.meetingId) : undefined;
  return title ?? entry.fileName ?? entry.transcriptId;
}

/** The same name for the detail page, whose payload is shaped differently. */
export function meetingDebriefDetailName(
  detail: Pick<MeetingDebriefDetail, "meetingId" | "fileName" | "transcriptId">,
  meetingTitles: ReadonlyMap<string, string>,
): string {
  return meetingDebriefName(detail, meetingTitles);
}
