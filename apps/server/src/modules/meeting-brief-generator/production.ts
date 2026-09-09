import type { DailyBriefingWork } from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../../llm/providers.js";
import type { ConfigStore } from "../../config.js";
import type { GoogleConnection } from "../../google/connection.js";
import type { Runs } from "../../runs.js";
import { RelayWakeUpPoller } from "../../relay/poller.js";
import { RelayStateStore } from "../../relay/state.js";
import { MeetingBriefHost } from "./host.js";
import { HubSpotConnection } from "./hubspot/connection.js";
import { createGmailProvider, type GmailProvider } from "./google/gmail.js";
import {
  createCalendarHistoryProvider,
  type CalendarHistoryProvider,
} from "./google/calendarHistory.js";
import { createDriveProvider, type DriveProvider } from "./google/drive.js";
import {
  createGmailDeliveryProvider,
  gmailOwnerEmail,
  type GmailDeliveryProvider,
} from "./google/gmailDelivery.js";
import {
  createGoogleCalendarProvider,
  googleCalendarTransport,
  workspaceCalendarRelayRegistry,
} from "./google/calendar.js";
import { DuckDuckGoPublicIntelligenceProvider } from "./enrichment/publicIntelligence.js";
import { createEmployerProposer } from "./enrichment/employerProposer.js";
import { WorkspacePersonProfiles } from "../../person-profile/profiles.js";
import { WorkspacePersonProfileReferences } from "../../person-profile/references.js";
import { PersonProfileStore } from "../../person-profile/store.js";
import { TranscriptCatalogStore } from "../../transcript-catalog/store.js";
import type { TranscriptRelevanceService } from "../../transcript-catalog/relevance.js";
import { catalogTranscriptEvidence } from "./catalogTranscriptEvidence.js";
import { ContentResearchStore } from "../content-research/store.js";
import type { ConfirmedOwnerReference } from "@chief-of-staff-demo/shared";

export interface MeetingBriefProductionRuntimeOptions {
  runs: Runs;
  workspaceDir: string;
  configStore: ConfigStore;
  google: GoogleConnection;
  getCompleteJson: () => CompleteJson;
  /**
   * Owner onboarding (issue #123): owner-only delivery is gated separately
   * from Calendar eligibility, which keeps using the raw connected identity.
   */
  isOwnerProfileConfirmed?: () => boolean;
  log?: (message: string) => void;
  personProfiles?: WorkspacePersonProfiles;
  /** Public-web enrichment for an attendee met for the first time; the root
   *  passes the shared resolver, and without it a new attendee stays a shell. */
  resolveNewAttendee?: (email: string) => Promise<unknown>;
  /** The Catalog's relevance service, backing the confirmed-transcript lane
   *  (issue #138). Absent — a Workspace with no Transcript consent — the lane
   *  does not run and the Brief is unaffected. */
  transcriptRelevance?: TranscriptRelevanceService;
  /** The confirmed owner reference, when this root also composes owner
      onboarding. The main root always passes a shared `personProfiles` that
      already carries it, so this stays unset there. */
  ownerReference?: () => ConfirmedOwnerReference | null;
  /** The one backward read's bound (issue #152); see MeetingBriefHostDeps. */
  oldestTranscriptAt?: () => string | null;
  /** The Tasks product's bounded projection of the day's work (issue #192). */
  getBriefingWork?: () => DailyBriefingWork;
  /** The standing Transcript ↔ Meeting join (issue #153); see MeetingBriefHostDeps. */
  associateTranscripts?: () => Promise<void> | void;
}

export interface MeetingBriefProductionRuntime {
  host: MeetingBriefHost;
  relayPoller: RelayWakeUpPoller;
  hubSpotConnection: HubSpotConnection;
  invalidateGoogleIdentity(): void;
  /** Read the connected Google identity and cache it as the workspace owner. */
  refreshOwnerIdentity(): Promise<string | null>;
  /** Owner-only Gmail delivery, for the Shell's Weekly Briefing email (issue #197). */
  gmailDelivery: GmailDeliveryProvider;
}

/** Production composition root for the complete live Meeting Brief Generator. */
export function createMeetingBriefProductionRuntime(
  options: MeetingBriefProductionRuntimeOptions,
): MeetingBriefProductionRuntime {
  const requireGoogleAuth = () => {
    const access = options.google.auth();
    if (!access.ok) throw new Error(`missing_configuration: Google connection is ${access.state}`);
    return access.auth;
  };
  /**
   * The workspace owner, and its only source is the connected Google identity
   * (ADR-0034). Never event data: an attendee marked `self` is the same address
   * in the happy case, but it arrives from the Calendar payload, it is absent
   * whenever a read returns no event carrying it, and reading it there makes
   * every eligibility decision depend on what a list call happened to return.
   * `refreshOwnerIdentity` is awaited before the Module starts, so the owner is
   * known before the first Run rather than discovered by one.
   */
  let ownerEmail: string | null = null;
  let deliveryOwnerEmail: string | null = null;
  const invalidateGoogleIdentity = (): void => {
    ownerEmail = null;
    deliveryOwnerEmail = null;
  };
  const refreshOwnerIdentity = async (): Promise<string | null> => {
    const status = await options.google.state();
    ownerEmail = status.state === "connected" && status.email ? status.email.toLowerCase() : null;
    return ownerEmail;
  };

  const gmailProvider: GmailProvider = {
    listExactThreads: (guestEmail, maxResults) =>
      createGmailProvider(requireGoogleAuth()).listExactThreads(guestEmail, maxResults),
    listCompanyThreads: (companyDomain, maxResults) =>
      createGmailProvider(requireGoogleAuth()).listCompanyThreads(companyDomain, maxResults),
  };
  const calendarHistoryProvider: CalendarHistoryProvider = {
    listPastMeetings: (guestEmail, maxResults, before) =>
      createCalendarHistoryProvider(requireGoogleAuth()).listPastMeetings(
        guestEmail,
        maxResults,
        before,
      ),
  };
  const driveProvider: DriveProvider = {
    searchDocs: (query, maxResults) =>
      createDriveProvider(requireGoogleAuth()).searchDocs(query, maxResults),
  };
  const resolveDeliveryOwner = async () => {
    deliveryOwnerEmail ??= await gmailOwnerEmail(requireGoogleAuth());
    return deliveryOwnerEmail;
  };
  const gmailDeliveryProvider: GmailDeliveryProvider = {
    async send(params) {
      return createGmailDeliveryProvider(requireGoogleAuth(), await resolveDeliveryOwner()).send(
        params,
      );
    },
    async findByDeliveryId(deliveryId) {
      return createGmailDeliveryProvider(
        requireGoogleAuth(),
        await resolveDeliveryOwner(),
      ).findByDeliveryId(deliveryId);
    },
  };
  const relayStore = new RelayStateStore(`${options.workspaceDir}/relay.json`);
  const googleCalendarProvider = createGoogleCalendarProvider(
    googleCalendarTransport(requireGoogleAuth),
    workspaceCalendarRelayRegistry(relayStore),
  );
  const hubSpotConnection = new HubSpotConnection(options.configStore);
  /* Calendar attendee identity (issue #124) routes through the shared Person
     Profiles interface, not the legacy broad resolver: attendees reuse an
     existing Profile on a non-conflicting exact email match or receive one
     minimal email-anchored shell. */
  /* A root that composes its own Person Profiles still states the registry
     with the real Workspace stores behind the disclosure; the owner
     reference arrives through the option when this root owns onboarding.
     The stores exist only for this fallback — the main root injects a shared
     personProfiles and never constructs them. */
  const personProfiles =
    options.personProfiles ??
    new WorkspacePersonProfiles({
      store: new PersonProfileStore(options.workspaceDir),
      lifecycle: [
        new WorkspacePersonProfileReferences(options.runs, {
          ownerReference: options.ownerReference ?? (() => null),
          transcripts: () => new TranscriptCatalogStore(options.workspaceDir).listTranscripts(),
          publicItems: () =>
            new ContentResearchStore(options.workspaceDir, () => new Date()).listAllItems(),
        }),
      ],
    });
  const host = new MeetingBriefHost({
    runs: options.runs,
    workspaceDir: options.workspaceDir,
    configStore: options.configStore,
    getCompleteJson: options.getCompleteJson,
    calendarProvider: googleCalendarProvider,
    calendarUse: "snapshot",
    enrichmentProviders: {
      gmailProvider,
      calendarHistoryProvider,
      driveProvider,
      attendeeProfiles: personProfiles,
      ...(options.resolveNewAttendee ? { resolveNewAttendee: options.resolveNewAttendee } : {}),
      publicIntelligenceProvider: new DuckDuckGoPublicIntelligenceProvider(),
      proposeEmployer: createEmployerProposer(options.getCompleteJson),
      ...(options.transcriptRelevance
        ? {
            transcriptEvidence: catalogTranscriptEvidence({
              listTranscripts: () =>
                new TranscriptCatalogStore(options.workspaceDir).listTranscripts(),
              relevance: options.transcriptRelevance,
            }),
          }
        : {}),
    },
    getOwnerEmail: () => ownerEmail,
    /* Single-email policy (issue #163): preparation never emails per-Brief —
       the Brief stays available in-app and the owner sends it explicitly.
       The Daily and Weekly Briefings each email the owner once per period. */
    perBriefAutoSend: false,
    briefingEmails: true,
    ...(options.isOwnerProfileConfirmed
      ? { isOwnerProfileConfirmed: options.isOwnerProfileConfirmed }
      : {}),
    gmailDeliveryProvider,
    personProfiles,
    ...(options.oldestTranscriptAt ? { oldestTranscriptAt: options.oldestTranscriptAt } : {}),
    ...(options.getBriefingWork ? { getBriefingWork: options.getBriefingWork } : {}),
    ...(options.associateTranscripts ? { associateTranscripts: options.associateTranscripts } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const relayPoller = new RelayWakeUpPoller({
    store: relayStore,
    processWakeUps: (messages) => host.handleRelayWakeUp(messages).then(() => undefined),
    ...(options.log ? { log: options.log } : {}),
  });
  return {
    host,
    relayPoller,
    hubSpotConnection,
    invalidateGoogleIdentity,
    refreshOwnerIdentity,
    /* Owner-only Gmail delivery, exposed so the Shell can hand it to the
       Weekly Briefing email (issue #197). The adapter, not a raw Gmail
       client: the recipient stays the authenticated account's own. */
    gmailDelivery: gmailDeliveryProvider,
  };
}
