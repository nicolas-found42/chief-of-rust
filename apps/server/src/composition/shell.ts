import { weeklyMeetingSources } from "../meetings/weekly-sources.js";
import type { PersonRelationshipRecord } from "@chief-of-staff-demo/shared";
import { registerPersonDossierApi } from "../api/person-dossiers.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AppConfig, ConfirmedOwnerReference, ModelPurpose } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "../config.js";
import { registerApi } from "../api/router.js";
import { registerStaticServing } from "../api/static.js";
import { registerRelayRoutes } from "../relay/routes.js";
import { seedRelayBaseUrlFromEnv } from "../relay/state.js";
import { registerMeetingBriefHubSpotRoutes } from "../modules/meeting-brief-generator/hubspot/routes.js";
import {
  contentScoutTestPorts,
  personDossierTestPorts,
  registerTestSeed,
} from "../api/testSeed.js";
import type { PersonProfileStore } from "../person-profile/store.js";
import { composePersonProfiles } from "../person-profile/composition.js";
import { WorkspaceMeetings } from "../meetings/store.js";
import { WorkspaceMeetingJoin } from "../meetings/join.js";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import { WorkspacePersonProfileReferences } from "../person-profile/references.js";
import { TranscriptCatalogStore } from "../transcript-catalog/store.js";
import {
  createTranscriptCatalogRuntime,
  type TranscriptCatalogRuntime,
} from "../transcript-catalog/production.js";
import { registerTranscriptIntakeApi } from "../api/transcript-intake.js";
import { convertToText } from "../text/convert.js";
import { conversionStageFailure } from "../text/failure.js";

import { OwnerOnboarding } from "../onboarding/owner.js";
import { composeTasks } from "../tasks/composition.js";
import type { WorkspaceTasks } from "../tasks/tasks.js";
import type { WorkspaceActionItems } from "../tasks/action-items.js";
import type { TaskLinking } from "../tasks/external-link.js";
import { TaskCutover } from "../tasks/cutover.js";
import { buildDailyBriefingWork } from "../tasks/briefing-projection.js";
import { WeeklyWorkspace } from "../meetings/weekly.js";
import type { HostedModule } from "../engine/host.js";
import { makeCompleteJson } from "../llm/providers.js";
import { googleFailureHint, openGoogleConnection } from "../google/connection.js";
import { YoutubeHost } from "../modules/youtube/host.js";
import { ContentScoutHost } from "../modules/content-scout/host.js";
import { MeetingBriefHost } from "../modules/meeting-brief-generator/host.js";
import { createMeetingBriefProductionRuntime } from "../modules/meeting-brief-generator/production.js";
import { MeetingDebriefHost } from "../modules/meeting-debrief/host.js";
import { createMeetingDebriefProductionRuntime } from "../modules/meeting-debrief/production.js";
import {
  createMeetingDebriefTestRuntime,
  registerMeetingDebriefTestRoutes,
} from "../modules/meeting-debrief/testRuntime.js";
import {
  createMeetingBriefTestRuntime,
  registerMeetingBriefTestRoutes,
} from "../modules/meeting-brief-generator/testRuntime.js";
import { playwrightBrowserRenderer } from "../source-adapters/browser.js";
import { youtubeSourceClient } from "../source-adapters/youtube.js";
import { ExternalRuntimeInspector } from "../modules/content-scout/runtime.js";
import { contentScoutProductionAdapters } from "../modules/content-scout/adapters/production.js";
import { contentResearchProductionAdapters } from "./content-research-portfolio.js";
import { PublicRouteSourceDiscoverer } from "../modules/content-scout/discoverer.js";
import {
  PublicBrandProfileCrawler,
  modelBrandProfileProposer,
} from "../modules/content-scout/brand-profile.js";
import { modelOpportunityRanker } from "../modules/content-scout/model.js";
import { WorkspaceContentProjects } from "../content-projects/projects.js";
import {
  createModelDraftGenerator,
  createModelOutlineGenerator,
} from "../content-projects/generation.js";
import { createPublicSearchResearchProvider } from "../content-projects/research.js";
import { contentProjectOpportunityStarter } from "../content-projects/opportunity-projects.js";
import { workspaceLayout } from "../paths.js";
import { openRuns, type Runs } from "../runs.js";
import { ContentResearchHost } from "../modules/content-research/host.js";
import { ContentResearchStore } from "../modules/content-research/store.js";
import { ContentResearchWatchRegistry } from "../modules/content-research/profile-registry.js";
import { createHookExtractor, createPeopleDiscoverer } from "../modules/content-research/model.js";
import { seedContentResearchV1 } from "../modules/content-research/seed.js";
import { createPublicSearch, type PublicSearchDiagnostics } from "../source-adapters/search.js";
import { parsePersonIdentifier } from "../person-profile/identifier.js";
import { WorkspaceBrandProfileStore } from "../brand-profile/store.js";
import { buildGoogleAuth } from "../google/oauth.js";
import {
  createSpreadsheet,
  ensureTab,
  appendRows,
  readRows,
  updateRow,
  isSpreadsheetMissing,
} from "../google/sheets.js";
import { createGmailDraft } from "../google/gmail.js";
import { TranscriptRelevanceService } from "../transcript-catalog/relevance.js";
import { TranscriptRelevanceStore } from "../transcript-catalog/relevance-store.js";
import { TranscriptIdentityStore } from "../transcript-catalog/identity-store.js";
import { TranscriptIdentityService } from "../transcript-catalog/identity.js";
import {
  TranscriptDeletionService,
  type TranscriptConsumerRegistry,
} from "../transcript-catalog/deletion.js";
import { registerTranscriptRelevanceApi } from "../api/transcript-review.js";
import { registerTranscriptDeletionApi } from "../api/transcript-delete.js";
import {
  registerMigrationGate,
  registerMigrationRoutes,
  type MigrationGate,
} from "../api/migration.js";
import { registerClearDataApi } from "../api/clear-data.js";

/** The module id fixture Runs are attributed to in the browser suite only. */
const SEED_FIXTURE_MODULE_ID = "seed-fixture";

/**
 * The Shell's composition root — every Workspace store, Module host, runtime and
 * route the product is made of, wired once, in one place.
 *
 * This lived inside `main.ts` until the audit that followed #144, where it was
 * the common cause behind three defects rather than one. The Transcript Catalog
 * (#125) passed a full suite while nothing in production constructed it. The
 * migration classification table (#119) drifted out of `ConfigSchema`. And the
 * boot path diverged from the in-process cutover the migration gate performs, so
 * a Workspace migrated without a restart came up missing its runs directory and
 * its V1 watchlist. None of the three was reachable from a test, for the same
 * reason: `main.ts` is a top-level-await script that binds a port, so importing
 * it is starting the server, and the only wiring a test could examine was the
 * source text.
 *
 * Extracted here it is an ordinary function. `composeShell` builds the whole
 * graph and registers every route, and does not listen — `main.ts` does that, and
 * nothing else. A test composes a Shell over a temporary Workspace, drives it
 * through `app.inject`, and asserts on what the composition actually did.
 *
 * `start` is the boot sequence, named so the migration gate's in-process cutover
 * performs exactly it. Every Workspace write the gate must be able to withhold
 * belongs inside it and nowhere else: a write out here runs while the gate is
 * still holding a pre-cutover Workspace, and does not run again when the gate
 * completes in this process. That is both halves of #144, and it is what
 * tests/src/composition/shell-composition.test.ts holds this file to.
 */
export interface ShellOptions {
  workspaceDir: string;
  /** The port the OAuth redirect URI names. Composition never binds it. */
  port: number;
}

export interface Shell {
  /** Fully registered, not listening. */
  app: FastifyInstance;
  /** The configuration as boot read it, for the startup log. */
  config: AppConfig;
  gate: MigrationGate;
  modules: HostedModule[];
  workspace: ShellWorkspace;
  /** The boot sequence. Idempotent, and the only thing the gate's cutover runs. */
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * The Workspace state this root composed, under the name it holds it by.
 *
 * A Module's own store is not here — that belongs to the Module and is reached
 * through `modules` — but everything the root itself constructs is, because a
 * store the root builds and then names nowhere is a store nothing can be seen
 * to hold. That is #125 precisely: the Transcript Catalog was constructed by no
 * production code at all, and the four transcript owners below are still the
 * ones no Module holds on the root's behalf.
 */
interface ShellWorkspace {
  config: ConfigStore;
  runs: Runs;
  people: PersonProfileStore;
  profiles: WorkspacePersonProfiles;
  onboarding: OwnerOnboarding;
  brandProfiles: WorkspaceBrandProfileStore;
  contentProjects: WorkspaceContentProjects;
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
  taskLinking: TaskLinking;
  /** Meeting Wizard's This week runtime, and the Monday email it schedules (issues #194, #197). */
  weeklyWorkspace: WeeklyWorkspace;
  transcripts: TranscriptCatalogStore;
  transcriptIdentity: TranscriptIdentityStore;
  /** The one identity service every consumer asks; see ADR-note in identity-store.ts. */
  transcriptIdentityService: TranscriptIdentityService;
  transcriptRelevance: TranscriptRelevanceService;
  transcriptDeletion: TranscriptDeletionService;
  transcriptCatalog: TranscriptCatalogRuntime;
}

export async function composeShell(options: ShellOptions): Promise<Shell> {
  const { workspaceDir, port } = options;
  const layout = workspaceLayout(workspaceDir);
  /* The one-time Workspace migration gate (issue #144). A pre-cutover Workspace
     blocks every normal API surface behind the migration UI and keeps the
     Modules unstarted; confirming the migration in this process performs the
     boot-time startup sequence itself (startModules). The hermetic test seed's
     arm/disarm seam drives the same gate, so there is one machinery.
     `modulesRunning` is the gate's knowledge of what it started and stopped:
     the arm seam stops Modules, and neither restart path may double-start a
     scheduler the confirm already restarted. */
  let gateActive = new TaskCutover({ workspaceDir }).state() === "required";
  let modulesRunning = false;
  const migrationGate: MigrationGate = {
    isActive() {
      return gateActive;
    },
    setActive(active: boolean) {
      gateActive = active;
      if (active && modulesRunning) stopModules();
      if (!active && !modulesRunning) void startModules();
    },
    complete() {
      gateActive = false;
      if (!modulesRunning) {
        /* The reset rewrote config.json on disk preserving only authentication;
           adopt that rewrite in memory before any Module runs, so no stale
           pre-cutover destination or schedule survives the cutover. */
        configStore.load({ persist: false });
        void startModules();
      }
    },
  };
  function stopModules(): void {
    personProfilesProduct.stop();
    taskProduct.stop();
    weeklyWorkspace.stop();
    for (const module of modules) {
      module.stop?.();
    }
    transcriptCatalogRuntime.stop();
    meetingBriefProduction?.relayPoller.stop();
    modulesRunning = false;
  }

  /* While the gate holds the Workspace pre-cutover, boot writes nothing:
     ConfigStore reads config.json without normalizing it back, and the runs
     directory and the V1 watchlist are written by startModules, which the gate
     does not run. Cancelling must leave the Workspace byte-for-byte unchanged
     (spec Cutover ACs). */
  const configStore = new ConfigStore(layout.configFile, !migrationGate.isActive());
  const config = configStore.load();

  const googleConnection = openGoogleConnection(configStore, port);
  /* One owner for the run directory: every Module and the API read and write the
     same Runs, not one object per Module over one directory. */
  const runs = openRuns(workspaceDir);
  /* Content Research owns its watches, so its Profile references are disclosed
     by a registry over the same store the Module runs on (spec #134, ADR-0042):
     archive and privacy deletion refuse while a watch is active, and privacy
     deletion purges the watch's reference. The store is created here so the
     registry and the Module share the one Workspace state. */
  const contentResearchStore = new ContentResearchStore(workspaceDir, () => new Date());
  /* Lifecycle disclosures come from the real Workspace stores: the confirmed
     owner reference is the active dependent configuration, and the residual
     disclosure scans the catalogued transcripts and collected public source
     items that name the person. All reads are local. */
  const transcriptCatalogStore = new TranscriptCatalogStore(workspaceDir);
  /* Resolve model settings per call so research and identity lookup pick up
     Settings edits without restarting the app. */
  const completeForPurpose = (purpose: ModelPurpose) => {
    const current = configStore.getForPurpose(purpose);
    return makeCompleteJson(
      {
        provider: current.provider,
        model: current.model,
        apiKey: current.apiKey,
        baseUrl: current.ollama.baseUrl,
      },
      layout.mockResultFile,
    );
  };
  const peopleCompleteJson = () => completeForPurpose("personResearch");
  /* One shared PublicSearch instance for every consumer: one home IP shares
     every provider's rate limits, so the query cache and the per-provider
     cooldowns must be app-wide rather than per consumer — three separate
     instances would fan the same query out three times and spend the very
     limits the fan-out exists to pace. */
  const searxngUrl = configStore.get().search.searxngUrl || process.env.SEARXNG_URL;
  const publicSearchDiagnostics: PublicSearchDiagnostics = (event) => {
    const detail = event.detail ? ` — ${event.detail}` : "";
    console.log(
      `[public-search] ${event.provider} ${event.outcome} (${event.results} results, ${event.ms}ms)${detail}`,
    );
  };
  const publicSearch = createPublicSearch(undefined, undefined, {
    diagnostics: publicSearchDiagnostics,
    ...(searxngUrl !== undefined ? { searxngUrl } : {}),
  });
  /* Person Profiles (ADR-0042, ADR-0062): the Workspace's dossiers, their
     automatic research, and the public-web identity resolver, composed as
     their own product. The Shell hands over the Workspace directory, the
     shared outward surfaces, and the four questions only it can answer —
     including which Transcripts a Profile is confirmed in, which is the
     Transcript Catalog's question and arrives already answered. The stores,
     the research pipeline and the queue are the product's own. */
  const personProfilesProduct = composePersonProfiles({
    workspaceDir,
    search: publicSearch,
    complete: peopleCompleteJson,
    plan: () => completeForPurpose("researchPlanning"),
    confirmedTranscripts: (profileId) =>
      transcriptIdentityService.confirmedMentions(profileId).flatMap((mention) => {
        const transcript = transcriptCatalogStore.readTranscript(mention.transcriptId);
        return transcript
          ? [
              {
                transcriptId: transcript.id,
                fileName: transcript.source.fileName,
                text: transcript.normalizedText,
                checksum: transcript.source.checksum,
              },
            ]
          : [];
      }),
    /* One record read, not the corpus: research asks this per result. */
    transcriptStillConfirmed: (profileId, transcriptId, checksum) =>
      transcriptCatalogStore.readTranscript(transcriptId)?.source.checksum === checksum &&
      transcriptIdentityService
        .confirmedMentions(profileId)
        .some((mention) => mention.transcriptId === transcriptId),
    researchEnabled: () => !migrationGate.isActive(),
    upcomingParticipantEmails: () =>
      meetings
        .list()
        .filter(
          (meeting) =>
            !meeting.cancelled &&
            Date.parse(meeting.startAt) >= Date.now() &&
            Date.parse(meeting.startAt) <= Date.now() + 48 * 3600000,
        )
        .flatMap((meeting) =>
          meeting.participants.map((participant) => participant.email.toLowerCase()),
        ),
    lifecycle: [
      new WorkspacePersonProfileReferences(runs, {
        ownerReference: (): ConfirmedOwnerReference | null => ownerOnboarding.confirmed(),
        transcripts: () => transcriptCatalogStore.listTranscripts(),
        publicItems: () => contentResearch.listSourceItems(),
      }),
      new ContentResearchWatchRegistry(contentResearchStore),
    ],
    ...(process.env.ENABLE_TEST_SEED === "1"
      ? { researchTestPorts: personDossierTestPorts }
      : { render: playwrightBrowserRenderer() }),
  });
  const {
    store: peopleStore,
    profiles: peopleProfiles,
    dossiers: personDossiers,
    queue: personResearchQueue,
    resolver: peopleResolver,
  } = personProfilesProduct;
  const ownerOnboarding = new OwnerOnboarding({ people: peopleProfiles, workspaceDir });
  /* The Workspace's Meetings (ADR-0050). The Meeting Brief Generator's host
     builds its own reader over the same file; the store keeps no memory, so
     the two never hold competing caches. */
  const meetings = new WorkspaceMeetings(workspaceDir, () => new Date());
  /* Tasks (ADR-0052, ADR-0058, issue #200): the canonical record of accepted
     work, and the Action Items a Meeting Debrief proposes, composed as their
     own product. The Shell hands over Workspace handles, credentials, and the
     identity and timezone questions only it can answer; the store, the
     provider adapters and the promotion policy are the module's own. */
  const taskProduct = composeTasks({
    workspaceDir,
    configStore,
    googleConnection,
    googleFailureHint,
    isConfirmedPerson: (profileId) => {
      const profile = peopleProfiles.get(profileId);
      return profile !== null && profile.archivedAt === null && profile.mergedInto === undefined;
    },
    ownerProfileId: () => ownerOnboarding.confirmed()?.profileId ?? null,
    /* The Workspace has one configured timezone rather than a Tasks-specific
       one — the owner's day is the owner's day whichever product asks — and
       the host's own zone is the fallback, never a silent UTC. */
    timezone: () =>
      configStore.getModuleConfig("content-research").timeZone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    onActionItemsChanged: () => notifyBriefActionItemsChanged(),
    log: (message) => console.log(`[tasks] ${message}`),
  });
  const { tasks, actionItems, linking: taskLinking, asanaLinking } = taskProduct;
  const materializeActionItemsUnderPolicy = taskProduct.materialize;

  const taskCutover = new TaskCutover({
    workspaceDir,
    meetingIdFor: (transcriptId) =>
      transcriptCatalogStore.readTranscript(transcriptId)?.meetingId ?? null,
    readRemote: (destination, remoteId) => taskProduct.googleConnector.read(destination, remoteId),
  });

  /* Semantic transcript relevance (issue #127): the reviewable discovery lane
     over the Transcript Catalog's retained corpus. Like the Catalog itself it
     is a Workspace resource behind a library seam; the Drive ingestion
     composition remains with the integrating ticket (#126 hand-forward). The
     local lexical index keeps every judgment in-process (ADR-0001). */
  const transcriptRelevanceStore = new TranscriptRelevanceStore(workspaceDir);
  const transcriptIdentityStore = new TranscriptIdentityStore(workspaceDir);
  /* One identity service over that store, for every consumer that asks the
     Catalog an identity question: the Person Profiles research lane, the
     Meeting Debrief's two runtimes, and the Catalog's own mining pass. Built
     here rather than inside each of them, because four services over one
     directory is four places that could answer differently.
     `automaticCreation` stays true: it is the Catalog's mining posture, and
     it moved here with the construction rather than changing. */
  const transcriptIdentityService = new TranscriptIdentityService({
    store: transcriptIdentityStore,
    people: peopleProfiles,
    automaticCreation: true,
  });
  const transcriptRelevance = new TranscriptRelevanceService({
    corpus: transcriptCatalogStore,
    store: transcriptRelevanceStore,
  });

  /* Transcript deletion with local cascades and reingestion tombstones (issue
     #128). Each consuming product registers its own cascades and this is the
     list of them; Person Profiles contributes two, and a consumer built on
     transcript-derived Runs would add its own here the same way. */
  const transcriptConsumerRegistries: TranscriptConsumerRegistry[] = [
    ...personProfilesProduct.transcriptConsumers,
  ];
  const transcriptDeletion = new TranscriptDeletionService({
    catalog: transcriptCatalogStore,
    identity: transcriptIdentityStore,
    relevance: transcriptRelevanceStore,
    registries: transcriptConsumerRegistries,
    log: (message) => console.log(`[transcript] ${message}`),
  });

  const youtube = new YoutubeHost({
    runs,
    configStore,
    workspaceDir,
    port,
    google: googleConnection,
    log: (message) => console.log(`[youtube-trends] ${message}`),
  });

  const contentScoutCompleteJson = () => completeForPurpose("contentDiscovery");
  const contentGenerationCompleteJson = () => completeForPurpose("contentGeneration");
  const testContentScout =
    process.env.ENABLE_TEST_SEED === "1" ? contentScoutTestPorts(() => new Date()) : null;
  /* The governed Content Engine path (#133): selecting a shortlisted Content
     Opportunity starts exactly one Content Project here; the Pack and Notion
     publication path is retired. Generation and research run through the
     Project's own gates at the Shell's one model seam. */
  const contentProjects = new WorkspaceContentProjects({
    workspaceDir,
    people: peopleProfiles,
    ownerOnboarding,
    brandProfiles: new WorkspaceBrandProfileStore(workspaceDir, () => new Date()),
    researchProviders: [createPublicSearchResearchProvider(publicSearch, () => new Date())],
    outlineGenerator: createModelOutlineGenerator(contentGenerationCompleteJson),
    draftGenerator: createModelDraftGenerator(contentGenerationCompleteJson),
  });
  const contentScout = new ContentScoutHost({
    runs,
    workspaceDir,
    configStore,
    adapters:
      testContentScout?.adapters ??
      contentScoutProductionAdapters({
        workspaceDir,
        renderBrowser: playwrightBrowserRenderer(),
        getYouTubeAccess: () => {
          const access = googleConnection.auth();
          return access.ok
            ? { ok: true, client: youtubeSourceClient(access.auth) }
            : { ok: false, state: access.state };
        },
      }),
    ranker: testContentScout?.ranker ?? modelOpportunityRanker(contentScoutCompleteJson),
    opportunityProjects: contentProjectOpportunityStarter(contentProjects),
    discoverer: new PublicRouteSourceDiscoverer(),
    brandProfileCrawler: testContentScout?.brandProfileCrawler ?? new PublicBrandProfileCrawler(),
    brandProfileProposer:
      testContentScout?.brandProfileProposer ?? modelBrandProfileProposer(contentScoutCompleteJson),
    runtimeInspector: testContentScout?.runtimeInspector ?? new ExternalRuntimeInspector(),
    isOwnerProfileConfirmed: () => ownerOnboarding.confirmed() !== null,
    log: (message) => console.log(`[content-scout] ${message}`),
  });
  const contentResearchCompleteJson = () => completeForPurpose("contentResearch");
  /* The Person Profiles product area's Workspace-owned interface. The store is
     the same one Meeting Brief's resolver writes through: both are synchronous,
     uncached writers of the one Workspace directory. */
  /* Owner onboarding (issue #123): the connected Google identity is read once
     and held until the connection changes (ADR-0036), and owner-identity-
     dependent outward workflows get it only while a confirmed owner Profile
     reference stands — otherwise the typed owner-missing state. */
  const refreshOwnerIdentity = async (): Promise<void> => {
    await ownerOnboarding.refreshConnectedIdentity(() => googleConnection.state());
  };
  const brandProfiles = new WorkspaceBrandProfileStore(workspaceDir);
  const contentResearch = new ContentResearchHost({
    runs,
    workspaceDir,
    store: contentResearchStore,
    /* Watches resolve and pin their Profile through the public-safe projection
       seam (spec #134): publications and public surfaces only. */
    profileProjection: (profileId) => peopleProfiles.project("public-safe", profileId),
    adapters: contentResearchProductionAdapters({
      workspaceDir,
      renderBrowser: playwrightBrowserRenderer(),
      getYouTubeAccess: () => {
        const access = googleConnection.auth();
        return access.ok
          ? { ok: true, client: youtubeSourceClient(access.auth) }
          : { ok: false, state: access.state };
      },
    }),
    hookExtractor: { extract: createHookExtractor(contentResearchCompleteJson) },
    searchPublic: publicSearch,
    discoverer: {
      discover: async (input) => {
        const shape = await createPeopleDiscoverer(contentResearchCompleteJson)(input);
        return shape.candidates.map((candidate) => ({
          ...candidate,
          relationshipToBrand: candidate.relationshipToBrand ?? "unspecified",
          source: "llm-public-search",
        }));
      },
    },
    sheetsFactory: () => {
      const access = googleConnection.auth();
      if (!access.ok) return { ok: false, state: access.state };
      const auth = buildGoogleAuth(configStore.get(), port);
      return {
        ok: true,
        client: {
          createSpreadsheet: (title: string) => createSpreadsheet(auth, title),
          ensureTab: (spreadsheetId: string, title: string, header: string[]) =>
            ensureTab(auth, spreadsheetId, title, header),
          appendRows: (spreadsheetId: string, tab: string, rows: (string | number)[][]) =>
            appendRows(auth, spreadsheetId, tab, rows),
          readRows: (spreadsheetId: string, tab: string) => readRows(auth, spreadsheetId, tab),
          updateRow: (
            spreadsheetId: string,
            tab: string,
            rowNumber: number,
            values: (string | number)[],
          ) => updateRow(auth, spreadsheetId, tab, rowNumber, values),
          isMissing: (error: unknown) => isSpreadsheetMissing(error),
        },
        spreadsheet: null,
      };
    },
    gmailFactory: () => {
      const access = googleConnection.auth();
      if (!access.ok) return { ok: false, state: access.state };
      const auth = buildGoogleAuth(configStore.get(), port);
      return {
        ok: true,
        client: {
          createDraft: (draft: { to: string; subject: string; body: string }) =>
            createGmailDraft(auth, draft),
        },
      };
    },
    getOwnerEmail: () => ownerOnboarding.outwardOwnerEmail(),
    getBrandProfile: () => brandProfiles.current(),
    configStore,
    log: (message) => console.log(`[content-research] ${message}`),
  });
  const meetingBriefCompleteJson = () => completeForPurpose("meetingBrief");
  const meetingBriefLog = (message: string) => console.log(`[meeting-brief] ${message}`);
  /* The Daily Briefing's canonical work (issue #192). The Tasks product hands
     the Meeting Wizard a bounded projection rather than its stores: the
     Briefing shows overdue, due-today and high-priority Tasks beside the
     Action Items still awaiting review, and owns none of them. */
  const getBriefingWork = () => buildDailyBriefingWork({ tasks, actionItems });
  /* The standing Transcript ↔ Meeting join (issue #165). One deep module
     owns match-plus-attach-plus-merge; the Catalog owns the Transcript
     record and its Debrief/identity processing, the Meetings store owns the
     transcript-owned shell. transcriptCatalogRuntime is composed below —
     the closures read it only once a reconcile runs, never during
     composition. */
  const meetingJoin = new WorkspaceMeetingJoin({
    meetings,
    listTranscripts: () => transcriptCatalogStore.listTranscripts(),
    attachMeeting: (transcriptId, matched) =>
      transcriptCatalogRuntime.catalog.attachMeeting(transcriptId, matched),
    /* Naming a transcript-owned Meeting: deterministic first, and the model
       only for names the file name and the transcript's own heading leave
       file-shaped. */
    title: { getCompleteJson: meetingBriefCompleteJson, log: meetingBriefLog },
    log: meetingBriefLog,
  });
  const associateTranscripts = async (): Promise<void> => {
    await meetingJoin.associateTranscripts();
  };
  const meetingBriefTest =
    process.env.ENABLE_TEST_SEED === "1"
      ? createMeetingBriefTestRuntime({
          runs,
          workspaceDir,
          configStore,
          initialNow: new Date("2026-08-28T10:00:00.000Z"),
          personProfiles: peopleProfiles,
          oldestTranscriptAt: () => transcriptCatalogStore.oldestRecordedDate(),
          associateTranscripts,
          getBriefingWork,
        })
      : null;
  const meetingBriefProduction = meetingBriefTest
    ? null
    : createMeetingBriefProductionRuntime({
        runs,
        workspaceDir,
        configStore,
        google: googleConnection,
        getCompleteJson: meetingBriefCompleteJson,
        /* Owner onboarding (issue #123): delivery's outward send waits for the
   confirmed owner reference; eligibility keeps the raw identity. */
        isOwnerProfileConfirmed: () => ownerOnboarding.confirmed() !== null,
        personProfiles: peopleProfiles,
        /* An attendee met for the first time is enriched from the public web
   before the Brief pins its revision, so a Calendar shell is not the
   whole of what the Brief knows about a new person. */
        resolveNewAttendee: (email) => peopleResolver.resolve(parsePersonIdentifier(email)),
        /* Confirmed transcript evidence (issue #138): the Brief reads the
   Catalog's confirmed links and its reviewed relevance decisions. */
        /* Meeting history (issue #152): the backward read reaches as far as
   the oldest Transcript. */
        oldestTranscriptAt: () => transcriptCatalogStore.oldestRecordedDate(),
        associateTranscripts,
        transcriptRelevance,
        getBriefingWork,
        log: meetingBriefLog,
      });
  const meetingBrief: MeetingBriefHost = meetingBriefTest?.host ?? meetingBriefProduction!.host;
  /* The canonical This week view (issue #194). Reads the Meetings store, the
     Tasks product and the Runs index; owns none of them. The model seam is the
     configured one, resolved per call so a provider change in Settings needs
     no restart. */
  const weeklyWorkspace = new WeeklyWorkspace({
    workspaceDir,
    meetings,
    tasks,
    actionItems,
    sources: weeklyMeetingSources({
      meetings,
      runs,
      meetingIdForTranscript: (transcriptId) =>
        transcriptCatalogStore.readTranscript(transcriptId)?.meetingId ?? null,
    }),
    now: () => new Date(),
    timezone: () =>
      configStore.getModuleConfig("content-research").timeZone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    model: () => {
      const current = configStore.getForPurpose("meetingBrief");
      return {
        provider: current.provider,
        model: current.model,
        complete: meetingBriefCompleteJson(),
      };
    },
    /* The Monday owner email (issue #197). The delivery adapter resolves its
       own recipient from the authenticated Gmail account, so the message can
       only ever reach the owner; a Workspace with no Gmail delivery composed
       has the tab and nothing else. */
    ...(meetingBriefProduction
      ? {
          email: {
            deliver: meetingBriefProduction.gmailDelivery,
            enabled: () => true,
            ownerConfirmed: () => ownerOnboarding.confirmed() !== null,
          },
        }
      : {}),
    log: meetingBriefLog,
  });
  /* Debrief action-item mutations mark the derived briefings stale (#162):
     the thin shell seam beside the associateTranscripts wiring above — done /
     dismissed items touch day/week staleness instead of rebuilding at once. */
  const notifyBriefActionItemsChanged = (): void => {
    meetingBrief.notifyActionItemsChanged();
  };
  /* Meeting Debrief (issue #139): the retrospective sibling of Meeting Brief.
     It consumes the Transcript Catalog's immutable records and identity review
     state, and has no outward-write capability at all. The test runtime keeps
     everything real except the extraction, so the browser journey never
     depends on a live model. */
  const meetingDebriefTest =
    process.env.ENABLE_TEST_SEED === "1"
      ? createMeetingDebriefTestRuntime({
          runs,
          workspaceDir,
          identity: transcriptIdentityService,
          ownerEmail: () => ownerOnboarding.outwardOwnerEmail(),
          materializeActionItems: (handover) => materializeActionItemsUnderPolicy(handover),
          log: (message) => console.log(`[meeting-debrief] ${message}`),
        })
      : null;
  const meetingDebrief: MeetingDebriefHost =
    meetingDebriefTest?.host ??
    createMeetingDebriefProductionRuntime({
      runs,
      workspaceDir,
      people: peopleProfiles,
      identity: transcriptIdentityService,
      ownerEmail: () => ownerOnboarding.outwardOwnerEmail(),
      /* Terminal approval's outward writes (issue #141): one Gmail draft to the
         confirmed recipients, then Tasks for the owner's own retained actions. */
      google: googleConnection,
      /* A Debrief is named after its Meeting, not after the Drive file. */
      meetingTitle: (meetingId: string) => meetings.get(meetingId)?.title ?? null,
      getCompleteJson: () => completeForPurpose("meetingDebrief"),
      getLlmInfo: () => {
        const current = configStore.getForPurpose("meetingDebrief");
        return { provider: current.provider, model: current.model };
      },
      /* Issue #177: a successful extraction's proposals become durable
         Workspace Action Items. The Debrief produces them; Tasks owns them.
         Issue #181: the Action Item Policy then decides whether any of them
         are obvious enough to become Tasks without review. */
      materializeActionItems: (handover) => materializeActionItemsUnderPolicy(handover),
      log: (message) => console.log(`[meeting-debrief] ${message}`),
    }).host;

  /* The Transcript Catalog's production composition (issue #142, completing the
     #126 hand-forward). Until this existed only the Catalog's store was wired,
     so Transcript → Tasks was still the Workspace's only reader of the
     transcript folder. This is the sole private transcript intake writer that
     replaces it: one Drive client, one folder read, one checkpoint, and the
     Meeting Debrief hand-off on every newly mined Transcript. */
  const transcriptCatalogRuntime = createTranscriptCatalogRuntime({
    workspaceDir,
    port,
    google: googleConnection,
    identity: transcriptIdentityService,
    people: peopleProfiles,
    getConfig: () => configStore.get(),
    getLlmInfo: () => {
      const current = configStore.getForPurpose("meetingDebrief");
      return { provider: current.provider, model: current.model };
    },
    debrief: meetingDebrief,
    log: (message) => console.log(`[transcript-catalog] ${message}`),
  });
  /* The Shell's whole knowledge of what it hosts. Order is arbitrary: what a
     person sees is the web app's Module list, not this one. */
  const modules: HostedModule[] = [
    youtube,
    contentScout,
    contentResearch,
    meetingBrief,
    meetingDebrief,
  ];
  const app = fastify({ logger: false });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    reply.code(error.statusCode ?? 500).send({ error: error.message });
  });

  /* Mounted before the route registrations, so the hold reaches every /api
     route Fastify declares afterwards. */
  registerMigrationGate(app, migrationGate);
  registerMigrationRoutes(app, {
    workspaceDir,
    taskCutover,
    gate: migrationGate,
    configStore,
    googleConnection,
    ownerOnboarding,
    brandProfiles,
  });

  /* The repeatable generated-data clear (Settings' danger zone): deletes the
     generated Workspace state the migration's tables name, empties the two
     app-written Sheets, and leaves every configuration key and credential in
     place. Mounted behind the migration gate's hold like every other route:
     a pre-cutover Workspace holds no generated data of this shape to clear. */
  const drainModules = async (): Promise<void> => {
    await personProfilesProduct.drain();
    await transcriptCatalogRuntime.drain();
    if (meetingBriefProduction) {
      await meetingBriefProduction.relayPoller.drain();
    }
    await Promise.all(modules.map((module) => module.idle?.() ?? Promise.resolve()));
  };
  registerClearDataApi(app, {
    workspaceDir,
    configStore,
    google: googleConnection,
    contentResearch: contentResearchStore,
    modulesRunning: () => modulesRunning,
    stopModules,
    startModules,
    drain: drainModules,
  });

  /* One level deeper than main.ts was: apps/server/dist/composition → apps/web/dist. */
  const webDist = fileURLToPath(new URL("../../../web/dist", import.meta.url));
  await registerStaticServing(app, { webDist });

  /* The mock provider is a posture of the process, decided once here: tests
     (the seed seam) and an explicit demo run get it, a production boot does
     not (issue #198). */
  const mockProviderAvailable =
    process.env.ENABLE_TEST_SEED === "1" || process.env.DEMO_MODE === "1";
  if (meetingDebriefTest) {
    registerMeetingDebriefTestRoutes(app, meetingDebriefTest);
  }
  registerPersonDossierApi(app, {
    people: peopleProfiles,
    dossiers: personDossiers,
    queue: personResearchQueue,
    history: (profileId) => {
      const person = peopleProfiles.get(profileId);
      if (!person) return [];
      const records: PersonRelationshipRecord[] = meetings
        .list()
        .filter((meeting) =>
          meeting.participants.some((p) => person.emails.includes(p.email.toLowerCase())),
        )
        .map((meeting) => ({
          kind: "meeting",
          id: meeting.id,
          title: meeting.title,
          date: meeting.startAt,
          href: `/meetings/${encodeURIComponent(meeting.id)}`,
          detail: "Calendar participant with an exact matching email.",
        }));
      for (const mention of transcriptIdentityService.confirmedMentions(profileId)) {
        const transcript = transcriptCatalogStore.readTranscript(mention.transcriptId);
        if (transcript)
          records.push({
            kind: "transcript",
            id: mention.mentionId,
            title: transcript.source.fileName,
            date: transcript.meetingDate,
            href: transcript.meetingId
              ? `/meetings/${encodeURIComponent(transcript.meetingId)}`
              : "/people/review",
            detail: mention.quote,
          });
      }
      for (const task of tasks.list())
        if (
          task.responsiblePerson?.kind === "person-profile" &&
          task.responsiblePerson.profileId === profileId
        )
          records.push({
            kind: "task",
            id: task.id,
            title: task.title,
            date: task.dueDate,
            href: "/tasks",
            detail: task.status,
          });
      for (const item of actionItems.list())
        if (
          item.proposal.responsiblePerson?.kind === "person-profile" &&
          item.proposal.responsiblePerson.profileId === profileId
        )
          records.push({
            kind: "action-item",
            id: item.id,
            title: item.proposal.title,
            date: item.proposal.dueDate,
            href: "/tasks",
            detail: item.state,
          });
      return records;
    },
  });
  await registerApi(app, {
    runs,
    port,
    configStore,
    mockProviderAvailable,
    modules,
    google: googleConnection,
    people: peopleProfiles,
    peopleResolver,
    personResearchQueue,
    meetings,
    meetingJoin,
    onboarding: ownerOnboarding,
    contentProjects,
    tasks,
    actionItems,
    taskLinking,
    asanaLinking,
    onConfigChanged: async () => {
      meetingBriefProduction?.invalidateGoogleIdentity();
      await meetingBriefProduction?.refreshOwnerIdentity().catch(() => null);
      await refreshOwnerIdentity();
      for (const module of modules.filter((candidate) => candidate !== meetingBrief)) {
        module.start?.();
      }
      transcriptCatalogRuntime.stop();
      transcriptCatalogRuntime.start();
      meetingBrief.start();
    },
  });
  /* Meeting Wizard — This week (issues #194, #195, #196). Its own runtime and
     its own routes: the deterministic week is derived from the Meetings store
     and the Tasks product, and the Weekly Summary is generated only from
     bounded projections of the latest successful Briefs and Debriefs. */
  weeklyWorkspace.registerRoutes(app);

  /* The Transcript Catalog's intake surface (issue #142): consent, the
     pre-consent inventory, remembered status, and one pass on demand. */
  registerTranscriptIntakeApi(app, {
    catalog: transcriptCatalogRuntime.catalog,
    intakeStatus: () => transcriptCatalogRuntime.intakeStatus(),
  });
  /* Semantic transcript relevance Review surface (issue #127). */
  registerTranscriptRelevanceApi(app, {
    relevance: transcriptRelevance,
    /* Late transcript evidence (issue #138): a confirmed suggestion marks every
       Brief composed without it as regenerable, and sends nothing. */
    onRelevanceConfirmed: (transcriptId) =>
      meetingBrief.noteConfirmedTranscriptEvidence(transcriptId),
  });
  /* Transcript deletion surface (issue #128): corpus listing, cascade
     deletion, tombstones, and restore-processing-permission. */
  registerTranscriptDeletionApi(app, {
    catalog: transcriptCatalogStore,
    deletion: transcriptDeletion,
  });
  registerRelayRoutes(app, {
    workspaceDir,
    processWakeUps: (messages) => meetingBrief.handleRelayWakeUp(messages).then(() => undefined),
    onInstalled: async () => {
      await meetingBrief.ensureCalendarWatch();
      await meetingBrief.reconcileCalendar();
    },
  });
  registerMeetingBriefHubSpotRoutes(app, {
    configStore,
    connection: meetingBriefTest?.hubSpotConnection ?? meetingBriefProduction!.hubSpotConnection,
  });

  if (meetingBriefTest) {
    registerMeetingBriefTestRoutes(app, meetingBriefTest);
  }

  if (process.env.ENABLE_TEST_SEED === "1") {
    await registerTestSeed(app, {
      workspaceDir,
      /* Fixture Runs for the browser suite, built on the Shell's own Run store
         (issue #142). Transcript → Tasks used to be the vehicle; it is retired,
         and what these journeys actually cover — the Runs list, Run detail and
         the conversion-failure guidance — belongs to the Shell and to the
         neutral text conversion that survives the retirement. */
      seedFixtureRun: async (spec) => {
        const run = runs.create({
          module: SEED_FIXTURE_MODULE_ID,
          moduleVersion: 1,
          intake: "drive",
          fileName: spec.fileName,
          sourceUrl: null,
          externalId: null,
        });
        run.started("convert");
        const bytes = spec.bytes ?? Buffer.alloc(0);
        try {
          const text = await convertToText(spec.fileName, bytes);
          run.writeArtifact("transcript.txt", text);
          run.finished({ status: "done", summary: "Converted" });
        } catch (error) {
          /* The real conversion diagnostic, from the same neutral helper the
             retired Module used — so the journey's assertions still describe
             what the product does, not a string typed here. */
          const failure = conversionStageFailure(error, spec.fileName, bytes);
          run.failed("convert", failure.message, failure.hint, failure.flags);
        }
        return run.id;
      },
      createFailedRun: () => {
        const run = runs.create({
          module: SEED_FIXTURE_MODULE_ID,
          moduleVersion: 1,
          intake: "drive",
          fileName: "retryable-failure.md",
          sourceUrl: null,
          externalId: null,
        });
        run.started("extract");
        run.failed("extract", "fixture_failure", "The extraction failed. Retry the Run.");
        return run.id;
      },
      personStore: peopleStore,
      ownerOnboarding,
      runs,
      migration: {
        gate: migrationGate,
        /* The reset deletes the parked hermetic clock as disposable product
           configuration; disarm re-parks it so every later e2e spec on this
           serial server inherits the same silent schedule start-server wrote. */
        restoreHermeticDefaults: () => {
          const scout = configStore.getModuleConfig("content-scout");
          configStore.setModuleConfig("content-scout", {
            ...scout,
            dailyTime: "23:59",
            weeklyDiscoveryDay: 7,
            weeklyDiscoveryTime: "23:59",
          });
        },
        /* Arm quiesces the runtime before it returns (issue #144): the same
           drain the generated-data clear waits on. */
        drainModules,
      },
      ...(meetingBriefTest
        ? { upsertMeetingBriefEvent: (event) => meetingBriefTest.upsertEvent(event) }
        : {}),
    });
  }

  /* The boot-time startup sequence, named so the migration gate's in-process
     cutover performs exactly it (gate.complete) — and so the boot path can skip
     it while the gate holds the Workspace pre-cutover. */
  async function startModules(options: { seedV1Watchlist?: boolean } = {}): Promise<void> {
    /* Both writes the gate withholds, and both idempotent, so the boot path and
       the in-process cutover reach the same Workspace: a cutover confirmed in
       this process must leave what a restart after the same cutover would, not a
       Workspace missing its runs directory until the next Run and its V1
       watchlist until the next restart. The seed no-ops once anyone is watched,
       and reads the reset's empty state from disk rather than a stale cache. */
    mkdirSync(layout.runsDir, { recursive: true });
    /* The V1 seed is the boot path's starting watchlist; the generated-data
       clear resumes with seedV1Watchlist: false — a cleared Workspace holds no
       data, not demo data. */
    if (options.seedV1Watchlist !== false) {
      seedContentResearchV1(contentResearch, peopleProfiles);
    }
    /* A fresh Workspace adopts the relay address the deployment declares, so the
       bundled relay is reachable before anyone opens Settings. A stored address
       wins, so this never overrides an operator's own choice (issue #109). It
       belongs here for the same reason as the two above: docker-compose declares
       RELAY_BASE_URL, so at the top level this wrote relay.json into a Workspace
       the gate was still holding — and left the address unseeded after a reset
       deleted it, until the next restart. */
    seedRelayBaseUrlFromEnv(workspaceDir, process.env.RELAY_BASE_URL);

    /* The workspace owner has to be known before the first Run, not discovered by
       one: eligibility drops the owner-declined rule when it is null (ADR-0034), so
       a Run that raced the lookup would silently brief a declined meeting. Google
       being unreachable leaves it null and is not fatal — deliver then fails
       retryably rather than sending to nobody. */
    await meetingBriefProduction?.refreshOwnerIdentity().catch((error: unknown) => {
      console.log(
        `[meeting-brief] owner identity unavailable at boot: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });

    /* Same rule for owner onboarding and the workflows gated behind it: the
       identity is held before the first Run, and Google being unreachable at
       boot is not fatal — it preserves the last determinate owner identity. */
    await refreshOwnerIdentity();
    for (const module of modules) {
      module.start?.();
    }
    transcriptCatalogRuntime.start();
    meetingBriefProduction?.relayPoller.start();
    personProfilesProduct.start();
    taskProduct.start();
    weeklyWorkspace.start();
    modulesRunning = true;
  }

  return {
    app,
    config,
    gate: migrationGate,
    modules,
    workspace: {
      config: configStore,
      runs,
      people: peopleStore,
      profiles: peopleProfiles,
      onboarding: ownerOnboarding,
      brandProfiles,
      contentProjects,
      tasks,
      actionItems,
      taskLinking,
      weeklyWorkspace,
      transcripts: transcriptCatalogStore,
      transcriptIdentity: transcriptIdentityStore,
      transcriptIdentityService,
      transcriptRelevance,
      transcriptDeletion,
      transcriptCatalog: transcriptCatalogRuntime,
    },
    start: startModules,
    stop: stopModules,
  };
}
