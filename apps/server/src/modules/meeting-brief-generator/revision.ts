import type { MeetingBriefEvent } from "@chief-of-staff-demo/shared";

/**
 * Material Calendar change detection (ADR-0033, issue://84).
 *
 * Material fields (consumed by brief/delivery): title (=summary), description,
 * timing (startAt/endAt), location, conference link, attached Docs (attachments),
 * organizer, guest identity/list, invitation response.
 *
 * Unused metadata (colorId, etag, visibility, transparency, created, updated,
 * calendarId etc.) is ignored.
 */

interface MaterialSnapshot {
  summary: string;
  description: string;
  startAt: string;
  endAt: string;
  location: string | null;
  conferenceLink: string | null;
  attachments: string[];
  organizerEmail: string | null;
  attendees: Array<{
    email: string;
    responseStatus: string;
    organizer: boolean;
    resource: boolean;
  }>;
}

/** Produce deterministic material snapshot for comparison (ADR-0033). */
function materialSnapshot(event: MeetingBriefEvent): MaterialSnapshot {
  const attachments = [...(event.attachments ?? [])].sort();
  const organizerEmail = event.organizer?.email.trim().toLowerCase() ?? null;
  const attendees = event.attendees
    .map((a) => ({
      email: a.email.trim().toLowerCase(),
      responseStatus: a.responseStatus,
      organizer: Boolean(a.organizer),
      resource: Boolean(a.resource),
    }))
    .sort(
      (a, b) => a.email.localeCompare(b.email) || a.responseStatus.localeCompare(b.responseStatus),
    );
  return {
    summary: event.summary,
    description: event.description ?? "",
    startAt: event.startAt,
    endAt: event.endAt,
    location: event.location ?? null,
    conferenceLink: event.conferenceLink ?? null,
    attachments,
    organizerEmail,
    attendees,
  };
}

export function materialFingerprint(event: MeetingBriefEvent): string {
  return JSON.stringify(materialSnapshot(event));
}
