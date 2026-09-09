import { eligibilityReason } from "./eligibility.js";
import type { MeetingBriefEvent } from "@chief-of-staff-demo/shared";
import { meetingBriefOccurrenceIdentity } from "@chief-of-staff-demo/shared";
import { materialFingerprint } from "./revision.js";

export type SnapshotSource = MeetingBriefEvent;

/**
 * Snapshot eligibility check (issue://84, ADR-0033).
 * Freezes current event, occurrence, version and validates eligibility using
 * the ownerEmail. Returns ineligibility reason when skipped.
 */
export function snapshotEligibility(
  event: SnapshotSource,
  ownerEmail: string | null,
): { eligible: boolean; reason: string } {
  const reason = eligibilityReason(event, ownerEmail);
  return { eligible: reason === "eligible", reason };
}

export interface FrozenSnapshot {
  calendarId: string;
  eventId: string;
  occurrenceId: string;
  occurrenceKey: string;
  version: string;
  materialFingerprint: string;
  summary: string;
  description?: string;
  startAt: string;
  endAt: string;
  location: string | null;
  conferenceLink: string | null;
  organizer?: { email: string; displayName?: string };
  attendees: SnapshotSource["attendees"];
  status: MeetingBriefEvent["status"];
  isAllDay?: boolean;
  attachments?: string[];
  capturedAt: string;
}

/** The snapshot.json fields the Host's Cross-Run indexes read back (module.ts adds eligible/skip/supersedes). */
export type StoredSnapshot = Pick<
  FrozenSnapshot,
  "eventId" | "occurrenceId" | "occurrenceKey" | "version"
> & {
  /**
   * Written by every `buildFrozenSnapshot` caller. The Host compares it against the
   * current event to decide whether a revision is material, rather than rebuilding
   * the event the snapshot froze.
   */
  materialFingerprint?: string;
  supersedesRunId?: string | null;
};

/** Build frozen snapshot payload persisted as snapshot.json (retains version + material fingerprint). */
export function buildFrozenSnapshot(event: SnapshotSource, capturedAt: string): FrozenSnapshot {
  const { occurrenceKey } = meetingBriefOccurrenceIdentity(event.eventId, event.occurrenceId);
  return {
    calendarId: event.calendarId,
    eventId: event.eventId,
    occurrenceId: event.occurrenceId,
    occurrenceKey,
    version: event.version,
    materialFingerprint: materialFingerprint(event),
    summary: event.summary,
    ...(event.description !== undefined ? { description: event.description } : {}),
    startAt: event.startAt,
    endAt: event.endAt,
    location: event.location ?? null,
    conferenceLink: event.conferenceLink ?? null,
    ...(event.organizer !== undefined ? { organizer: event.organizer } : {}),
    attendees: event.attendees,
    status: event.status,
    ...(event.isAllDay !== undefined ? { isAllDay: event.isAllDay } : {}),
    ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
    capturedAt,
  };
}
