/* oxlint-disable typescript/no-unnecessary-condition -- enrichment helpers deliberately handle nullable provider errors */
import type {
  HubSpotCompany,
  HubSpotContact,
  HubSpotDeal,
  HubSpotEnrichmentArtifact,
  GoogleEnrichmentArtifact,
  PublicIntelligenceArtifact,
  PersonProfileMeetingProjection,
  MeetingBriefEnrichmentSection,
  MeetingBriefEvent,
  MeetingBriefProviderOutcome,
  MeetingBriefProviderOutcomeStatus,
  MeetingBriefPersonProfileLink,
} from "@chief-of-staff-demo/shared";
import { PERSON_PROFILE_SOURCE_ID } from "@chief-of-staff-demo/shared";
import { meetingBriefOccurrenceIdentity } from "@chief-of-staff-demo/shared";
import { extractDomain, isConsumerDomain } from "../eligibility.js";
import {
  attendeeBundleFor,
  MEETING_BRIEF_BUNDLES_VERSION,
  type MeetingBriefBundleProvider,
} from "../bundles.js";
import type { GmailProvider } from "../google/gmail.js";
import { enrichGmailExact, enrichGmailCompanyDomain } from "../google/gmail.js";
import type { CalendarHistoryProvider } from "../google/calendarHistory.js";
import { enrichCalendarHistory } from "../google/calendarHistory.js";
import type { DriveProvider } from "../google/drive.js";
import { enrichDriveDocs } from "../google/drive.js";
import { WorkspacePersonProfiles } from "../../../person-profile/profiles.js";
import type { HubSpotApi } from "../hubspot/client.js";
import { enrichGuestWithHubSpot } from "../hubspot/enrichment.js";
import type { PublicIntelligenceProvider } from "./publicIntelligence.js";
import {
  enrichCompanyNews,
  enrichIndustryNews,
  enrichEmployerVerification,
  fileNameFor,
} from "./publicIntelligence.js";
import type { RunContext } from "../../../engine/module.js";
import { StageFailure } from "../../../engine/module.js";
import {
  TRANSCRIPT_EVIDENCE_SOURCE_ID,
  selectTranscriptEvidence,
  type MeetingTranscriptEvidenceProvider,
} from "../transcriptEvidence.js";
import {
  deduplicateEvidence,
  readErrorStatus,
  sanitizeEvidence,
  withBoundedRetry,
  sanitizeArtifactVersion,
} from "./helpers.js";
// ---------------------------------------------------------------------------
// Unified enrich deps — all providers injectable fakes
// ---------------------------------------------------------------------------
export interface MeetingBriefEnrichmentProviders {
  gmailProvider?: GmailProvider | null;
  calendarHistoryProvider?: CalendarHistoryProvider | null;
  driveProvider?: DriveProvider | null;
  /** The Workspace Person Profiles interface: Calendar attendee identity is
   *  resolved and pinned through it (issue #124), never through the legacy
   *  broad resolver. */
  attendeeProfiles?: WorkspacePersonProfiles | null;
  /** Public-web enrichment for an attendee met for the first time. Absent, a
   *  new attendee stays the shell Calendar minted, which is what the Brief
   *  consumed before this existed. */
  resolveNewAttendee?: ((email: string) => Promise<unknown>) | null;
  getHubSpotApi?: (() => HubSpotApi | null) | null;
  publicIntelligenceProvider?: PublicIntelligenceProvider | null;
  proposeEmployer?:
    | ((
        guestEmail: string,
        guestName: string | null,
        eventVersion: string,
      ) => Promise<{ name: string; domain: string | null } | null>)
    | null;
  /** The confirmed-transcript lane (issue #138). Absent, the lane does not
   *  run: a Workspace that never consented to Transcript intake has no
   *  transcripts, and that must not stop a Brief. */
  transcriptEvidence?: MeetingTranscriptEvidenceProvider | null;
}

export interface UnifiedEnrichDeps {
  providers: MeetingBriefEnrichmentProviders;
  internalDomains: string[];
  occurrenceKey?: string;
  /** Providers excluded from the required set by an explicit policy action (#137). */
  disabledProviders?: readonly string[];
}

function personProfileSection(
  projection: PersonProfileMeetingProjection,
): MeetingBriefEnrichmentSection {
  const directEvidence = [projection.role, projection.background, projection.currentEmployer]
    .filter((value): value is string => Boolean(value))
    .map(sanitizeEvidence);
  const sourcedEvidence = projection.evidence
    .map((item) => sanitizeEvidence(item.summary || item.title))
    .filter(Boolean);
  const references = deduplicateEvidence([
    ...projection.socialProfiles.map((item) => item.url),
    ...projection.websites,
    ...projection.feeds.map((feed) => feed.url),
    ...projection.evidence.map((item) => item.url),
  ]);
  return {
    source: PERSON_PROFILE_SOURCE_ID,
    guest: projection.primaryEmail?.toLowerCase() ?? "",
    status: directEvidence.length > 0 || sourcedEvidence.length > 0 ? "completed" : "empty",
    evidence: deduplicateEvidence([...directEvidence, ...sourcedEvidence]),
    references,
  };
}

/** One pinned attendee identity: the exact email, the Profile it resolved to,
 *  and the exact revision the consumer used (spec #117 Implementation
 *  Decision 5). */
interface AttendeeProfilePin {
  email: string;
  profileId: string;
  profileRevision: number;
  origin: "reused" | "shell";
}

/**
 * Calendar attendee identity (issue #124): every non-resource attendee is
 * routed through the shared Person Profiles interface — an exact non-
 * conflicting email match reuses the existing Profile, an unknown attendee
 * receives one idempotent minimal email-anchored shell. Conflicting stable
 * identifiers throw, so the enrich stage fails visibly instead of merging or
 * overwriting Profiles. The pins are persisted as the Run's
 * `attendee-profiles.json` artifact, the consumer's exact-revision record.
 */
async function pinAttendeeProfiles(
  profiles: WorkspacePersonProfiles,
  event: MeetingBriefEvent,
  occurrenceKey: string,
  ctx: Pick<RunContext, "writeFile" | "event">,
  resolveNewAttendee?: ((email: string) => Promise<unknown>) | null,
): Promise<AttendeeProfilePin[]> {
  const provenance = `occurrence ${occurrenceKey} version ${event.version}`;
  const byEmail = new Map<string, AttendeeProfilePin>();
  for (const attendee of event.attendees) {
    if (attendee.resource) continue;
    const email = attendee.email.toLowerCase();
    if (byEmail.has(email)) continue;
    // Archived Profiles are lifecycle state, not selectable attendees
    // (issue://136): Calendar never reuses one and never shells over it. The
    // Run fails visibly with a classified reason so a person can restore or
    // resolve the Profile explicitly instead of the Brief guessing.
    const archivedHolder = profiles
      .search({ query: email, includeArchived: true })
      .find(
        (candidate) =>
          candidate.archivedAt !== null &&
          candidate.emails.some((value) => value.trim().toLowerCase() === email),
      );
    if (archivedHolder)
      throw new Error(
        `archived_profile: An archived Person Profile (${archivedHolder.id}) holds the Calendar attendee email ${email}; restore or resolve it explicitly before it attends a meeting.`,
      );
    const { profile, created } = profiles.ensureCalendarAttendeeProfile({
      email,
      provenance,
    });
    /* An attendee met for the first time is a bare shell — an email and
       nothing else. Enrich it from the public web before the revision is
       pinned, so the Brief consumes the enriched revision rather than one
       already stale. Only newly created shells search: a reused Profile has
       been through this once already, and a failed search leaves the shell
       standing rather than failing the Brief. */
    let pinned = profile;
    if (created && resolveNewAttendee) {
      try {
        await resolveNewAttendee(email);
        pinned = profiles.get(profile.id) ?? profile;
        ctx.event("attendee_profile_enriched", {
          email,
          profileId: pinned.id,
          revision: pinned.revision,
        });
      } catch (error) {
        ctx.event("attendee_profile_enrichment_failed", {
          email,
          profileId: profile.id,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    byEmail.set(email, {
      email,
      profileId: pinned.id,
      profileRevision: pinned.revision,
      origin: created ? "shell" : "reused",
    });
  }
  const pins = [...byEmail.values()];
  ctx.writeFile("attendee-profiles.json", `${JSON.stringify(pins, null, 2)}\n`);
  ctx.event("attendee_profiles_pinned", { occurrenceKey, version: event.version, attendees: pins });
  return pins;
}

/** Read the pinned meeting projection for one attendee and record it as the
 *  Run-local consumer snapshot (`person-profile-<guest>-<version>.json`). */
function pinnedPersonProfile(
  profiles: WorkspacePersonProfiles,
  pin: AttendeeProfilePin,
  eventVersion: string,
  ctx: Pick<RunContext, "writeFile">,
): {
  projection: PersonProfileMeetingProjection;
  section: MeetingBriefEnrichmentSection;
  filename: string;
} {
  const projection = profiles.project("meeting", pin.profileId, { revision: pin.profileRevision });
  if (projection?.purpose !== "meeting")
    throw new StageFailure(
      "enrich",
      `Pinned Person Profile ${pin.profileId} revision ${pin.profileRevision} is no longer retrievable`,
    );
  const sanitized = pin.email.replace(/[^a-zA-Z0-9]/g, "_");
  const filename = `person-profile-${sanitized}-${sanitizeArtifactVersion(eventVersion)}.json`;
  ctx.writeFile(filename, `${JSON.stringify(projection, null, 2)}\n`);
  return { projection, section: personProfileSection(projection), filename };
}

async function enrichHubSpotWithRetry(
  api: HubSpotApi,
  eventVersion: string,
  guestEmail: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{
  artifacts: HubSpotEnrichmentArtifact[];
  sections: MeetingBriefEnrichmentSection[];
  employerMatch: HubSpotCompany | null;
}> {
  const sanitized = guestEmail.toLowerCase().replace(/[^a-zA-Z0-9]/g, "_");
  const checkpointFilename = `hubspot-${sanitizeArtifactVersion(eventVersion)}-${sanitized}-checkpoint.json`;
  interface HubSpotCheckpointCache {
    contact?: HubSpotContact | null;
    companyIds?: string[];
    companies: Record<string, HubSpotCompany | null>;
    contactDealIds?: string[];
    companyDealIds: Record<string, string[]>;
    deals: Record<string, HubSpotDeal | null>;
  }
  type HubSpotCheckpoint = {
    eventVersion: string;
    cache: HubSpotCheckpointCache;
    artifacts: HubSpotEnrichmentArtifact[];
    sections: MeetingBriefEnrichmentSection[];
    employerMatch: HubSpotCompany | null;
  };
  let prior: HubSpotCheckpoint | null = null;
  const existingRaw = ctx.readFile(checkpointFilename);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as HubSpotCheckpoint;
      prior = existing.eventVersion === eventVersion ? existing : null;
      if (
        prior &&
        existing.artifacts.length > 0 &&
        existing.artifacts.every(
          (artifact) => artifact.status === "completed" || artifact.status === "empty",
        )
      ) {
        return {
          artifacts: existing.artifacts,
          sections: existing.sections,
          employerMatch: existing.employerMatch,
        };
      }
    } catch {
      // ignore parse failure, fall through to API call
    }
  }

  const cache: HubSpotCheckpointCache = prior?.cache ?? {
    companies: {},
    companyDealIds: {},
    deals: {},
  };
  const cachedApi: HubSpotApi = {
    listContacts: (limit) => api.listContacts(limit),
    async searchContactByEmail(email) {
      if ("contact" in cache) return cache.contact ?? null;
      const value = await api.searchContactByEmail(email);
      cache.contact = value;
      return value;
    },
    async getAssociatedCompanyIds(contactId) {
      if (cache.companyIds) return cache.companyIds;
      const value = await api.getAssociatedCompanyIds(contactId);
      cache.companyIds = value;
      return value;
    },
    async getCompany(companyId) {
      if (Object.hasOwn(cache.companies, companyId)) return cache.companies[companyId] ?? null;
      const value = await api.getCompany(companyId);
      cache.companies[companyId] = value;
      return value;
    },
    async getAssociatedDealIds(contactId) {
      if (cache.contactDealIds) return cache.contactDealIds;
      const value = await api.getAssociatedDealIds(contactId);
      cache.contactDealIds = value;
      return value;
    },
    async getAssociatedDealIdsForCompany(companyId) {
      if (Object.hasOwn(cache.companyDealIds, companyId)) return cache.companyDealIds[companyId]!;
      const value = await api.getAssociatedDealIdsForCompany(companyId);
      cache.companyDealIds[companyId] = value;
      return value;
    },
    async getDeal(dealId) {
      if (Object.hasOwn(cache.deals, dealId)) return cache.deals[dealId] ?? null;
      const value = await api.getDeal(dealId);
      cache.deals[dealId] = value;
      return value;
    },
  };

  const outcome = await withBoundedRetry({
    attempt: (_attemptNumber, finalAttempt) =>
      enrichGuestWithHubSpot(cachedApi, eventVersion, guestEmail, ctx, { finalAttempt }),
    onRetry: (_error, attempt) =>
      ctx.event("hubspot_retry", { guest: guestEmail.toLowerCase(), attempt }),
    onProviderWide: () => {
      ctx.writeFile(
        checkpointFilename,
        JSON.stringify(
          {
            eventVersion,
            cache,
            artifacts: prior?.artifacts ?? [],
            sections: prior?.sections ?? [],
            employerMatch: prior?.employerMatch ?? null,
          },
          null,
          2,
        ) + "\n",
      );
    },
  });
  if (!outcome.ok) {
    // Preserve an explicit source gap when a non-provider-wide error exhausts its bounded retry.
    const error = outcome.error;
    const failedArtifact: HubSpotEnrichmentArtifact = {
      key: `${eventVersion}::${guestEmail.toLowerCase()}::hubspot-contact`,
      eventVersion,
      guestEmail: guestEmail.toLowerCase(),
      source: "hubspot-contact",
      status: "failed",
      evidence: [],
      references: [],
      diagnostics: {
        bounded: true,
        maxResults: 10,
        stableRef: `${eventVersion}::${guestEmail.toLowerCase()}::hubspot-contact`,
        httpStatus: readErrorStatus(error),
        errorCode: null,
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      },
      stableRef: `${eventVersion}::${guestEmail.toLowerCase()}::hubspot-contact`,
    };
    const failedFilename = `hubspot-${sanitizeArtifactVersion(eventVersion)}-${sanitized}-hubspot-contact.json`;
    ctx.writeFile(failedFilename, JSON.stringify(failedArtifact, null, 2) + "\n");
    return {
      artifacts: [failedArtifact],
      sections: [
        {
          source: "hubspot-contact",
          guest: guestEmail.toLowerCase(),
          status: "failed",
          evidence: [],
          references: [],
        },
      ],
      employerMatch: null,
    };
  }
  const result = outcome.value;
  ctx.writeFile(
    checkpointFilename,
    JSON.stringify({ eventVersion, cache, ...result }, null, 2) + "\n",
  );
  return result;
}

/**
 * The ledger's diagnostics summary, from a provider artifact's classified
 * facts. Artifacts that succeeded without an error carry no error diagnostics;
 * the ledger records null rather than an empty error shape.
 */
function outcomeDiagnostics(
  artifact:
    GoogleEnrichmentArtifact | PublicIntelligenceArtifact | HubSpotEnrichmentArtifact | null,
): MeetingBriefProviderOutcome["diagnostics"] {
  const raw = artifact?.diagnostics as Record<string, unknown> | undefined;
  if (!raw) return null;
  const httpStatus = raw.httpStatus;
  const errorCode = raw.errorCode;
  const reason = raw.reason;
  return {
    httpStatus: typeof httpStatus === "number" ? httpStatus : null,
    errorCode: typeof errorCode === "string" ? errorCode : null,
    reason: typeof reason === "string" ? reason : null,
  };
}

export async function enrichUnified(
  event: MeetingBriefEvent,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
  deps: UnifiedEnrichDeps,
): Promise<{
  sections: MeetingBriefEnrichmentSection[];
  evidence: string[];
  personProfileLinks: MeetingBriefPersonProfileLink[];
  bundleVersion: number;
  /** Versioned per-provider outcome ledger collected across the loop (#137). */
  outcomes: MeetingBriefProviderOutcome[];
}> {
  const providers = deps.providers;
  const hubSpotApi = providers.getHubSpotApi?.() ?? null;
  const internalDomains = deps.internalDomains ?? [];
  const allSections: MeetingBriefEnrichmentSection[] = [];
  const personProfileLinks: MeetingBriefPersonProfileLink[] = [];
  // Explicit policy exclusions (#137): a disabled provider is skipped, recorded,
  // and removed from the required set — never silently.
  const disabled: Record<string, true> = {};
  for (const provider of deps.disabledProviders ?? []) disabled[provider] = true;
  const outcomes: MeetingBriefProviderOutcome[] = [];
  const pushOutcome = (
    provider: MeetingBriefBundleProvider,
    attendee: string,
    status: MeetingBriefProviderOutcomeStatus,
    artifact:
      GoogleEnrichmentArtifact | PublicIntelligenceArtifact | HubSpotEnrichmentArtifact | null,
    filename: string | null,
  ): void => {
    outcomes.push({
      provider,
      attendee: attendee.toLowerCase(),
      outcome: disabled[provider] === true ? "disabled" : status,
      artifact: filename,
      diagnostics: outcomeDiagnostics(artifact),
    });
  };
  const occurrenceKey =
    deps.occurrenceKey ??
    meetingBriefOccurrenceIdentity(event.eventId, event.occurrenceId).occurrenceKey;
  const eventVersion = event.version;
  const eventStartAt = event.startAt;

  // Bundle selection (issue://136, spec Implementation Decision 18): every
  // non-resource attendee is classified against the configured Internal
  // Domains and enriched from its approved versioned bundle — internal
  // attendees from Workspace-owned evidence, external attendees from the
  // full collection.
  const classified = event.attendees
    .filter((attendee) => !attendee.resource)
    .map((attendee) => ({
      attendee,
      bundle: attendeeBundleFor(attendee.email, internalDomains),
    }));
  // Calendar attendee identity (issue #124): route every non-resource
  // attendee through the shared Person Profiles interface and pin the exact
  // Profile id + revision this Run consumes. A conflicting stable identifier
  // throws out of here, failing the stage visibly.
  let attendeePins: AttendeeProfilePin[] | null = null;
  if (providers.attendeeProfiles) {
    try {
      attendeePins = await pinAttendeeProfiles(
        providers.attendeeProfiles,
        event,
        occurrenceKey,
        ctx,
        providers.resolveNewAttendee,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An archived Profile holding an attendee email is its own classified
      // failure (issue://136); any other stable-identifier conflict is a
      // conflicting_identity — both are visible, never merged or overwritten.
      if (message.startsWith("archived_profile:")) throw new StageFailure("enrich", message);
      throw new StageFailure("enrich", `conflicting_identity: ${message}`);
    }
  }
  // Spec A: fail when a bundle-selected provider class is wholly unavailable
  // (rejected/missing_configuration/provider-wide outage). The requirement
  // follows the bundles of the attendees actually present: an internal-only
  // Brief never demands CRM or public search (issue://136).
  const selected = new Set(
    classified.flatMap(({ bundle }) => [...bundle.providers].filter((p) => !disabled[p])),
  );
  const missing: string[] = [];
  if (selected.has("person-profile") && !providers.attendeeProfiles) {
    missing.push("personProfile");
  }
  if (
    (selected.has("gmail-relationship") || selected.has("gmail-company-domain")) &&
    !providers.gmailProvider
  ) {
    missing.push("gmail");
  }
  if (selected.has("calendar-history") && !providers.calendarHistoryProvider) {
    missing.push("calendarHistory");
  }
  if (selected.has("drive-workspace") && !providers.driveProvider) {
    missing.push("drive");
  }
  if (selected.has("crm") && !hubSpotApi) {
    missing.push("hubSpot");
  }
  if (
    (selected.has("public-intelligence") || selected.has("employer-proposal")) &&
    !providers.publicIntelligenceProvider
  ) {
    missing.push("publicIntelligence");
  }
  if (missing.length > 0) {
    throw new StageFailure(
      "enrich",
      `missing_configuration: required providers unavailable: ${missing.join(", ")}`,
    );
  }

  for (const { attendee, bundle } of classified) {
    const attendeeEmail = attendee.email;
    const attendeeName = attendee.displayName ?? null;
    const domain = extractDomain(attendeeEmail) ?? "";
    const lowerDomain = domain.toLowerCase();
    const isConsumer = isConsumerDomain(lowerDomain);
    const isExternal = bundle.kind === "external";
    const selects = (provider: MeetingBriefBundleProvider): boolean =>
      bundle.providers.includes(provider);
    if (selects("gmail-relationship")) {
      if (disabled["gmail-relationship"]) {
        pushOutcome("gmail-relationship", attendeeEmail, "disabled", null, null);
      } else if (providers.gmailProvider) {
        const { artifact, section, filename } = await enrichGmailExact(
          providers.gmailProvider,
          eventVersion,
          attendeeEmail,
          ctx,
        );
        allSections.push(section);
        pushOutcome("gmail-relationship", attendeeEmail, artifact.status, artifact, filename);
      }
    }

    // 2. Gmail company-domain for external non-Consumer non-Internal guests
    if (isExternal && selects("gmail-company-domain") && domain && !isConsumer) {
      if (disabled["gmail-company-domain"]) {
        pushOutcome("gmail-company-domain", attendeeEmail, "disabled", null, null);
      } else if (providers.gmailProvider) {
        const { artifact, section, filename } = await enrichGmailCompanyDomain(
          providers.gmailProvider,
          eventVersion,
          attendeeEmail,
          lowerDomain,
          ctx,
        );
        allSections.push(section);
        pushOutcome("gmail-company-domain", attendeeEmail, artifact.status, artifact, filename);
      }
    }

    // 3. Calendar history
    if (selects("calendar-history")) {
      if (disabled["calendar-history"]) {
        pushOutcome("calendar-history", attendeeEmail, "disabled", null, null);
      } else if (providers.calendarHistoryProvider) {
        const { artifact, section, filename } = await enrichCalendarHistory(
          providers.calendarHistoryProvider,
          eventVersion,
          attendeeEmail,
          eventStartAt,
          ctx,
        );
        allSections.push(section);
        pushOutcome("calendar-history", attendeeEmail, artifact.status, artifact, filename);
      }
    }
    // 4. Drive docs — company-scoped for external guests, plain workspace
    // evidence for internal attendees.
    if (selects("drive-workspace")) {
      if (disabled["drive-workspace"]) {
        pushOutcome("drive-workspace", attendeeEmail, "disabled", null, null);
      } else if (providers.driveProvider) {
        const companyForDrive = isExternal && !isConsumer && domain ? lowerDomain : null;
        const { artifact, section, filename } = await enrichDriveDocs(
          providers.driveProvider,
          eventVersion,
          attendeeEmail,
          companyForDrive,
          ctx,
        );
        allSections.push(section);
        pushOutcome("drive-workspace", attendeeEmail, artifact.status, artifact, filename);
      }
    }

    // 5. Person Profile — every attendee consumes its pinned Profile revision
    // through the shared interface (issue #124, #136).
    let profileEmployerMatch: { name: string; domain: string | null } | null = null;
    if (selects("person-profile")) {
      if (disabled["person-profile"]) {
        pushOutcome("person-profile", attendeeEmail, "disabled", null, null);
      } else if (providers.attendeeProfiles && attendeePins) {
        const pin = attendeePins.find((item) => item.email === attendeeEmail.toLowerCase());
        if (!pin)
          throw new StageFailure(
            "enrich",
            `no pinned Person Profile for attendee ${attendeeEmail.toLowerCase()}`,
          );
        const { projection, section, filename } = pinnedPersonProfile(
          providers.attendeeProfiles,
          pin,
          eventVersion,
          ctx,
        );
        if (projection.currentEmployer) {
          profileEmployerMatch = { name: projection.currentEmployer, domain: null };
        }
        personProfileLinks.push({
          guestEmail: attendeeEmail.toLowerCase(),
          profileId: pin.profileId,
          profileRevision: pin.profileRevision,
        });
        allSections.push(section);
        // A pinned Profile that holds no meeting evidence is still a completed
        // consumption of the shared interface — empty is success (#137).
        pushOutcome("person-profile", attendeeEmail, section.status, null, filename);
      }
    }
    // 6. HubSpot
    let hubspotCompany: HubSpotCompany | null = null;
    if (selects("crm")) {
      if (disabled["crm"]) {
        pushOutcome("crm", attendeeEmail, "disabled", null, null);
      } else if (hubSpotApi) {
        const { artifacts, sections, employerMatch } = await enrichHubSpotWithRetry(
          hubSpotApi,
          eventVersion,
          attendeeEmail,
          ctx,
        );
        hubspotCompany = employerMatch;
        allSections.push(...sections);
        const failed = artifacts.find((artifact) => artifact.status === "failed") ?? null;
        pushOutcome(
          "crm",
          attendeeEmail,
          failed ? "failed" : "completed",
          failed,
          `hubspot-${sanitizeArtifactVersion(eventVersion)}-${attendeeEmail
            .toLowerCase()
            .replace(/[^a-zA-Z0-9]/g, "_")}-checkpoint.json`,
        );
      }
    }

    // 7. Employer Match resolution
    let employerMatch: { name: string; domain: string | null; source: string } | null = null;
    let employerMatchEvidence: string[] = [];
    let employerMatchReferences: string[] = [];

    if (hubspotCompany) {
      employerMatch = {
        name: hubspotCompany.name,
        domain: hubspotCompany.domain,
        source: "hubspot",
      };
      employerMatchEvidence = [
        `HubSpot company ${hubspotCompany.name} associated to ${attendeeEmail}`,
      ];
      employerMatchReferences = [`https://app.hubspot.com/companies/${hubspotCompany.id}`];
    } else if (profileEmployerMatch) {
      employerMatch = {
        name: profileEmployerMatch.name,
        domain: profileEmployerMatch.domain,
        source: "profile",
      };
      const personProfileSection = allSections.find(
        (section) =>
          section.source === PERSON_PROFILE_SOURCE_ID &&
          section.guest === attendeeEmail.toLowerCase(),
      );
      employerMatchEvidence = personProfileSection?.evidence ?? [];
      employerMatchReferences = personProfileSection?.references ?? [];
    } else if (
      selects("employer-proposal") &&
      providers.proposeEmployer &&
      providers.publicIntelligenceProvider
    ) {
      // Model proposes candidate to drive research
      const candidate = await providers.proposeEmployer(attendeeEmail, attendeeName, eventVersion);
      if (candidate) {
        const candName = candidate.name.trim();
        const candDomain = candidate.domain?.trim() ?? null;
        // Bounded research via public search, two-org rule
        const { artifact, section, verified } = await enrichEmployerVerification(
          providers.publicIntelligenceProvider,
          eventVersion,
          attendeeEmail,
          attendeeName,
          candName,
          candDomain,
          eventStartAt,
          ctx,
        );
        allSections.push(section);
        pushOutcome(
          "employer-proposal",
          attendeeEmail,
          artifact.status,
          artifact,
          fileNameFor("employer-verification", attendeeEmail.toLowerCase(), candName, eventVersion),
        );
        if (verified) {
          employerMatch = { name: candName, domain: candDomain, source: "verified-candidate" };
          employerMatchEvidence = artifact.evidence;
          employerMatchReferences = artifact.references;
          allSections.push({
            source: "employer-match",
            guest: attendeeEmail.toLowerCase(),
            company: candName,
            status: "completed",
            evidence: employerMatchEvidence,
            references: employerMatchReferences,
          });
        }
      } else {
        // The bundle selected the lane and the model proposed nothing to verify.
        pushOutcome("employer-proposal", attendeeEmail, "empty", null, null);
      }
    }

    // Direct provider evidence records the accepted employer relationship explicitly.
    if (
      employerMatch &&
      (employerMatch.source === "hubspot" || employerMatch.source === "profile")
    ) {
      const existingMatchSection = allSections.find(
        (s) => s.source === "employer-match" && s.guest === attendeeEmail.toLowerCase(),
      );
      if (!existingMatchSection) {
        allSections.push({
          source: "employer-match",
          guest: attendeeEmail.toLowerCase(),
          company: employerMatch.name,
          status: "completed",
          evidence: employerMatchEvidence,
          references: employerMatchReferences,
        });
      }
    }

    // Accepted matches unlock bounded company and industry intelligence.
    if (selects("public-intelligence")) {
      if (disabled["public-intelligence"]) {
        pushOutcome("public-intelligence", attendeeEmail, "disabled", null, null);
      } else if (employerMatch && providers.publicIntelligenceProvider) {
        const companyName = employerMatch.name;
        const companyDomain = employerMatch.domain;

        const { artifact: companyNewsArtifact, section: companyNews } = await enrichCompanyNews(
          providers.publicIntelligenceProvider,
          eventVersion,
          attendeeEmail,
          companyName,
          companyDomain,
          eventStartAt,
          ctx,
        );
        allSections.push(companyNews);

        const { artifact: industryNewsArtifact, section: industryNews } = await enrichIndustryNews(
          providers.publicIntelligenceProvider,
          eventVersion,
          attendeeEmail,
          companyName,
          companyDomain,
          eventStartAt,
          ctx,
        );
        allSections.push(industryNews);
        const failed = [companyNewsArtifact, industryNewsArtifact].find(
          (artifact) => artifact.status === "failed",
        );
        pushOutcome(
          "public-intelligence",
          attendeeEmail,
          failed ? "failed" : "completed",
          failed ?? companyNewsArtifact,
          fileNameFor("company-news", attendeeEmail.toLowerCase(), companyName, eventVersion),
        );
      } else if (isExternal) {
        // Selected with no accepted employer match — there is nothing to research yet.
        pushOutcome("public-intelligence", attendeeEmail, "empty", null, null);
      }
    }
  }

  // Confirmed transcript evidence (issue #138). It runs once, outside the
  // per-attendee loop: the organization and meeting-series lanes belong to the
  // occurrence, not to any one guest. Confirmed links — and only similarity
  // the owner explicitly confirmed — become a composable section; everything
  // still pending goes to its own review artifact, so composition is never
  // handed a suggestion it could state as fact.
  if (providers.transcriptEvidence) {
    if (disabled[TRANSCRIPT_EVIDENCE_SOURCE_ID]) {
      pushOutcome(TRANSCRIPT_EVIDENCE_SOURCE_ID, "", "disabled", null, null);
    } else {
      try {
        const collected = await providers.transcriptEvidence.collect({
          occurrenceKey,
          calendarEventId: event.eventId,
          title: event.summary ?? "",
          attendees: classified.map(({ attendee }) => attendee.email.toLowerCase()),
          organizations: deduplicateEvidence(
            classified
              .map(({ attendee }) => extractDomain(attendee.email)?.toLowerCase() ?? "")
              .filter(Boolean),
          ),
        });
        const selection = selectTranscriptEvidence(collected);
        allSections.push({
          source: TRANSCRIPT_EVIDENCE_SOURCE_ID,
          status: selection.evidence.length > 0 ? "completed" : "empty",
          evidence: selection.evidence.map((item) => sanitizeEvidence(item.excerpt)),
          references: [],
        });
        ctx.writeFile(
          "transcript-suggestions.json",
          JSON.stringify({ version: 1, suggestions: selection.suggestions }, null, 2) + "\n",
        );
        pushOutcome(
          TRANSCRIPT_EVIDENCE_SOURCE_ID,
          "",
          selection.evidence.length > 0 ? "completed" : "empty",
          null,
          null,
        );
      } catch (error) {
        // A lane that is configured and then fails is missing evidence, and
        // #137's gate must see it — never a silently thinner Brief.
        allSections.push({
          source: TRANSCRIPT_EVIDENCE_SOURCE_ID,
          status: "failed",
          evidence: [],
          references: [],
        });
        outcomes.push({
          provider: TRANSCRIPT_EVIDENCE_SOURCE_ID,
          attendee: "",
          outcome: "failed",
          artifact: null,
          diagnostics: {
            httpStatus: readErrorStatus(error),
            errorCode: null,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  // Normalize + deduplicate all evidence while preserving source ownership/refs
  // Per-artifact dedup already done, now global dedup for enrich.json evidence
  const rawEvidence = allSections.flatMap((s) => s.evidence);
  const normalized = rawEvidence.map(sanitizeEvidence).filter(Boolean);
  const globalDeduped = deduplicateEvidence(normalized);

  // Also deduplicate sections' evidence per source preserving ownership: each section's evidence already deduped per artifact, but we ensure per-section dedup as well
  const dedupedSections = allSections.map((section) => {
    const deduped = deduplicateEvidence(section.evidence.map(sanitizeEvidence));
    return { ...section, evidence: deduped };
  });

  // Persist aggregated enrich.json with normalized deduped evidence
  // The caller will write enrich.json, but we return sections and evidence
  return {
    sections: dedupedSections,
    evidence: globalDeduped,
    personProfileLinks,
    bundleVersion: MEETING_BRIEF_BUNDLES_VERSION,
    outcomes,
  };
}
