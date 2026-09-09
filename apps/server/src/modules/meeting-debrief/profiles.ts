import type { WorkspacePersonProfiles } from "../../person-profile/profiles.js";
import { isCalendarVerifiedEmail } from "../../person-profile/profiles.js";

/**
 * The Profile surface the Debrief review consumes (issue #140, spec #450/461).
 * Deliberately narrower than the Workspace's Person Profiles interface: the
 * review needs to bind roster attendees to Profiles and to accept only
 * verified emails — it never reads evidence, diagnostics, or projections.
 *
 * "Verified" is the Profile domain's rule (`isCalendarVerifiedEmail`): the
 * exact email is held by a current Profile whose identity a Calendar attendee
 * shell anchors. The Debrief creates nothing on its own except through the
 * Calendar-attendee seam for Calendar-sourced roster emails — only Calendar
 * may create stable email shells (spec #117).
 */
export interface DebriefProfileDirectory {
  /**
   * The one current Profile whose verified identity holds this exact email,
   * or null when no single verified holder exists. Two holders are a visible
   * ambiguity, never an automatic pick.
   */
  verifiedForEmail(email: string): { profileId: string; profileRevision: number } | null;
  /**
   * Reuse-or-create the Calendar-anchored shell for an exact Calendar
   * attendee email. Only callers holding a Calendar-sourced email (a linked
   * roster) may use it; conflicting stable identifiers throw, never merge.
   */
  ensureCalendarAttendee(
    email: string,
    provenance: string,
  ): { profileId: string; profileRevision: number };
  /**
   * The binding for a manually stated roster email: the single current
   * holder, without creating anything. Unlinked transcripts never mint
   * email-anchored shells from typed text.
   */
  holderForEmail(email: string): { profileId: string; profileRevision: number } | null;
  /**
   * An explicit selection by Profile id for an additional recipient, accepted
   * only when the Profile is current and its verified identity holds the
   * exact email.
   */
  verifiedForSelection(
    profileId: string,
    email: string,
  ): { profileId: string; profileRevision: number } | null;
}

function currentHolders(people: WorkspacePersonProfiles, email: string) {
  const normalized = email.trim().toLowerCase();
  return people
    .search()
    .filter(
      (profile) =>
        profile.mergedInto === undefined &&
        profile.emails.some((value) => value.trim().toLowerCase() === normalized),
    );
}

export function workspaceProfileDirectory(
  people: WorkspacePersonProfiles,
): DebriefProfileDirectory {
  return {
    verifiedForEmail(email: string) {
      const holders = currentHolders(people, email);
      if (holders.length !== 1) return null;
      const holder = holders[0]!;
      if (!isCalendarVerifiedEmail(holder, email)) return null;
      return { profileId: holder.id, profileRevision: holder.revision };
    },
    ensureCalendarAttendee(email: string, provenance: string) {
      const { profile } = people.ensureCalendarAttendeeProfile({ email, provenance });
      return { profileId: profile.id, profileRevision: profile.revision };
    },
    holderForEmail(email: string) {
      const holders = currentHolders(people, email);
      if (holders.length !== 1) return null;
      const holder = holders[0]!;
      return { profileId: holder.id, profileRevision: holder.revision };
    },
    verifiedForSelection(profileId: string, email: string) {
      const profile = people.get(profileId);
      if (!profile || profile.archivedAt !== null || profile.mergedInto !== undefined) return null;
      if (!isCalendarVerifiedEmail(profile, email)) return null;
      return { profileId: profile.id, profileRevision: profile.revision };
    },
  };
}
