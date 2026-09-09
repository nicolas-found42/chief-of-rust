/* oxlint-disable typescript/no-unnecessary-condition -- host bridges optional Module deps and ConfigStore that may be absent in tests */
import type { FastifyInstance } from "fastify";
import {
  MEETING_BRIEF_INTAKE,
  MEETING_BRIEF_MODULE_ID,
  type RunMeta,
  MEETING_BRIEF_MODULE_VERSION,
  type MeetingBriefEvent,
  type DailyBriefingState,
  type DailyBriefingWork,
  type WeeklyBriefingState,
  type MeetingBriefPersonProfileReadModel,
  type MeetingBriefProviderOutcomes,
  MEETING_BRIEF_PROVIDER_OUTCOMES_VERSION,
  type MeetingBriefRunResult,
  type MeetingBriefIndex,
  type MeetingBriefIndexEntry,
  type MeetingBriefUpcoming,
  meetingBriefOccurrenceIdentity,
  normalizeInternalDomains,
  parseMeetingBriefOccurrenceKey,
  type ModuleConfigs,
} from "@chief-of-staff-demo/shared";
import type { MeetingBriefBundleProvider } from "./bundles.js";
import { MEETING_BRIEF_BUNDLE_PROVIDERS } from "./bundles.js";
import type { HostedModule } from "../../engine/host.js";
import { Runner, RunNotRetryableError } from "../../engine/runner.js";
import type { Runs } from "../../runs.js";
import { DurableClock, type DurableSchedule } from "../../engine/durableClock.js";
import { DateTime } from "luxon";
import { meetingBriefModule, type MeetingBriefInput } from "./module.js";
import { createMeetingBriefGenerator, type MeetingBriefGeneratorOptions } from "./generator.js";
import { HubSpotConnection } from "./hubspot/connection.js";
import type { HubSpotApi } from "./hubspot/client.js";
import type { MeetingBriefEnrichmentProviders } from "./enrichment/enrich.js";
import {
  MeetingBriefCalendarStore,
  type CalendarEvent,
  type CalendarProvider,
  type MeetingBriefCalendarState,
  FakeCalendarProvider,
} from "./calendar.js";
import {
  ensureCalendarWatch,
  MEETING_BRIEF_CALENDAR_ID,
  occurrenceKeyFor,
  prepareWeekSweep as prepareWeekSweepIntake,
  reconcileCalendar,
  sweepWindowFor,
} from "./intake.js";
import { collectMeetingHistory } from "./history.js";
import { materialFingerprint } from "./revision.js";
import { MeetingBriefingCoordinator } from "./briefingCoordinator.js";

import { type StoredSnapshot } from "./snapshot.js";
import type { ConfigStore } from "../../config.js";
import type { WorkspacePersonProfiles } from "../../person-profile/profiles.js";
import { WorkspaceMeetings } from "../../meetings/store.js";
import type { RunContext } from "../../engine/module.js";
import { executeDeliver } from "./deliver.js";
import type { GmailDeliveryProvider } from "./google/gmailDelivery.js";
/** The versioned explicit provider policy actions recorded in module config (#137). */
type MeetingBriefProviderPolicy = ModuleConfigs["meeting-brief-generator"]["providerPolicy"];

export interface MeetingBriefHostDeps {
  runs: Runs;
  workspaceDir: string;
  now?: () => Date;
  log?: (message: string) => void;
  enrich?: MeetingBriefGeneratorOptions["enrich"];
  completeBrief?: MeetingBriefGeneratorOptions["completeBrief"];
  getCompleteJson?: MeetingBriefGeneratorOptions["getCompleteJson"];
  gmailDeliveryProvider?: GmailDeliveryProvider | null;
  calendarProvider?: CalendarProvider;
  /**
   * What a Run does with Calendar. The provider above always drives Intake
   * reconciliation and watch renewal; this decides whether a Run sees it at all,
   * because most hosts want Calendar for Intake and nothing more.
   * - "snapshot": Calendar is authoritative. A failed read fails the snapshot
   *   Stage and a missing occurrence is an explicit skip. Delivery rechecks too,
   *   since a Run that holds the provider always rechecks before it sends.
   * - "recheck": the provider reaches delivery only; a failed snapshot read is
   *   best-effort and falls back to the Intake event.
   * Omitted, a Run never receives the provider.
   */
  calendarUse?: "snapshot" | "recheck";
  configStore?: ConfigStore;
  getInternalDomains?: () => string[];
  getOwnerEmail?: () => string | null;
  /**
   * The Tasks product's bounded projection of the day's work (issue #192).
   * Composed by the Shell, which owns both products; absent, the Daily
   * Briefing is meetings alone.
   */
  getBriefingWork?: () => DailyBriefingWork;
  /** IANA timezone the weekly sweep window is computed in (issue://157). Defaults to the host timezone. */
  getTimezone?: () => string | null;
  isOwnerProfileConfirmed?: () => boolean;
  enrichmentProviders?: MeetingBriefEnrichmentProviders;
  hubSpotConnection?: HubSpotConnection;
  personProfiles?: Pick<WorkspacePersonProfiles, "consumerState">;
  /**
   * The date Calendar history is collected back to — the oldest Transcript's
   * date (issue #152). Absent or null: no history collection.
   */
  oldestTranscriptAt?: () => string | null;
  /**
   * The standing pass that joins catalogued Transcripts to their Meetings
   * (issue #153). Composed by the Shell, which owns both seams. Absent: the
   * pass does not run.
   */
  associateTranscripts?: () => Promise<void> | void;
  /**
   * Single-email policy (issue #163). False: preparation composes the Brief
   * and keeps it in-app but never emails per-Brief automatically; the owner
   * sends explicitly (Run retry). Defaults true — the historical behavior —
   * so existing harnesses keep exercising the delivery machinery.
   */
  perBriefAutoSend?: boolean;
  /**
   * Daily/Weekly briefing emails (issue #163). True: the built Daily Briefing
   * emails the owner once per day and the Weekly once per week, both
   * owner-only through the Gmail delivery adapter. Defaults false.
   */
  briefingEmails?: boolean;
}
/**
 * The one place snapshot.json is turned into a value. Null means the Run has no
 * snapshot or the file will not parse; every caller reads that as "nothing known
 * about this Run" and falls back to the Run result.
 */
function parseSnapshot(raw: string | null | undefined): StoredSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSnapshot;
  } catch {
    return null;
  }
}

/** The one place provider-outcomes.json is turned into a value (#137). */
function parseProviderOutcomes(
  raw: string | null | undefined,
): MeetingBriefProviderOutcomes | null {
  /* Number-typed alias: the version check narrows an unvalidated JSON parse. */
  const LEDGER_VERSION_NUMBER: number = MEETING_BRIEF_PROVIDER_OUTCOMES_VERSION;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MeetingBriefProviderOutcomes;
    return parsed.version === LEDGER_VERSION_NUMBER && Array.isArray(parsed.outcomes)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * The material fingerprint a Run froze at snapshot time. Reading it back beats
 * rebuilding the frozen event and re-fingerprinting it: the stored value is what
 * the Run actually compared against, and it cannot drift from `materialSnapshot`'s
 * field list. Null when the snapshot is missing or predates the field, which the
 * callers read as "cannot prove this revision is immaterial" and let the Run proceed.
 */
function storedFingerprint(snapshot: StoredSnapshot | null): string | null {
  return typeof snapshot?.materialFingerprint === "string" ? snapshot.materialFingerprint : null;
}

function isMeetingBriefEvent(value: unknown): value is MeetingBriefEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.occurrenceId === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.startAt === "string"
  );
}

class MeetingBriefRegenerationConflict extends Error {
  readonly code = "meeting-brief-profile-refresh-not-required";

  constructor(runId: string) {
    super(`Meeting Brief has no stale Person Profile consumers: ${runId}`);
    this.name = "MeetingBriefRegenerationConflict";
  }
}

function toUpcoming(schedule: {
  key: string;
  dueAt: string;
  input: unknown;
}): MeetingBriefUpcoming | null {
  const input = schedule.input;
  if (!isMeetingBriefEvent(input)) return null;
  return {
    occurrenceKey: schedule.key,
    eventId: input.eventId,
    occurrenceId: input.occurrenceId,
    version: input.version,
    summary: input.summary,
    startAt: input.startAt,
    dueAt: schedule.dueAt,
  };
}

/**
 * Meeting Brief Generator host — Module-owned Intake schedule store (Workspace-backed)
 * + Module host integration (issue://82, ADR-0032) + Calendar reconciliation (issue://83, ADR-0031).
 *
 * - Seeded fixture event enters durable Intake schedule (DurableClock, file-backed).
 * - Wakes at due time via real Runner/Runs store/durable clock/Workspace, creates
 *   exactly one Run at due time with 4 Stages, completes via injected fakes.
 * - No future blocked Run.
 * - Intake reconciles Calendar current state (header-only wake-ups never mistaken for data) via injectable CalendarProvider.
 * - Primary Calendar push channel persistence: local state for channel identity/token/resource/expiration/syncToken, durable replace before expiration.
 * - Incremental sync after each relay wake-up, startup + invalid-sync recovery triggers bounded reconciliation, duplicate harmless.
 * - Surface renders upcoming (Intake schedules) and completed Run state via public host behavior (Cross-Run index derived on read).
 *
 * Production providers are supplied by the composition root; tests inject bounded fakes.
 */
export class MeetingBriefHost implements HostedModule {
  readonly id = MEETING_BRIEF_MODULE_ID;
  readonly version = MEETING_BRIEF_MODULE_VERSION;

  private readonly runner: Runner<MeetingBriefInput>;
  private readonly clock: DurableClock;
  private readonly calendarStore: MeetingBriefCalendarStore;
  private readonly calendarProvider: CalendarProvider;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private lastFullSyncAt: Date | null = null;
  /** Window start the Sunday sweep last covered — in-memory guard so the sweep runs once per week (issue://157). */
  private lastSweepWeek: string | null = null;
  private maintenanceInProgress = false;
  private historyCollectionInFlight = false;
  private associationInFlight = false;
  private readonly fullSyncIntervalMs = 6 * 60 * 60 * 1000;
  private readonly hubSpotConnection: HubSpotConnection | null;
  private readonly getHubSpotApi: (() => HubSpotApi | null) | null;
  private readonly profileRegenerations = new Map<string, Promise<string>>();
  private readonly meetings: WorkspaceMeetings;
  private readonly briefings: MeetingBriefingCoordinator;
  /** Explicit policy actions when no ConfigStore backs this host (tests). */
  private providerPolicyInMemory: MeetingBriefProviderPolicy = {};
  constructor(private readonly deps: MeetingBriefHostDeps) {
    this.now = deps.now ?? (() => new Date());
    this.clock = new DurableClock(deps.workspaceDir, this.now);
    this.calendarStore = new MeetingBriefCalendarStore(deps.workspaceDir);
    /* The Workspace's Meetings (ADR-0050). Constructed from the same directory
       rather than injected: the store holds nothing in memory, so the API's
       instance and this one are two readers of one file, never two caches. */
    this.meetings = new WorkspaceMeetings(deps.workspaceDir, this.now);
    this.briefings = new MeetingBriefingCoordinator({
      runs: deps.runs,
      meetings: this.meetings,
      now: this.now,
      getTimezone: () => this.getTimezone(),
      getInternalDomains: () => this.getInternalDomains(),
      getOwnerEmail: () => this.getOwnerEmail(),
      ...(deps.getBriefingWork ? { getBriefingWork: deps.getBriefingWork } : {}),
      ...(deps.isOwnerProfileConfirmed
        ? { isOwnerProfileConfirmed: deps.isOwnerProfileConfirmed }
        : {}),
      ...(deps.gmailDeliveryProvider ? { gmailDeliveryProvider: deps.gmailDeliveryProvider } : {}),
      briefingEmails: deps.briefingEmails ?? false,
      ...(deps.log ? { log: deps.log } : {}),
    });
    this.calendarProvider = deps.calendarProvider ?? new FakeCalendarProvider();
    // HubSpot wiring — per-user private-app token, Shell stores secret (issue://86)
    if (deps.hubSpotConnection) {
      this.hubSpotConnection = deps.hubSpotConnection;
    } else if (deps.configStore) {
      this.hubSpotConnection = new HubSpotConnection(deps.configStore);
    } else {
      this.hubSpotConnection = null;
    }
    if (deps.enrichmentProviders?.getHubSpotApi !== undefined) {
      this.getHubSpotApi = deps.enrichmentProviders.getHubSpotApi;
    } else if (this.hubSpotConnection) {
      const connection = this.hubSpotConnection;
      this.getHubSpotApi = () => connection.api();
    } else {
      this.getHubSpotApi = () => null;
    }
    const enrichmentProviders: MeetingBriefEnrichmentProviders = {
      ...deps.enrichmentProviders,
      getHubSpotApi: this.getHubSpotApi,
    };
    const module = meetingBriefModule({
      now: this.now,
      createBriefGenerator: (context) =>
        createMeetingBriefGenerator({
          context,
          now: this.now,
          ...(deps.enrich ? { enrich: deps.enrich } : {}),
          ...(deps.completeBrief ? { completeBrief: deps.completeBrief } : {}),
          ...(deps.getCompleteJson ? { getCompleteJson: deps.getCompleteJson } : {}),
          enrichmentProviders,
          getInternalDomains: () => this.getInternalDomains(),
          getDisabledProviders: () => this.getDisabledProviders(),
        }),
      ...(deps.gmailDeliveryProvider ? { gmailDeliveryProvider: deps.gmailDeliveryProvider } : {}),
      getOwnerEmail: () => this.getOwnerEmail(),
      ...(deps.getBriefingWork ? { getBriefingWork: deps.getBriefingWork } : {}),
      ...(deps.isOwnerProfileConfirmed
        ? { isOwnerProfileConfirmed: deps.isOwnerProfileConfirmed }
        : {}),
      ...(deps.calendarProvider && deps.calendarUse
        ? { calendarProvider: this.calendarProvider }
        : {}),
      ...(deps.calendarUse === "snapshot" ? { calendarSnapshotRequired: true } : {}),
      ...(deps.personProfiles
        ? {
            personProfileConsumerState: deps.personProfiles.consumerState.bind(deps.personProfiles),
          }
        : {}),
      isManualSend: (runId: string) => this.isManualSendAllowed(runId),
    });
    this.runner = new Runner({ runs: deps.runs, module, now: this.now, log: deps.log });
  }

  async retryRun(id: string): Promise<RunMeta> {
    const detail = this.deps.runs.detail(id);
    const requiresRegeneration = detail?.events.some(
      (event) =>
        event.type === "brief_delivery_blocked" &&
        event.detail?.reason === "person_profile_refresh_required",
    );
    if (requiresRegeneration) {
      this.deps.runs.open(id)?.appendEvent("retry_refused", {
        condition: "profile_refresh_requires_new_run",
      });
      return Promise.reject(
        new RunNotRetryableError(
          id,
          "module_declined",
          "Profile-derived claims require regeneration into a new immutable Brief",
        ),
      );
    }
    // Manual per-Brief send (issue #163): a completed Run whose Brief was
    // composed but never emailed sends on explicit retry without reopening
    // the Run — the retry itself is the owner's send intent. Anything else
    // keeps the historical failed-Run path below.
    const manual = await this.sendDeferredBriefEmail(id);
    if (manual) return manual;

    // Failed-Run path: record the owner's explicit intent so the deliver
    // Stage sends when the retried Run reaches it. Only when per-Brief
    // auto-send is off; otherwise the Stage sends unconditionally and the
    // timeline stays free of marker events.
    const meta = this.deps.runs.open(id)?.read();
    if (meta?.status === "failed" && (this.deps.perBriefAutoSend ?? true) === false) {
      this.deps.runs.open(id)?.appendEvent("brief_manual_send_requested", {
        at: this.now().toISOString(),
      });
    }
    return this.runner.retryRun(id);
  }

  idle(): Promise<void> {
    return this.runner.idle();
  }

  /**
   * Whether the deliver Stage may send for this Run (issue #163). With
   * per-Brief auto-send on (the default) it always may — the historical
   * behavior. With it off, only an explicit owner retry recorded on the
   * timeline may send; automatic continuations (recovery, quiet-period
   * resume) keep deferring.
   */
  private isManualSendAllowed(runId: string): boolean {
    if ((this.deps.perBriefAutoSend ?? true) === true) return true;
    return (
      this.deps.runs
        .detail(runId)
        ?.events.some((event) => event.type === "brief_manual_send_requested") ?? false
    );
  }

  /**
   * The explicit manual send (issue #163): a completed Run whose Brief was
   * composed but never emailed (delivery pending/failed after deferral)
   * sends here, in place, without reopening the Run. Null when there is
   * nothing sendable — the caller falls through to the historical retry
   * path. Send failures throw, after the delivery artifacts record them,
   * so a transient failure stays retryable through this same path.
   */
  private async sendDeferredBriefEmail(id: string): Promise<RunMeta | null> {
    const handle = this.deps.runs.open(id);
    const meta = handle?.read();
    if (!handle || !meta || meta.module !== MEETING_BRIEF_MODULE_ID || meta.status !== "done") {
      return null;
    }
    const result = this.deps.runs.detail(id)?.result as MeetingBriefRunResult | null | undefined;
    const brief = result?.meetingBrief ?? null;
    if (!brief) return null;
    if (result?.delivery?.status !== "pending" && result?.delivery?.status !== "failed") {
      return null;
    }
    const snapshotRaw = handle.readArtifact("snapshot.json");
    let snapshot: unknown;
    try {
      snapshot = snapshotRaw ? (JSON.parse(snapshotRaw) as unknown) : null;
    } catch {
      snapshot = null;
    }
    if (!isMeetingBriefEvent(snapshot)) return null;
    const occurrenceKey = result.occurrenceKey;
    const input: MeetingBriefInput = { ...snapshot, occurrenceKey };
    const ctx: RunContext = {
      runId: id,
      meta: () => handle.read(),
      stage: (_name, fn) => fn(),
      event: (type, detail) => {
        handle.appendEvent(type, detail);
      },
      attempt: () => 0,
      readFile: (name) => handle.readArtifact(name),
      writeFile: (name, text) => handle.writeArtifact(name, text),
      // An explicit manual send is the owner's "now": a revision quiet
      // period never delays it, so the wait is recorded and skipped.
      wait: ((request: { reason: string }) => {
        handle.appendEvent("brief_manual_send_wait_skipped", { reason: request.reason });
      }) as unknown as RunContext["wait"],
    };
    await executeDeliver({
      ctx,
      brief,
      input,
      occurrenceKey,
      now: this.now,
      ...(this.deps.calendarProvider && this.deps.calendarUse
        ? { calendarProvider: this.calendarProvider }
        : {}),
      ...(this.deps.gmailDeliveryProvider
        ? { gmailDeliveryProvider: this.deps.gmailDeliveryProvider }
        : {}),
      getOwnerEmail: () => this.getOwnerEmail(),
      ...(this.deps.isOwnerProfileConfirmed
        ? { isOwnerProfileConfirmed: this.deps.isOwnerProfileConfirmed }
        : {}),
      ...(this.deps.personProfiles
        ? {
            personProfileConsumerState: this.deps.personProfiles.consumerState.bind(
              this.deps.personProfiles,
            ),
          }
        : {}),
      manualSend: true,
    });
    return handle.read();
  }

  // -------------------------------------------------------------------------
  // Internal helpers — Internal Domains & owner email resolution (issue://83)
  // -------------------------------------------------------------------------

  /** Normalized Internal Domains (case-insensitive after email parsing). */
  getInternalDomains(): string[] {
    if (this.deps.getInternalDomains) {
      return normalizeInternalDomains(this.deps.getInternalDomains());
    }
    if (this.deps.configStore) {
      try {
        const fromConfig =
          this.deps.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID).internalDomains;
        return normalizeInternalDomains(fromConfig);
      } catch {
        // config not loaded yet
      }
    }
    return [];
  }

  getOwnerEmail(): string | null {
    if (this.deps.getOwnerEmail) return this.deps.getOwnerEmail();
    return null;
  }

  /** IANA timezone the weekly sweep window is computed in (issue://157). */
  getTimezone(): string {
    const configured = this.deps.getTimezone?.();
    if (configured) return configured;
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    } catch {
      return "UTC";
    }
  }

  /** Persist normalized Internal Domains via ConfigStore (issue://83). */
  setInternalDomains(domains: string[]): string[] {
    const normalized = normalizeInternalDomains(domains);
    if (this.deps.configStore) {
      const current = this.deps.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID);
      // Preserve other future fields (guest profile/hubspot) by merging
      const next = { ...current, internalDomains: normalized };
      this.deps.configStore.setModuleConfig(MEETING_BRIEF_MODULE_ID, next);
    }
    return normalized;
  }

  // -------------------------------------------------------------------------
  // Explicit provider policy actions (#137) — the only way a provider leaves
  // the required set; policy never relaxes silently.
  // -------------------------------------------------------------------------

  /** The recorded policy, preferring ConfigStore over the in-memory fallback. */
  getProviderPolicy(): MeetingBriefProviderPolicy {
    if (this.deps.configStore) {
      try {
        return this.deps.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID).providerPolicy;
      } catch {
        // config not loaded yet — the in-memory record still answers
      }
    }
    return this.providerPolicyInMemory;
  }

  /** Providers currently excluded from the required set by explicit action. */
  getDisabledProviders(): string[] {
    return Object.entries(this.getProviderPolicy())
      .filter(([, entry]) => entry.disabled)
      .map(([provider]) => provider);
  }

  /** Record one explicit disable/enable policy action. */
  setProviderPolicy(provider: MeetingBriefBundleProvider, disabled: boolean, reason: string): void {
    const entry = { disabled, changedAt: this.now().toISOString(), reason };
    if (this.deps.configStore) {
      try {
        const current = this.deps.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID);
        this.deps.configStore.setModuleConfig(MEETING_BRIEF_MODULE_ID, {
          ...current,
          providerPolicy: { ...current.providerPolicy, [provider]: entry },
        });
        return;
      } catch {
        // config not loaded yet — record in memory so the action is never lost
      }
    }
    this.providerPolicyInMemory = { ...this.providerPolicyInMemory, [provider]: entry };
  }

  // -------------------------------------------------------------------------
  // Durable Intake schedule API (occurrences + Calendar reconciliation)
  // -------------------------------------------------------------------------

  /** `parseSnapshot` for a Run this caller has no handle on. */
  private readSnapshot(runId: string): StoredSnapshot | null {
    return parseSnapshot(this.deps.runs.open(runId)?.readArtifact("snapshot.json"));
  }

  /** Durably schedule a meeting occurrence (Intake schedule, not a Run). */
  scheduleOccurrence(event: MeetingBriefEvent, dueAt: Date): void {
    const key = occurrenceKeyFor(event);
    this.clock.schedule({
      module: MEETING_BRIEF_MODULE_ID,
      key,
      dueAt: dueAt.toISOString(),
      input: event,
    });
  }

  /**
   * Late transcript evidence (issue #138, AC 5). The owner confirmed a
   * suggestion after a Brief was already composed from a corpus that did not
   * include it. Every Run that held that Transcript as a pending suggestion
   * gets a notice offering regeneration — and nothing else happens. No Run is
   * started and nothing is delivered here, because a Brief the owner did not
   * ask for is a surprise revision in their inbox. Returns the Runs noticed.
   */
  noteConfirmedTranscriptEvidence(transcriptId: string): string[] {
    const noticed: string[] = [];
    for (const summary of this.deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs) {
      const handle = this.deps.runs.open(summary.id);
      const raw = handle?.readArtifact("transcript-suggestions.json");
      if (!raw) continue;
      let suggestions: { transcriptId: string }[];
      try {
        suggestions =
          (JSON.parse(raw) as { suggestions?: { transcriptId: string }[] }).suggestions ?? [];
      } catch {
        continue;
      }
      if (!suggestions.some((item) => item.transcriptId === transcriptId)) continue;
      handle?.appendEvent("brief_evidence_confirmed_late", {
        transcriptId,
        action: "regenerate",
      });
      noticed.push(summary.id);
    }
    return noticed;
  }

  listUpcoming(): MeetingBriefUpcoming[] {
    return this.clock
      .list(MEETING_BRIEF_MODULE_ID)
      .map(toUpcoming)
      .filter((value): value is MeetingBriefUpcoming => value !== null)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  /** Cross-Run index derived on read (ADR-0005) — never a second copy. */
  index(): MeetingBriefIndex {
    const upcoming = this.listUpcoming();
    const briefs: MeetingBriefIndexEntry[] = [];
    const cancellations = new Map(
      this.calendarStore
        .load()
        .cancellations.map((cancellation) => [cancellation.occurrenceKey, cancellation]),
    );
    for (const summary of this.deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs) {
      const detail = this.deps.runs.detail(summary.id);
      if (!detail) continue;
      const result = detail.result as MeetingBriefRunResult | null;
      const handle = this.deps.runs.open(summary.id);
      const snapshot = parseSnapshot(handle?.readArtifact("snapshot.json"));
      const ledger = parseProviderOutcomes(handle?.readArtifact("provider-outcomes.json"));
      const meta = handle?.read();
      const externalKey = meta?.externalId ?? null;
      const occurrenceKey = result?.occurrenceKey ?? snapshot?.occurrenceKey ?? externalKey;
      if (!occurrenceKey) continue;
      const externalIdentity = externalKey ? parseMeetingBriefOccurrenceKey(externalKey) : null;
      const eventId =
        result?.eventId ?? snapshot?.eventId ?? externalIdentity?.eventId ?? "unknown";
      const occurrenceId =
        result?.occurrenceId ??
        snapshot?.occurrenceId ??
        externalIdentity?.occurrenceId ??
        "unknown";
      briefs.push({
        runId: detail.id,
        createdAt: detail.createdAt,
        status: detail.status,
        eventId,
        occurrenceId,
        occurrenceKey,
        eventVersion: result?.eventVersion ?? snapshot?.version ?? "unknown",
        meetingBrief: result?.meetingBrief ?? null,
        delivery: result?.delivery ?? null,
        supersedes: result?.supersedes ?? snapshot?.supersedesRunId ?? null,
        providerOutcomes: ledger?.outcomes ?? null,
      });
      if (
        result?.deliverySkippedReason === "cancelled" ||
        result?.deliverySkippedReason === "occurrence_not_found"
      ) {
        cancellations.set(result.occurrenceKey, {
          occurrenceKey: result.occurrenceKey,
          eventId: result.eventId,
          occurrenceId: result.occurrenceId,
          version: result.eventVersion,
          summary: result.meetingBrief.logistics.title,
          cancelledAt: detail.createdAt,
        });
      }
    }
    briefs.sort((a, b) => {
      if (a.supersedes === b.runId) return -1;
      if (b.supersedes === a.runId) return 1;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    return { upcoming, briefs, cancellations: [...cancellations.values()] };
  }

  // -------------------------------------------------------------------------
  // Calendar channel + sync persistence (issue://83)
  // -------------------------------------------------------------------------

  getCalendarState(): MeetingBriefCalendarState {
    return this.calendarStore.load();
  }

  /** Ensure the primary Calendar push channel exists and is not expiring soon (durable replace before expiration). */
  async ensureCalendarWatch(): Promise<void> {
    const args: Parameters<typeof ensureCalendarWatch>[0] = {
      provider: this.calendarProvider,
      store: this.calendarStore,
      now: this.now(),
      calendarId: MEETING_BRIEF_CALENDAR_ID,
    };
    if (this.deps.log) args.log = this.deps.log;
    await ensureCalendarWatch(args);
  }

  /**
   * Reconcile Calendar current state against Intake schedules.
   * Header-only wake-ups never mistaken for data — we fetch Calendar after each wake-up.
   * In-window meetings schedule for immediate preparation; beyond-window ones
   * wait for the sweep that covers them (issue://157).
   * Bounded reconciliation on invalid sync.
   */
  async reconcileCalendar(options: { forceFullSync?: boolean } = {}): Promise<{
    scheduled: number;
    removed: number;
    invalidSyncRecovered: boolean;
  }> {
    const args: Parameters<typeof reconcileCalendar>[0] = {
      provider: this.calendarProvider,
      store: this.calendarStore,
      clock: this.clock,
      ownerEmail: () => this.getOwnerEmail(),
      meetings: this.meetings,
      now: this.now(),
      timezone: this.getTimezone(),
      calendarId: MEETING_BRIEF_CALENDAR_ID,
      forceFullSync: options.forceFullSync ?? false,
    };
    // Change-sensitive staleness (issue #162): snapshot the Meetings the
    // briefings derive from plus the Intake schedule keys/versions before and
    // after. A no-op tick (same meetings, same schedules) touches nothing, so
    // the routine 6-hour full sync cannot keep the briefings permanently
    // stale; a new, revised, or cancelled meeting marks the day/week stale.
    const meetingsBefore = JSON.stringify(
      this.meetings
        .list()
        .map((meeting) => [
          meeting.id,
          meeting.startAt,
          meeting.endAt,
          meeting.title,
          meeting.occurrenceKey,
          meeting.cancelled,
        ])
        .sort(),
    );
    const schedulesBefore = JSON.stringify(
      this.clock
        .list(MEETING_BRIEF_MODULE_ID)
        .map((schedule) => [
          schedule.key,
          (schedule.input as { version?: unknown } | null)?.version ?? null,
        ])
        .sort(),
    );
    const result = await reconcileCalendar(args);
    const meetingsAfter = JSON.stringify(
      this.meetings
        .list()
        .map((meeting) => [
          meeting.id,
          meeting.startAt,
          meeting.endAt,
          meeting.title,
          meeting.occurrenceKey,
          meeting.cancelled,
        ])
        .sort(),
    );
    const schedulesAfter = JSON.stringify(
      this.clock
        .list(MEETING_BRIEF_MODULE_ID)
        .map((schedule) => [
          schedule.key,
          (schedule.input as { version?: unknown } | null)?.version ?? null,
        ])
        .sort(),
    );
    if (meetingsAfter !== meetingsBefore || schedulesAfter !== schedulesBefore) {
      this.briefings.markBriefingsStale(args.now, args.timezone ?? this.getTimezone());
    }
    // The one backward read (issue #152) and the standing Transcript ↔
    // Meeting join (issue #153) ride every reconcile: both are guarded, so a
    // completed history never reads again and matched transcripts stay put.
    await this.collectMeetingHistory();
    await this.associateTranscriptsPass();
    return result;
  }

  /**
   * The Sunday sweep (issue://157): enqueue Brief preparation for every
   * eligible Meeting in the coming week (Sunday 00:00 through Saturday end in
   * the owner's calendar timezone) that is missing a current Brief. Meetings
   * seen after the sweep but starting inside its window prepare immediately
   * through reconcile; beyond-window ones wait for their covering sweep.
   */
  async prepareWeekSweep(
    now = this.now(),
    timezone = this.getTimezone(),
  ): Promise<{ scheduled: number; windowStart: string; windowEnd: string }> {
    const args: Parameters<typeof prepareWeekSweepIntake>[0] = {
      provider: this.calendarProvider,
      store: this.calendarStore,
      clock: this.clock,
      ownerEmail: () => this.getOwnerEmail(),
      meetings: this.meetings,
      hasCurrentBrief: (occurrenceKey, event) => this.hasCurrentBrief(occurrenceKey, event),
      now,
      timezone,
      calendarId: MEETING_BRIEF_CALENDAR_ID,
    };
    if (this.deps.log) args.log = this.deps.log;
    return prepareWeekSweepIntake(args);
  }

  /**
   * True when a done Run already holds a Brief current for this event version.
   * Active or failed Runs are not current — the due path still decides those.
   */
  private hasCurrentBrief(occurrenceKey: string, event: CalendarEvent): boolean {
    for (const summary of this.deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs) {
      const meta = this.deps.runs.open(summary.id)?.read();
      if (meta?.externalId !== occurrenceKey || meta.status !== "done") continue;
      if (this.readSnapshot(summary.id)?.version === event.version) return true;
      const result = this.deps.runs.detail(summary.id)?.result as MeetingBriefRunResult | null;
      if (result?.eventVersion === event.version) return true;
    }
    return false;
  }

  /**
   * The standing Transcript ↔ Meeting join (issue #153). Rides every
   * reconcile so transcripts already in the Catalog are matched, not only
   * newly ingested ones. Never throws into the caller's reconcile path.
   */
  private async associateTranscriptsPass(): Promise<void> {
    if (!this.deps.associateTranscripts || this.associationInFlight) return;
    this.associationInFlight = true;
    try {
      await this.deps.associateTranscripts();
    } catch (error) {
      this.deps.log?.(
        `transcript association failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.associationInFlight = false;
    }
  }

  /**
   * The one backward read of Calendar (issue #152). Marker-guarded, so repeat
   * calls are cheap no-ops; a failed read writes no mark and retries on the
   * next reconcile. Never throws into the caller's reconcile path.
   */
  private async collectMeetingHistory(): Promise<void> {
    if (!this.deps.oldestTranscriptAt || this.historyCollectionInFlight) return;
    this.historyCollectionInFlight = true;
    try {
      await collectMeetingHistory({
        provider: this.calendarProvider,
        meetings: this.meetings,
        oldestTranscriptAt: this.deps.oldestTranscriptAt(),
        ownerEmail: () => this.getOwnerEmail(),
        now: this.now(),
        ...(this.deps.log ? { log: this.deps.log } : {}),
      });
    } catch (error) {
      this.deps.log?.(
        `meeting history collection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.historyCollectionInFlight = false;
    }
  }

  /**
   * Simulate a relay wake-up (header-only) — reconciles Calendar incremental sync.
   * Payload is ignored (never mistaken for data); we fetch current Calendar state.
   * Duplicate wake-ups are harmless (idempotent).
   */
  async handleRelayWakeUp(_messages?: unknown): Promise<{
    scheduled: number;
    removed: number;
    invalidSyncRecovered: boolean;
  }> {
    void _messages;
    // Ensure channel is still valid before incremental sync (durable replace before expiration)
    await this.ensureCalendarWatch().catch(() => {
      // best-effort; reconciliation still tries
    });
    return this.reconcileCalendar();
  }

  /**
   * Check durable Intake schedules whose dueAt <= now, create exactly one Run per
   * due occurrence using the real Runner/Runs, and remove the schedule.
   * Idempotent: duplicate wake-ups for the same version are no-ops (ADR-0033).
   * Material change detection (ADR-0033): ignored metadata never creates a revision.
   * Revision linking: material change after completed Run creates linked Run (supersedes).
   */
  async processDueSchedules(now = this.now()): Promise<string[]> {
    const due = this.clock.due(now);
    const created: string[] = [];
    for (const record of due) {
      if (record.module !== MEETING_BRIEF_MODULE_ID) continue;
      const runId = await this.startBriefForSchedule(record);
      if (runId) created.push(runId);
    }
    // A new or revised Brief Run moves its meeting's briefStatus — the
    // day/week briefings covering it go stale (issue #162), one quiet rebuild
    // no matter how many Runs start in the burst.
    if (created.length > 0) this.briefings.markBriefingsStale(now, this.getTimezone());
    return created;
  }

  /**
   * Turn one durable schedule into a Run, applying the supersession and
   * fingerprint rules that decide whether this occurrence still deserves one.
   * Returns the Run id, or null when the schedule was spent without a Run.
   */
  private async startBriefForSchedule(record: DurableSchedule): Promise<string | null> {
    const key = record.key;
    const input = record.input;
    if (!isMeetingBriefEvent(input)) {
      this.clock.remove(record.module, key);
      return null;
    }
    const related = this.deps.runs
      .list({ module: MEETING_BRIEF_MODULE_ID })
      .runs.map((r) => {
        const handle = this.deps.runs.open(r.id);
        const meta = handle?.read();
        const detail = this.deps.runs.detail(r.id);
        const result = detail?.result as MeetingBriefRunResult | null;
        return { id: r.id, meta, detail, result };
      })
      .filter((r) => r.meta?.externalId === key);
    const activeRuns = related.filter(
      (r) => r.meta && ["pending", "running", "blocked"].includes(r.meta.status),
    );
    if (activeRuns.length > 0) {
      const sameVersionActive = activeRuns.some((r) => {
        const snap = this.readSnapshot(r.id);
        if (snap) return snap.version === input.version;
        return r.result?.eventVersion === input.version;
      });
      if (sameVersionActive) {
        this.clock.remove(record.module, key);
        return null;
      }
      const hasNonQuietActive = activeRuns.some(
        (r) => !(r.meta?.status === "blocked" && r.meta.wait?.reason === "quiet_period"),
      );
      if (hasNonQuietActive) {
        // Defer revision while prior Run is still enriching/composing/delivering (non-quiet)
        return null;
      }
      // All active are quiet_period waits — allow new revision to supersede and reset quiet period
    }

    const duplicateVersion = related.some((r) => {
      const snap = this.readSnapshot(r.id);
      if (snap?.version === input.version) return true;
      return r.result?.eventVersion === input.version;
    });
    if (duplicateVersion) {
      this.clock.remove(record.module, key);
      return null;
    }

    const doneRuns = related.filter((r) => r.meta?.status === "done" && r.result);
    let latestDone: (typeof doneRuns)[number] | null = null;
    for (const r of doneRuns) {
      if (
        !latestDone ||
        (r.meta &&
          latestDone.meta &&
          Date.parse(r.meta.createdAt) > Date.parse(latestDone.meta.createdAt))
      ) {
        latestDone = r;
      }
    }
    if (latestDone && latestDone.result) {
      const prevFingerprint = storedFingerprint(this.readSnapshot(latestDone.id));
      if (prevFingerprint) {
        const curFingerprint = materialFingerprint(input);
        if (prevFingerprint === curFingerprint) {
          this.clock.remove(record.module, key);
          return null;
        }
      }
    }

    // Ignored-metadata dedup against newest blocked/active snapshot (quiet period)
    {
      let newestActive: (typeof related)[number] | null = null;
      for (const r of related) {
        if (r.meta && ["pending", "running", "blocked"].includes(r.meta.status)) {
          if (
            !newestActive ||
            (r.meta &&
              newestActive.meta &&
              Date.parse(r.meta.createdAt) > Date.parse(newestActive.meta.createdAt))
          ) {
            newestActive = r;
          }
        }
      }
      if (newestActive) {
        const activeFingerprint = storedFingerprint(this.readSnapshot(newestActive.id));
        if (activeFingerprint) {
          const curFingerprint = materialFingerprint(input);
          if (activeFingerprint === curFingerprint) {
            this.clock.remove(record.module, key);
            return null;
          }
        }
      }
    }

    // Quiet-period supersession: if a prior revision is blocked on quiet wait, supersede it directly
    const quietBlocked = related.filter(
      (r) => r.meta?.status === "blocked" && r.meta.wait?.reason === "quiet_period",
    );
    let supersedesRunId: string | null;
    if (quietBlocked.length > 0) {
      let latestQuiet = quietBlocked[0]!;
      for (const r of quietBlocked) {
        if (Date.parse(r.meta!.createdAt) > Date.parse(latestQuiet.meta!.createdAt))
          latestQuiet = r;
      }
      supersedesRunId = latestQuiet.id;
    } else {
      supersedesRunId = latestDone?.id ?? null;
    }
    const runInput: MeetingBriefInput = {
      ...input,
      occurrenceKey: key,
      ...(supersedesRunId ? { supersedesRunId } : {}),
    };
    const runId = await this.runner.startRun(
      {
        intake: MEETING_BRIEF_INTAKE,
        sourceUrl: null,
        externalId: key,
      },
      runInput,
    );
    this.clock.remove(record.module, key);
    return runId;
  }

  /**
   * Prepare a scheduled occurrence now rather than at its due time — the
   * Module's manual Run. It takes the same path a due schedule does, so
   * supersession, versioning and dedup behave identically.
   */
  async prepareNow(occurrenceKey: string): Promise<string | null> {
    const record = this.clock
      .list(MEETING_BRIEF_MODULE_ID)
      .find((schedule) => schedule.key === occurrenceKey);
    if (!record) throw new Error(`Meeting occurrence is not scheduled: ${occurrenceKey}`);
    const runId = await this.startBriefForSchedule(record);
    // A manually prepared Brief moves briefStatus the same way a due one does.
    if (runId) this.briefings.markBriefingsStale(this.now(), this.getTimezone());
    return runId;
  }

  /**
   * Explicitly regenerate a stale immutable Brief in a new Run. The old Run is
   * never reopened or rewritten: its frozen event remains the input receipt,
   * while enrichment and composition execute again against current Profile truth.
   */
  async regenerateRun(runId: string): Promise<string> {
    const active = this.profileRegenerations.get(runId);
    if (active) return active;

    const existing = this.deps.runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs.find((run) => {
      const result = this.deps.runs.detail(run.id)?.result as
        MeetingBriefRunResult | null | undefined;
      return result?.profileRefreshOf === runId;
    });
    if (existing) {
      const resolved = Promise.resolve(existing.id);
      this.profileRegenerations.set(runId, resolved);
      return resolved;
    }

    const handle = this.deps.runs.open(runId);
    const meta = handle?.read();
    const detail = this.deps.runs.detail(runId);
    if (!handle || meta?.module !== MEETING_BRIEF_MODULE_ID || !detail?.result)
      throw new Error(`Meeting Brief Run not found: ${runId}`);
    const snapshotRaw = handle.readArtifact("snapshot.json");
    if (!snapshotRaw)
      throw new Error(`Meeting Brief cannot be regenerated without its snapshot: ${runId}`);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(snapshotRaw);
    } catch {
      throw new Error(`Meeting Brief snapshot is not readable: ${runId}`);
    }
    if (!isMeetingBriefEvent(snapshot))
      throw new Error(`Meeting Brief snapshot is incomplete: ${runId}`);
    const result = detail.result as MeetingBriefRunResult;
    const hasStaleConsumer = this.profileReadModel(result).consumers.some(
      ({ state }) => state?.refreshRequired === true,
    );
    /* Late transcript evidence is the second thing that can make an immutable
       Brief stale (issue #138, AC 6): the owner confirmed a suggestion the
       composed Brief could not cite. Like a stale Profile it only ever
       *offers* regeneration — reaching here still requires the owner's
       explicit action. */
    const hasLateEvidence = detail.events.some(
      (event) => event.type === "brief_evidence_confirmed_late",
    );
    if (!hasStaleConsumer && !hasLateEvidence) throw new MeetingBriefRegenerationConflict(runId);
    const storedOccurrenceKey = (snapshot as unknown as { occurrenceKey?: unknown }).occurrenceKey;
    const occurrenceKey =
      typeof storedOccurrenceKey === "string"
        ? storedOccurrenceKey
        : meetingBriefOccurrenceIdentity(snapshot.eventId, snapshot.occurrenceId).occurrenceKey;
    const regeneration = this.runner.startRun(
      {
        intake: MEETING_BRIEF_INTAKE,
        sourceUrl: null,
        externalId: meta.externalId ?? occurrenceKey,
      },
      {
        ...snapshot,
        occurrenceKey,
        supersedesRunId: runId,
        profileRefreshOf: runId,
      },
    );
    this.profileRegenerations.set(runId, regeneration);
    try {
      const regeneratedId = await regeneration;
      // A regenerated (revised) Brief moves briefStatus — day/week go stale.
      this.briefings.markBriefingsStale(this.now(), this.getTimezone());
      return regeneratedId;
    } catch (error) {
      if (this.profileRegenerations.get(runId) === regeneration)
        this.profileRegenerations.delete(runId);
      throw error;
    }
  }

  private profileReadModel(result: MeetingBriefRunResult): MeetingBriefPersonProfileReadModel {
    return {
      consumers: (result.personProfileLinks ?? []).map((link) => ({
        link,
        state:
          this.deps.personProfiles?.consumerState(link.profileId, link.profileRevision) ?? null,
      })),
    };
  }

  /** Recovery scans due records on boot (covers ADR-0032 without blocked Runs) + bounded Calendar reconciliation (issue://83). */
  async recover(): Promise<number> {
    const runsRecovered = await this.runner.recoverRuns();
    // Calendar channel renewal + bounded full look-ahead (startup establishes 90-day horizon)
    try {
      await this.ensureCalendarWatch();
    } catch {
      // provider may be fake or not configured — ignore
    }
    try {
      await this.reconcileCalendar({ forceFullSync: true });
      this.lastFullSyncAt = new Date(this.now());
    } catch {
      // Calendar unavailable — durable schedules remain, recovery still returns
    }
    const due = this.clock.due(this.now());
    if (due.length > 0) {
      await this.processDueSchedules(this.now());
    }
    return runsRecovered;
  }

  /** Periodic maintenance: watch renewal, Sunday sweep, bounded full reconcile on cadence, and due schedules. Avoids overlapping ticks. */
  async maintenanceTick(now = this.now()): Promise<void> {
    if (this.maintenanceInProgress) return;
    this.maintenanceInProgress = true;
    try {
      await this.ensureCalendarWatch().catch(() => {});
      await this.sweepIfSunday(now);
      await this.briefings.refreshDailyIfMorning(now);
      await this.briefings.refreshWeeklyIfMonday(now);
      // One coalesced rebuild per stale briefing whose quiet period expired.
      this.briefings.refreshStaleIfDue(now);
      const shouldFullSync =
        this.lastFullSyncAt === null ||
        now.getTime() - this.lastFullSyncAt.getTime() >= this.fullSyncIntervalMs;
      if (shouldFullSync) {
        try {
          await this.reconcileCalendar({ forceFullSync: true });
          this.lastFullSyncAt = new Date(now);
        } catch {
          // ignore — next tick will retry
        }
      }
      await this.processDueSchedules(now);
    } finally {
      this.maintenanceInProgress = false;
    }
  }

  /**
   * Run the weekly sweep once per week, on Sunday in the owner's calendar
   * timezone (issue://157). Guarded by the covered window start, so restarts
   * re-sweep harmlessly — scheduling is idempotent and current Briefs are
   * skipped. Never throws into the caller's tick path.
   */
  private async sweepIfSunday(now: Date): Promise<void> {
    const timezone = this.getTimezone();
    const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
    if (!local.isValid || local.weekday !== 7) return;
    const windowStart = sweepWindowFor(now, timezone).windowStart.toISOString();
    if (this.lastSweepWeek === windowStart) return;
    try {
      await this.prepareWeekSweep(now, timezone);
      this.lastSweepWeek = windowStart;
    } catch (error) {
      this.deps.log?.(
        `week sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Debrief action-item hook (issue #162): a new action item touches the
   * current day/week briefings the same way a Brief or calendar change does.
   * The Shell calls this when the Debrief side records action items; the
   * previous briefings keep serving with stale:true until the quiet rebuild.
   */
  notifyActionItemsChanged(now = this.now(), timezone = this.getTimezone()): void {
    this.briefings.notifyActionItemsChanged(now, timezone);
  }

  /**
   * The Daily Briefing build (issue #160): derive the day ahead from the
   * day's Meetings and their Meeting Briefs. Never throws — a failed build
   * records its message for the home surface instead. Sets the day guard
   * either way, so one bad morning does not retry every 30 seconds; the
   * owner retries explicitly from the home surface. An explicit refresh (the
   * morning tick, the retry button, or an expired quiet period) always serves
   * fresh and clears the dirty flag.
   */
  refreshDailyBriefing(now = this.now(), timezone = this.getTimezone()): DailyBriefingState {
    return this.briefings.refreshDaily(now, timezone);
  }

  /**
   * The stored Daily Briefing state, building it on first read for the day
   * so the home surface answers before the morning tick has run. Pure
   * derivation (ADR-0005): no Run starts here. While the day's briefing is
   * stale (issue #162) the previous value keeps serving with stale:true; the
   * rebuild fires once the quiet period expires. A touching change the host
   * did not directly observe (e.g. a Brief Run completing) is caught by the
   * version compare below, which marks stale but never serves fresh early.
   */
  getDailyBriefing(now = this.now(), timezone = this.getTimezone()): DailyBriefingState {
    return this.briefings.getDaily(now, timezone);
  }

  /**
   * The Weekly Briefing build (issue #161): derive the week ahead from the
   * coming week's Meetings and their Meeting Briefs. Never throws — a failed
   * build records its message for the home surface instead. Sets the week
   * guard either way, so one bad Monday does not retry every 30 seconds; the
   * owner retries explicitly from the home surface. An explicit refresh always
   * serves fresh and clears the dirty flag.
   */
  refreshWeeklyBriefing(now = this.now(), timezone = this.getTimezone()): WeeklyBriefingState {
    return this.briefings.refreshWeekly(now, timezone);
  }

  /**
   * The stored Weekly Briefing state, building it on first read for the week
   * so the home surface answers before the Monday tick has run. Pure
   * derivation (ADR-0005): no Run starts here. While the week's briefing is
   * stale (issue #162) the previous value keeps serving with stale:true; the
   * rebuild fires once the quiet period expires. Unobserved touching changes
   * are caught by the version compare, which marks stale but never serves
   * fresh early.
   */
  getWeeklyBriefing(now = this.now(), timezone = this.getTimezone()): WeeklyBriefingState {
    return this.briefings.getWeekly(now, timezone);
  }

  start(): void {
    this.runner.startRecoveryLoop();
    void this.recover();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.maintenanceTick(), 30_000);
    this.timer.unref();
  }

  stop(): void {
    this.runner.stopRecoveryLoop();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Live Module (issue://92) — Settings/Intake plus Cross-Run index. The
  async routes(app: FastifyInstance): Promise<void> {
    app.post("/api/meeting-brief/runs/:id/regenerate", async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = this.deps.runs.detail(id);
      if (detail?.module !== MEETING_BRIEF_MODULE_ID) {
        reply.code(404);
        return { error: "meeting-brief-run-not-found" };
      }
      try {
        const runId = await this.regenerateRun(id);
        reply.code(202);
        return { runId };
      } catch (error) {
        reply.code(409);
        return {
          error:
            error instanceof MeetingBriefRegenerationConflict
              ? error.code
              : "meeting-brief-regeneration-unavailable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });

    app.get("/api/meeting-brief/runs/:id/profile-consumers", async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = this.deps.runs.detail(id);
      const result = detail?.result as MeetingBriefRunResult | null | undefined;
      if (detail?.module !== MEETING_BRIEF_MODULE_ID || !result) {
        reply.code(404);
        return { error: "meeting-brief-run-not-found" };
      }
      return this.profileReadModel(result);
    });

    // GET /api/meeting-brief/index — Cross-Run index derived on read (ADR-0005)
    app.get("/api/meeting-brief/index", async () => {
      return this.index();
    });

    // GET /api/meeting-brief/daily — the Daily Briefing for the day ahead,
    // derived on read from the day's Meetings and their Meeting Briefs
    // (issue #160). Null briefing when the day holds no Meetings; a failed
    // build surfaces its message here (not on the general page) with the
    // last good value kept.
    app.get("/api/meeting-brief/daily", async () => {
      return this.getDailyBriefing();
    });

    app.post("/api/meeting-brief/daily/retry", async () => {
      const state = this.refreshDailyBriefing();
      await this.briefings.sendDailyEmailIfDue();
      return state;
    });

    // GET /api/meeting-brief/weekly — the Weekly Briefing for the week ahead,
    // derived on read from the coming week's Meetings and their Meeting
    // Briefs (issue #161). Null briefing when the week holds no Meetings; a
    // failed build surfaces its message here (not on the general page) with
    // the last good value kept.
    app.get("/api/meeting-brief/weekly", async () => {
      return this.getWeeklyBriefing();
    });

    app.post("/api/meeting-brief/weekly/retry", async () => this.refreshWeeklyBriefing());

    // GET /api/meetings/overview — the Meeting Wizard read projection (spec
    // Implementation Decision 3, kept separate per Decision 9): a read over
    // Calendar occurrences and Brief state that links sibling records
    // without owning a combined lifecycle record. Brief and Debrief remain
    // separate lifecycles (ADR-0043).
    app.get("/api/meetings/overview", async () => {
      return this.index();
    });

    // GET /api/meeting-brief/config — normalized Internal Domains only.
    app.get("/api/meeting-brief/config", async () => {
      return { internalDomains: this.getInternalDomains() };
    });

    // PUT /api/meeting-brief/config — configure normalized Internal Domains
    app.put("/api/meeting-brief/config", async (request, reply) => {
      const body = request.body as { internalDomains?: unknown } | undefined;
      if (!body || !Array.isArray(body.internalDomains)) {
        return reply.code(400).send({ error: "internalDomains must be an array of strings" });
      }
      if (!body.internalDomains.every((d) => typeof d === "string")) {
        return reply.code(400).send({ error: "internalDomains must be strings" });
      }
      const normalized = this.setInternalDomains(body.internalDomains);
      // After domain change, re-reconcile Calendar so eligibility reflects new domains
      try {
        await this.reconcileCalendar({ forceFullSync: true });
      } catch {
        // ignore reconciliation failure — config still persisted
      }
      return { internalDomains: normalized };
    });

    // GET /api/meeting-brief/provider-policy — the bundle vocabulary and the
    // recorded policy, so workflow bundles can be configured at onboarding
    // (spec step 7) rather than only as an action on an existing Run.
    app.get("/api/meeting-brief/provider-policy", async () => {
      return {
        providers: [...MEETING_BRIEF_BUNDLE_PROVIDERS],
        policy: this.getProviderPolicy(),
      };
    });

    // PUT /api/meeting-brief/provider-policy — record the owner's explicit
    // policy over the whole bundle in one action. Every provider is written,
    // enabled ones included: an affirmed provider is a recorded decision, not
    // an absent one, which is what keeps policy from relaxing silently (#137).
    app.put("/api/meeting-brief/provider-policy", async (request, reply) => {
      const body = request.body as { disabled?: unknown; reason?: unknown } | undefined;
      const disabled = body?.disabled ?? [];
      if (!Array.isArray(disabled) || !disabled.every((p) => typeof p === "string")) {
        return reply.code(400).send({ error: "disabled must be an array of provider ids" });
      }
      const unknown = disabled.filter(
        (p) => !MEETING_BRIEF_BUNDLE_PROVIDERS.includes(p as MeetingBriefBundleProvider),
      );
      if (unknown.length > 0) {
        return reply.code(400).send({
          error: "unknown-provider",
          unknown,
          providers: [...MEETING_BRIEF_BUNDLE_PROVIDERS],
        });
      }
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      for (const provider of MEETING_BRIEF_BUNDLE_PROVIDERS) {
        this.setProviderPolicy(
          provider,
          disabled.includes(provider),
          reason || "workflow bundle policy configured in Settings",
        );
      }
      return { providers: [...MEETING_BRIEF_BUNDLE_PROVIDERS], policy: this.getProviderPolicy() };
    });

    // POST /api/meeting-brief/runs/:id/provider-policy — an explicit repair,
    // disable, or re-enable action recorded on the Run (#137). Disabling or
    // re-enabling persists the versioned provider policy; every action stops
    // the Run's automatic retries so the person's explicit retry is what
    // continues the work.
    app.post("/api/meeting-brief/runs/:id/provider-policy", async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = this.deps.runs.detail(id);
      if (detail?.module !== MEETING_BRIEF_MODULE_ID) {
        reply.code(404);
        return { error: "meeting-brief-run-not-found" };
      }
      const body = request.body as
        { provider?: unknown; action?: unknown; reason?: unknown } | undefined;
      const provider = typeof body?.provider === "string" ? body.provider : "";
      const action = body?.action;
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      if (!MEETING_BRIEF_BUNDLE_PROVIDERS.includes(provider as MeetingBriefBundleProvider)) {
        reply.code(400);
        return { error: "unknown-provider", providers: [...MEETING_BRIEF_BUNDLE_PROVIDERS] };
      }
      if (action !== "disable" && action !== "enable" && action !== "repair") {
        reply.code(400);
        return { error: "action must be disable, enable, or repair" };
      }
      const handle = this.deps.runs.open(id);
      if (!handle) {
        reply.code(404);
        return { error: "meeting-brief-run-not-found" };
      }
      handle.appendEvent("provider_policy_action", {
        provider,
        action,
        reason: reason || null,
        at: this.now().toISOString(),
      });
      if (action === "disable" || action === "enable") {
        this.setProviderPolicy(
          provider as MeetingBriefBundleProvider,
          action === "disable",
          reason ||
            (action === "disable"
              ? "provider disabled by explicit action"
              : "provider re-enabled by explicit action"),
        );
      }
      const meta = handle.read();
      if (meta.status === "blocked" && meta.wait?.reason === "provider_retry_backoff") {
        handle.appendEvent("automatic_retry_stopped", { provider, action });
        handle.failed(
          "enrich",
          `provider_policy_action: ${provider} ${action} stopped automatic retries`,
          `Provider "${provider}" was ${action}d by explicit policy action. Retry the Run explicitly to continue with the updated policy.`,
        );
      }
      return { runId: id, provider, action, status: handle.read().status };
    });

    // POST /api/meeting-brief/reconcile — manual trigger (for Settings "Check calendar" or tests)
    app.post("/api/meeting-brief/reconcile", async (request) => {
      const body = (request.body as { forceFullSync?: unknown } | undefined) ?? {};
      const forceFullSync = body.forceFullSync === true;
      try {
        const result = await this.reconcileCalendar({ forceFullSync });
        return { ...result, upcoming: this.listUpcoming() };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          upcoming: this.listUpcoming(),
        };
      }
    });

    // POST /api/meeting-brief/sweep — manual Sunday-sweep trigger (issue://157)
    app.post("/api/meeting-brief/sweep", async (request) => {
      const body = (request.body as { timezone?: unknown } | undefined) ?? {};
      const timezone =
        typeof body.timezone === "string" && body.timezone ? body.timezone : this.getTimezone();
      try {
        const result = await this.prepareWeekSweep(this.now(), timezone);
        return { ...result, upcoming: this.listUpcoming() };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          upcoming: this.listUpcoming(),
        };
      }
    });

    // GET /api/meeting-brief/calendar/status — channel + sync state (no token secret)
    /* The Module's manual Run: prepare an upcoming brief without waiting for
       its scheduled prep time. */
    app.post("/api/meeting-brief/prepare", async (request, reply) => {
      const body = (request.body as { occurrenceKey?: unknown } | undefined) ?? {};
      const occurrenceKey = typeof body.occurrenceKey === "string" ? body.occurrenceKey : "";
      if (!occurrenceKey) {
        reply.code(400).send({ error: "occurrenceKey is required" });
        return;
      }
      try {
        const runId = await this.prepareNow(occurrenceKey);
        return { runId, upcoming: this.listUpcoming() };
      } catch (error) {
        reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.get("/api/meeting-brief/calendar/status", async () => {
      const state = this.getCalendarState();
      return {
        channel: state.channel
          ? {
              channelId: state.channel.channelId,
              resourceId: state.channel.resourceId,
              expiration: state.channel.expiration,
              calendarId: state.channel.calendarId,
            }
          : null,
        syncToken: state.syncToken ? `${state.syncToken.slice(0, 6)}…` : null,
        hasToken: Boolean(state.channel?.token),
        lastSyncAt: state.lastSyncAt,
      };
    });
  }
}
