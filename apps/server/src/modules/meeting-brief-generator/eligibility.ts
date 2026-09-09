import type { MeetingParticipant } from "@chief-of-staff-demo/shared";
import type { CalendarAttendee, CalendarEvent } from "./calendar.js";

/**
 * Consumer Domains — personal mailbox providers that remain external
 * but must not be treated as employer evidence (issue://80 #32, #31).
 * For eligibility they count as external guests; for employer inference they are ignored (later waves).
 */
const CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.co.jp",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "zoho.com",
  "gmx.com",
  "gmx.de",
  "yandex.com",
  "yandex.ru",
  "mail.com",
  "hey.com",
]);

/** Normalize a domain for case-insensitive comparison after email parsing. */
function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/** Extract domain from an email after normalized parsing; null if no @. */
export function extractDomain(email: string): string | null {
  const trimmed = email.trim();
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx === -1 || atIdx === trimmed.length - 1) return null;
  const domain = trimmed
    .slice(atIdx + 1)
    .trim()
    .toLowerCase();
  if (domain.length === 0) return null;
  return domain;
}

/** Whether this domain is a Consumer Domain (personal mailbox). */
export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(normalizeDomain(domain));
}

/** Whether an email's domain is contained in the internalDomains set
 *  (case-insensitive over both sides, after email parsing). The one Internal
 *  Domain definition: eligibility, guest classification, and provider
 *  bundles all classify through it. */
export function isInternalDomain(email: string, internalDomains: string[]): boolean {
  const domain = extractDomain(email);
  if (!domain) return false;
  const normalized = normalizeDomain(domain);
  for (const internal of internalDomains) {
    if (normalizeDomain(internal) === normalized) return true;
  }
  return false;
}

/** Whether this attendee is a room/resource and must be ignored as guest. */
function isResourceAttendee(attendee: CalendarAttendee): boolean {
  return attendee.resource === true;
}

/** Whether this attendee is an External Guest (outside every Internal Domain, not a resource). */
export function isExternalGuest(attendee: CalendarAttendee, internalDomains: string[]): boolean {
  if (isResourceAttendee(attendee)) return false;
  // No email? treat as not external (cannot classify)
  if (!attendee.email) return false;
  return !isInternalDomain(attendee.email, internalDomains);
}

/**
 * Eligible Meeting definition (issue://80 + #83, expanded by #136 per ADR-0043;
 * ADR-0032/33):
 * - timed (not all-day, start and end present)
 * - non-cancelled (status !== "cancelled")
 * - the workspace owner has not declined; the owner is never counted as the
 *   "other attendee" (issue://136). When the owner identity is not yet known
 *   (ADR-0036), the owner rules drop — the Shell reads the owner before the
 *   first Run, so this is a race guard, not a policy hole.
 * - at least one other attendee who has not declined — internal or external
 *   alike; preparation is no longer limited to External Guests (issue://136)
 * - rooms/resources ignored, Internal Domains case-insensitively normalized,
 *   Consumer Domains stay external for classification, recurring occurrences
 *   independent per occurrence identity.
 */
export function isEligibleMeeting(event: CalendarEvent, ownerEmail: string | null): boolean {
  return eligibilityReason(event, ownerEmail) === "eligible";
}

/** Helper for tests: classify a meeting with diagnostic reason when ineligible. */
export function eligibilityReason(event: CalendarEvent, ownerEmail: string | null): string {
  if (event.isAllDay === true) return "all_day_excluded";
  if (!event.startAt || !event.endAt) return "missing_time";
  if (event.status === "cancelled") return "cancelled";
  const normalizedOwner = ownerEmail?.trim().toLowerCase() ?? null;
  let hasOtherAttendee = false;
  for (const attendee of event.attendees) {
    if (isResourceAttendee(attendee)) continue;
    if (normalizedOwner && attendee.email.trim().toLowerCase() === normalizedOwner) {
      if (attendee.responseStatus === "declined") return "owner_declined";
      continue;
    }
    if (attendee.responseStatus !== "declined") hasOtherAttendee = true;
  }
  if (!hasOtherAttendee) return "no_other_attendee";
  return "eligible";
}

/**
 * Which occurrences the Workspace records as Meetings (ADR-0050).
 *
 * Deliberately broader than eligibility, and asking a different question.
 * Eligibility asks "should a Meeting Brief be prepared?"; this asks "did a
 * meeting happen, or is one going to?". A meeting the owner declined and
 * attended anyway still happened, and a cancelled occurrence still deserves
 * the record that says so — so `owner_declined` and `cancelled` do not
 * disqualify here. Only the three tests that mean "this is not a meeting"
 * do: no clock time, no end, and nobody else in the room.
 */
export function isRecordableMeeting(event: CalendarEvent, ownerEmail: string | null): boolean {
  if (event.isAllDay === true) return false;
  if (!event.startAt || !event.endAt) return false;
  const normalizedOwner = ownerEmail?.trim().toLowerCase() ?? null;
  return event.attendees.some((attendee) => {
    if (isResourceAttendee(attendee)) return false;
    if (normalizedOwner && attendee.email.trim().toLowerCase() === normalizedOwner) return false;
    return true;
  });
}

/** Calendar attendees as the Meeting record keeps them: people only, no rooms. */
export function meetingParticipants(
  event: CalendarEvent,
  ownerEmail: string | null,
): MeetingParticipant[] {
  const normalizedOwner = ownerEmail?.trim().toLowerCase() ?? null;
  return event.attendees
    .filter((attendee) => !isResourceAttendee(attendee))
    .map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName ?? null,
      responseStatus: attendee.responseStatus,
      organizer: attendee.organizer === true,
      self:
        attendee.self === true ||
        (normalizedOwner !== null && attendee.email.trim().toLowerCase() === normalizedOwner),
    }));
}
