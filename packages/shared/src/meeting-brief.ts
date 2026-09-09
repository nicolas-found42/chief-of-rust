/** Meeting Brief Generator — Module-owned types (issue://80, ADR-0032/0033/0034). */

import type { PersonProfileConsumerState } from "./person-profile.js";
import type { TaskPriority } from "./task.js";

export const MEETING_BRIEF_MODULE_ID = "meeting-brief-generator" as const;
export const MEETING_BRIEF_MODULE_VERSION = 1 as const;

/** Fixed Stages for v1 — no dynamic names. */
export const MEETING_BRIEF_STAGES = ["snapshot", "enrich", "compose", "deliver"] as const;
export type MeetingBriefStage = (typeof MEETING_BRIEF_STAGES)[number];

export const MEETING_BRIEF_INTAKE = "calendar" as const;

export interface MeetingBriefOccurrenceIdentity {
  eventId: string;
  occurrenceId: string;
  occurrenceKey: string;
}

export function meetingBriefOccurrenceIdentity(
  eventId: string,
  occurrenceId: string,
): MeetingBriefOccurrenceIdentity {
  if (!eventId || !occurrenceId || eventId.includes("::") || occurrenceId.includes("::")) {
    throw new Error("Meeting Brief occurrence identity requires non-empty delimiter-free parts");
  }
  return { eventId, occurrenceId, occurrenceKey: `${eventId}::${occurrenceId}` };
}

export function parseMeetingBriefOccurrenceKey(
  occurrenceKey: string,
): MeetingBriefOccurrenceIdentity | null {
  const separator = occurrenceKey.indexOf("::");
  if (separator <= 0 || separator !== occurrenceKey.lastIndexOf("::")) return null;
  const eventId = occurrenceKey.slice(0, separator);
  const occurrenceId = occurrenceKey.slice(separator + 2);
  if (!occurrenceId) return null;
  return { eventId, occurrenceId, occurrenceKey };
}

/** Current Calendar truth for one meeting occurrence (per ADR-0033). */
export interface MeetingBriefEvent {
  calendarId: string;
  eventId: string;
  /** Occurrence identity — one per recurring occurrence (e.g. eventId + start). */
  occurrenceId: string;
  version: string;
  summary: string;
  description?: string;
  startAt: string;
  endAt: string;
  location?: string | null;
  conferenceLink?: string | null;
  organizer?: { email: string; displayName?: string };
  attendees: Array<{
    email: string;
    displayName?: string;
    responseStatus: "accepted" | "tentative" | "needsAction" | "declined";
    organizer?: boolean;
    resource?: boolean;
    self?: boolean;
  }>;
  status: "confirmed" | "cancelled" | "tentative";
  isAllDay?: boolean;
  attachments?: string[];
  // Unused metadata — ignored for material change detection (ADR-0033)
  colorId?: string | null;
  etag?: string | null;
  visibility?: string | null;
  transparency?: string | null;
  created?: string | null;
  updated?: string | null;
}

/** One normalized enrichment section from a provider source. */
export interface MeetingBriefEnrichmentSection {
  source: string;
  guest?: string;
  company?: string;
  status: "completed" | "empty" | "failed";
  evidence: string[];
  references: string[];
}

/** Structured Meeting Brief retained in the Run (Module-owned Result Shape). Includes deterministic logistics. */
export interface MeetingBriefLogistics {
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  conferenceLink: string | null;
  organizer: { email: string; displayName?: string } | null;
}

export interface MeetingBrief {
  version: 1;
  eventId: string;
  occurrenceId: string;
  eventVersion: string;
  generatedAt: string;
  logistics: MeetingBriefLogistics;
  summary: string;
  guests: Array<{
    email: string;
    name: string | null;
    role: string | null;
    background: string | null;
    relationshipHistory: string[];
    crmContext: string | null;
    talkingPoints: string[];
    uncertainty: string[];
    evidenceReferences: string[];
  }>;
  companies: Array<{
    name: string;
    domain: string | null;
    hubspotContext: string | null;
    docs: string[];
    news: string[];
    industry: string[];
    uncertainty: string[];
    evidenceReferences: string[];
  }>;
  conversationStarters: string[];
  sourceReferences: string[];
  missingEvidence: string[];
  uncertainty: string[];
}

/** Delivery state retained on the Run (ADR-0034). */
export interface MeetingBriefDeliveryState {
  status: "pending" | "sent" | "reconciled" | "superseded" | "skipped" | "failed";
  sentAt: string | null;
  messageId: string | null;
  recipient: string | null;
  attempts: number;
  /** Stable idempotency key persisted before send; used to reconcile lost acks. */
  deliveryId?: string | null;
}

/** `result.json` for one Meeting Brief Run. */
export interface MeetingBriefRunResult {
  version: 1;
  eventId: string;
  occurrenceId: string;
  eventVersion: string;
  occurrenceKey: string;
  snapshotAt: string;
  enrichAt: string | null;
  composeAt: string | null;
  meetingBrief: MeetingBrief;
  delivery: MeetingBriefDeliveryState;
  /** Exact Profile revisions used to derive guest claims in this immutable Brief. */
  personProfileLinks?: MeetingBriefPersonProfileLink[];
  supersedes?: string | null;
  /** The stale immutable Brief this Run explicitly regenerated from Profile truth. */
  profileRefreshOf?: string;
  /** Audit reason when Calendar current truth prevents outward delivery. */
  deliverySkippedReason?: string;
}

export interface MeetingBriefPersonProfileLink {
  guestEmail: string;
  profileId: string;
  profileRevision: number;
}

// ---------------------------------------------------------------------------
// Provider outcome ledger (issue #137) — versioned per-provider enrichment
// outcomes, diagnostics and reusable artifact references for one Run.
// ---------------------------------------------------------------------------

export const MEETING_BRIEF_PROVIDER_OUTCOMES_VERSION = 1;

export type MeetingBriefProviderOutcomeStatus = "completed" | "empty" | "failed" | "disabled";

export interface MeetingBriefProviderOutcome {
  /** Module-owned provider id from the versioned bundle policy (Decision 18). */
  provider: string;
  /** Lowercase attendee email the provider ran for. */
  attendee: string;
  outcome: MeetingBriefProviderOutcomeStatus;
  /** Run artifact carrying the reusable result, when the provider produced one. */
  artifact: string | null;
  diagnostics: {
    httpStatus: number | null;
    errorCode: string | null;
    reason: string | null;
  } | null;
}

/** `provider-outcomes.json` for one Meeting Brief Run — the completeness record. */
export interface MeetingBriefProviderOutcomes {
  version: typeof MEETING_BRIEF_PROVIDER_OUTCOMES_VERSION;
  bundleVersion: number;
  occurrenceKey: string;
  eventVersion: string;
  /** Automatic backoff retries already spent on this Run's enrichment. */
  retryCount: number;
  outcomes: MeetingBriefProviderOutcome[];
}

/** Meeting Brief-owned read model; never persisted into the immutable Run result. */
export interface MeetingBriefPersonProfileReadModel {
  consumers: Array<{
    link: MeetingBriefPersonProfileLink;
    state: PersonProfileConsumerState | null;
  }>;
}

/** GET /api/meeting-brief/index — Cross-Run index derived on read (ADR-0005). */
export interface MeetingBriefIndex {
  upcoming: MeetingBriefUpcoming[];
  briefs: MeetingBriefIndexEntry[];
  cancellations: MeetingBriefCancellation[];
}

export interface MeetingBriefCancellation {
  occurrenceKey: string;
  eventId: string;
  occurrenceId: string;
  version: string;
  summary: string;
  cancelledAt: string;
}

export interface MeetingBriefUpcoming {
  occurrenceKey: string;
  eventId: string;
  occurrenceId: string;
  version: string;
  summary: string;
  startAt: string;
  dueAt: string;
}

export interface MeetingBriefIndexEntry {
  runId: string;
  createdAt: string;
  status: string;
  eventId: string;
  occurrenceId: string;
  occurrenceKey: string;
  eventVersion: string;
  meetingBrief: MeetingBrief | null;
  delivery: MeetingBriefDeliveryState | null;
  supersedes: string | null;
  /** Per-provider enrichment outcomes when the Run recorded a ledger (#137). */
  providerOutcomes: MeetingBriefProviderOutcome[] | null;
}

// ---------------------------------------------------------------------------
// Daily Briefing (issue #160) — the morning read model for the day ahead,
// derived on read from the day's Meetings and their Meeting Briefs
// (ADR-0005). A Meeting Brief prepares a single meeting; the Daily Briefing
// is the Meeting Wizard front-page section covering the whole day.
// ---------------------------------------------------------------------------

/** Whether the day's Meeting already has a Meeting Brief. */
/**
 * How a Meeting's Brief stands in a Briefing. `failed` is its own state and
 * not a kind of `missing`: a preparation that ran and failed is something the
 * owner can retry, where a missing one has never been asked for, and a
 * front page that calls the first "No brief" under-reports its own failures.
 */
export type DailyBriefingBriefStatus = "ready" | "pending" | "failed" | "missing";

/** One of the day's Meetings as the Daily Briefing presents it. */
export interface DailyBriefingMeeting {
  /** The Meeting's own id (never the Calendar occurrence key, ADR-0050). */
  meetingId: string;
  title: string;
  startAt: string;
  briefStatus: DailyBriefingBriefStatus;
}

/**
 * One canonical Task as a Briefing presents it (issue #192). A projection of
 * the Tasks product's own record, never a copy that can drift: the identity is
 * here so the row can link back, and nothing on it is editable from a
 * Briefing.
 */
export interface DailyBriefingTask {
  taskId: string;
  title: string;
  /** Date-only `YYYY-MM-DD`; null when the Task has no due date. */
  dueDate: string | null;
  priority: TaskPriority;
}

/**
 * One pending Action Item as a Briefing presents it (issue #192). Separate
 * from `DailyBriefingTask` on purpose: an Action Item is a proposal awaiting a
 * decision, and merging the two identities is exactly the confusion the
 * canonical Task model exists to end.
 */
export interface DailyBriefingActionItem {
  actionItemId: string;
  title: string;
  dueDate: string | null;
  /** The Meeting that proposed it; null when none is placed. */
  meetingId: string | null;
}

/**
 * The day's work beside the day's meetings (issue #192). Read from the
 * canonical Task and Action Item stores rather than reconstructed from Run
 * receipts, and capped like every other compact surface — each list is paired
 * with the total it was taken from.
 */
export interface DailyBriefingWork {
  overdue: DailyBriefingTask[];
  dueToday: DailyBriefingTask[];
  /** Open, high-priority Tasks not already named above. */
  highPriority: DailyBriefingTask[];
  pendingActionItems: DailyBriefingActionItem[];
  totals: {
    overdue: number;
    dueToday: number;
    highPriority: number;
    pendingActionItems: number;
  };
}

/** GET /api/meeting-brief/daily — the morning read model, or null when the day holds neither Meetings nor work. */
export interface DailyBriefing {
  /** The owner-timezone calendar day covered, `YYYY-MM-DD`. */
  date: string;
  meetings: DailyBriefingMeeting[];
  summary: string;
  /** Canonical Tasks and pending Action Items for the day (issue #192). */
  work: DailyBriefingWork;
}

/** GET /api/meeting-brief/daily and POST /api/meeting-brief/daily/retry envelope. */
export interface DailyBriefingState {
  /** Null when the day holds neither Meetings nor work; a failed build keeps the last good value. */
  briefing: DailyBriefing | null;
  /** The failed build's message; null when the last build succeeded. */
  error: string | null;
  /**
   * True while a touching change (new/revised Brief, cancellation, new action
   * item) is waiting out its quiet period (issue #162). The previous briefing
   * is still served; it rebuilds once the quiet period expires.
   */
  stale: boolean;
}
// ---------------------------------------------------------------------------
// Weekly Briefing (issue #161) — the week-ahead read model for the Meeting
// Wizard home, derived on read from the coming week's Meetings and their
// Meeting Briefs (ADR-0005), which exist by the Sunday sweep. A Meeting Brief
// prepares a single meeting; the Weekly Briefing ranks the whole week so the
// owner sees which meetings matter most. No separate weekly page.
// ---------------------------------------------------------------------------

/** One of the week's Meetings as the Weekly Briefing presents it, in rank order. */
export interface WeeklyBriefingMeeting {
  /** The Meeting's own id (never the Calendar occurrence key, ADR-0050). */
  meetingId: string;
  title: string;
  startAt: string;
  /** Deterministic rank score from headcount, external guests, and Brief readiness. Higher matters more. */
  importance: number;
  briefStatus: DailyBriefingBriefStatus;
}

/** GET /api/meeting-brief/weekly — the week-ahead read model, or null when the week holds no Meetings. */
export interface WeeklyBriefing {
  /** The Sunday opening the covered week, `YYYY-MM-DD` in the owner timezone. */
  weekStart: string;
  /** The week's Meetings, most important first. */
  meetings: WeeklyBriefingMeeting[];
  /** One line naming the week's load and its top meeting. */
  ranking: string;
}

/** GET /api/meeting-brief/weekly and POST /api/meeting-brief/weekly/retry envelope. */
export interface WeeklyBriefingState {
  /** Null when the week holds no Meetings; a failed build keeps the last good value. */
  briefing: WeeklyBriefing | null;
  /** The failed build's message; null when the last build succeeded. */
  error: string | null;
  /**
   * True while a touching change is waiting out its quiet period (issue #162).
   * The previous briefing is still served; it rebuilds once the quiet period
   * expires.
   */
  stale: boolean;
}
// ---------------------------------------------------------------------------
// HubSpot CRM — per-user private-app token, read-only contact/company/deal
// (issue://86, Spec #80). Shell stores secret + classifies state, Module owns
// query semantics. No shared Found42 credential.
// ---------------------------------------------------------------------------

export const HUBSPOT_CONNECTION_STATES = ["unconfigured", "unverified", "connected"] as const;
export type HubSpotConnectionState = (typeof HUBSPOT_CONNECTION_STATES)[number];

export interface HubSpotStatus {
  state: HubSpotConnectionState;
  tokenHint: string;
  lastVerifiedAt: string | null;
}

/** Bounded read-only probe classification (5 states). */
export const HUBSPOT_PROBE_STATES = [
  "missing_configuration",
  "rejected",
  "missing_authority",
  "unavailable",
  "healthy",
] as const;
export type HubSpotProbeState = (typeof HUBSPOT_PROBE_STATES)[number];

export interface HubSpotSetupCheck {
  state: HubSpotProbeState;
  /** Human-readable detail for the current state. */
  detail: string;
  /** One line per checked surface (contact/company/deal) — bounded, read-only. */
  items: Array<{ label: string; ok: boolean; detail: string }>;
  checkedAt: string;
}

/** HubSpot contact as returned for an exact-email lookup. */
export interface HubSpotContact {
  id: string;
  email: string;
  properties: Record<string, string>;
  associatedCompanyIds: string[];
  associatedDealIds: string[];
}

export interface HubSpotCompany {
  id: string;
  name: string;
  domain: string | null;
  properties: Record<string, string>;
}

export interface HubSpotDeal {
  id: string;
  name: string | null;
  amount: string | null;
  stage: string | null;
  properties: Record<string, string>;
}

/** One HubSpot enrichment artifact — stable per eventVersion + guest + source. */
export interface HubSpotEnrichmentArtifact {
  /** Stable key: `${eventVersion}::${guestEmail}::${source}` or company/deal scoped. */
  key: string;
  eventVersion: string;
  guestEmail: string;
  companyId?: string | null;
  dealId?: string | null;
  source: "hubspot-contact" | "hubspot-company" | "hubspot-deal";
  status: "completed" | "empty" | "failed";
  evidence: string[];
  references: string[];
  diagnostics: {
    probeState?: HubSpotProbeState;
    httpStatus?: number | null;
    errorCode?: string | null;
    bounded: boolean;
    maxResults: number;
    stableRef: string;
    employerMatch?: boolean;
    reason?: string;
  };
  stableRef: string;
  isEmployerMatch?: boolean;
}

export const HUBSPOT_MAX_RESULTS = 10 as const;

// ---------------------------------------------------------------------------
// Google enrichment — bounded Gmail, Calendar history, Drive Docs
// (issue://85, Spec #80). Module-owned, bounded, per eventVersion+guest/company+source.
// ---------------------------------------------------------------------------

export const GOOGLE_ENRICHMENT_MAX_GMAIL_EXACT = 10 as const;
export const GOOGLE_ENRICHMENT_MAX_GMAIL_COMPANY = 10 as const;
export const GOOGLE_ENRICHMENT_MAX_CALENDAR_HISTORY = 10 as const;
export const GOOGLE_ENRICHMENT_MAX_DRIVE_DOCS = 10 as const;

export type GoogleEnrichmentSource =
  "gmail-exact" | "gmail-company-domain" | "calendar-history" | "drive-docs";

export type GoogleEnrichmentOutcome = "completed" | "empty" | "failed";

export interface GoogleEnrichmentArtifact {
  /** Stable key: `${eventVersion}::${guestEmail.toLowerCase()}::${source}::${companyDomain ?? ""}` trimmed */
  key: string;
  eventVersion: string;
  guestEmail: string;
  /** For company-domain Gmail and company Drive — null for person-level */
  companyDomain?: string | null;
  source: GoogleEnrichmentSource;
  status: GoogleEnrichmentOutcome;
  /** Untrusted evidence — treated as data, never as instructions */
  evidence: string[];
  references: string[];
  diagnostics: {
    bounded: boolean;
    maxResults: number;
    stableRef: string;
    httpStatus?: number | null;
    errorCode?: string | null;
    reason?: string;
    truncated?: boolean;
    untrusted?: boolean;
    attempts?: number;
  };
  stableRef: string;
}

export function googleEnrichmentKey(
  eventVersion: string,
  guestEmail: string,
  source: GoogleEnrichmentSource,
  companyDomain?: string | null,
): string {
  const base = `${eventVersion}::${guestEmail.toLowerCase()}::${source}`;
  if (companyDomain) return `${base}::${companyDomain.toLowerCase()}`;
  return base;
}

export const PUBLIC_INTELLIGENCE_MAX_RESULTS = 10 as const;

export type PublicIntelligenceSource = "company-news" | "industry-news" | "employer-verification";

export type PublicIntelligenceOutcome = "completed" | "empty" | "failed";

export interface PublicIntelligenceArtifact {
  /** Stable key: `${eventVersion}::${guestEmail.toLowerCase()}::${source}::${companyName ?? ""}` trimmed */
  key: string;
  eventVersion: string;
  guestEmail: string;
  companyName?: string | null;
  companyDomain?: string | null;
  source: PublicIntelligenceSource;
  status: PublicIntelligenceOutcome;
  /** Untrusted evidence — treated as data, never as instructions */
  evidence: string[];
  references: string[];
  diagnostics: {
    bounded: boolean;
    maxResults: number;
    stableRef: string;
    window?: { from: string; to: string };
    truncated?: boolean;
    httpStatus?: number | null;
    errorCode?: string | null;
    reason?: string;
    attempts?: number;
    orgs?: string[];
    untrusted?: boolean;
  };
  stableRef: string;
}

export function publicIntelligenceKey(
  eventVersion: string,
  guestEmail: string,
  source: PublicIntelligenceSource,
  companyName?: string | null,
): string {
  const base = `${eventVersion}::${guestEmail.toLowerCase()}::${source}`;
  if (companyName) return `${base}::${companyName.toLowerCase().trim()}`;
  return base;
}
