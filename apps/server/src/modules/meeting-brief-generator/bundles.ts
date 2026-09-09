import { isInternalDomain } from "./eligibility.js";

/**
 * Versioned provider bundle policy (issue://136, spec Implementation Decision
 * 18): internal and external attendees are enriched from different bundles,
 * and the classification — Internal Domain or not — selects the approved
 * versioned bundle for each attendee. Every provider a bundle selects is
 * required: a Brief is never presented as complete when configured evidence
 * is missing (spec #82).
 *
 * The confirmed-transcripts lane (issue #138) is a selectable provider but is
 * deliberately in neither attendee bundle. It is meeting-level rather than
 * attendee-level, and Transcript intake is consent-gated: a Workspace that
 * never consented has no transcripts, so requiring the lane per attendee
 * would block Briefs over evidence that cannot exist. It runs when it is
 * configured and records its own outcome, which keeps it inside the policy
 * action vocabulary without making it an unenforceable requirement.
 */
export const MEETING_BRIEF_BUNDLES_VERSION = 1;

type AttendeeBundleKind = "internal" | "external";

export type MeetingBriefBundleProvider =
  | "person-profile"
  | "gmail-relationship"
  | "gmail-company-domain"
  | "calendar-history"
  | "drive-workspace"
  | "crm"
  | "employer-proposal"
  | "public-intelligence"
  | "confirmed-transcripts";

/** Every provider id the bundles may select — the policy action route's vocabulary. */
export const MEETING_BRIEF_BUNDLE_PROVIDERS: readonly MeetingBriefBundleProvider[] = [
  "person-profile",
  "gmail-relationship",
  "gmail-company-domain",
  "calendar-history",
  "drive-workspace",
  "crm",
  "employer-proposal",
  "public-intelligence",
  "confirmed-transcripts",
];

export interface MeetingBriefAttendeeBundle {
  kind: AttendeeBundleKind;
  version: number;
  providers: readonly MeetingBriefBundleProvider[];
}

/** Internal bundle: Workspace-owned evidence only — colleague privacy keeps
 *  HubSpot, employer proposal, and public search out of internal preparation. */
const INTERNAL_BUNDLE: MeetingBriefAttendeeBundle = {
  kind: "internal",
  version: MEETING_BRIEF_BUNDLES_VERSION,
  providers: ["person-profile", "gmail-relationship", "calendar-history", "drive-workspace"],
};

/** External bundle: the full explicitly enabled enrichment collection. */
const EXTERNAL_BUNDLE: MeetingBriefAttendeeBundle = {
  kind: "external",
  version: MEETING_BRIEF_BUNDLES_VERSION,
  providers: [
    "person-profile",
    "gmail-relationship",
    "gmail-company-domain",
    "calendar-history",
    "drive-workspace",
    "crm",
    "employer-proposal",
    "public-intelligence",
  ],
};

/** Classify one attendee's email against the configured Internal Domains. A
 *  Consumer Domain stays external (spec #117 External Guest): a personal
 *  mailbox is never company evidence. */
function classifyAttendee(email: string, internalDomains: string[]): AttendeeBundleKind {
  return isInternalDomain(email, internalDomains) ? "internal" : "external";
}
export function attendeeBundleFor(
  email: string,
  internalDomains: string[],
): MeetingBriefAttendeeBundle {
  return classifyAttendee(email, internalDomains) === "internal"
    ? INTERNAL_BUNDLE
    : EXTERNAL_BUNDLE;
}
