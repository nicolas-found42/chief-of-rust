import type { FastifyInstance } from "fastify";
import type {
  BrandProfileRevision,
  BrandProfileProposal,
  BrandProfileSourceScan,
  ContentShortlist,
  ContentScoutRunResult,
  RunMeta,
  SourceBackfillWindowDays,
  SourceCapability,
  SourceDiagnosticClassification,
  SourceTarget,
} from "@chief-of-staff-demo/shared";
import {
  CONTENT_PROJECT_TARGETS,
  CONTENT_PROJECT_RESEARCH_MODES,
} from "@chief-of-staff-demo/shared";
import {
  CONTENT_SCOUT_MODULE_ID,
  CONTENT_SCOUT_MODULE_VERSION,
  acceptedProposalMarkdown,
  isSuccessfulSourceDiagnostic,
  SOURCE_BACKFILL_WINDOWS_DAYS,
  CANARY_INTERVAL_MS,
} from "@chief-of-staff-demo/shared";
import { evaluateLinkedInEvidenceGate, type LinkedInCanaryEvidence } from "./adapters/linkedin.js";
import type { HostedModule } from "../../engine/host.js";
import type { ConfigStore } from "../../config.js";
import { Runner } from "../../engine/runner.js";
import { DateTime } from "luxon";
import type { Runs } from "../../runs.js";
import { CONTENT_SCOUT_INTAKE, contentScoutModule, type ContentScoutInput } from "./module.js";
import type {
  OpportunityRanker,
  SourceDiscoverer,
  BrandProfileCrawler,
  BrandProfileProposer,
  RuntimeInspector,
} from "./ports.js";
import type {
  OpportunityProjectInput,
  OpportunityProjects,
} from "../../content-projects/opportunity-projects.js";
import type { SourceAdapter } from "../../source-adapters/source-adapter.js";
import { ContentScoutCanaryRunner, ContentScoutCanaryStore } from "./canary.js";
import { ContentScoutStore } from "./store.js";
import {
  CONTENT_SCOUT_DISCOVERY_INTAKE,
  contentScoutDiscoveryModule,
  type ContentScoutDiscoveryInput,
} from "./discovery.js";
import {
  CONTENT_SCOUT_BRAND_SCAN_INTAKE,
  brandProfileScanModule,
  type BrandProfileScanInput,
} from "./brand-profile.js";
import {
  CONTENT_SCOUT_BACKFILL_INTAKE,
  backfillExternalId,
  contentScoutBackfillModule,
  type ContentScoutBackfillInput,
} from "./backfill.js";
import { ContentScoutRetention } from "./retention.js";

interface SourceHealthObservation {
  key: string;
  adapterId: string;
  targetId: string | null;
  outcome: SourceDiagnosticClassification;
  affectedCapabilities: SourceCapability[];
  runId: string;
  runCreatedAt: string;
  observedAt: string;
}

type ActiveSourceHealthWarning = Omit<SourceHealthObservation, "key" | "runCreatedAt">;

export interface ContentScoutHostDeps {
  runs: Runs;
  workspaceDir: string;
  adapters: SourceAdapter[];
  ranker: OpportunityRanker;
  /** Selecting a shortlisted Opportunity starts exactly one governed Content Project (#133). */
  opportunityProjects?: OpportunityProjects;
  configStore?: ConfigStore;
  discoverer?: SourceDiscoverer;
  brandProfileCrawler?: BrandProfileCrawler;
  brandProfileProposer?: BrandProfileProposer;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  runtimeInspector?: RuntimeInspector;
  /** Content generation requires the canonical owner Profile confirmation. */
  isOwnerProfileConfirmed?: () => boolean;
  log: (message: string) => void;
}

/** Deep Module interface for Content Scout's Runs and persistent source view. */
export class ContentScoutHost implements HostedModule {
  readonly id = CONTENT_SCOUT_MODULE_ID;
  readonly version = CONTENT_SCOUT_MODULE_VERSION;
  private readonly runner: Runner<ContentScoutInput>;
  private readonly discoveryRunner: Runner<ContentScoutDiscoveryInput>;
  private readonly brandProfileRunner: Runner<BrandProfileScanInput>;
  private readonly backfillRunner: Runner<ContentScoutBackfillInput>;
  private readonly store: ContentScoutStore;
  private readonly deps: ContentScoutHostDeps;
  private readonly retention: ContentScoutRetention;
  private readonly canaryStore: ContentScoutCanaryStore;
  private readonly canaryRunner: ContentScoutCanaryRunner;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private checkingSchedule = false;
  private checkingCanary = false;

  constructor(deps: ContentScoutHostDeps) {
    this.deps = deps;
    const now = deps.now ?? (() => new Date());
    this.store = new ContentScoutStore(deps.workspaceDir, now);
    this.retention = new ContentScoutRetention(deps.workspaceDir, now);
    this.retention.enforce();
    this.runner = new Runner({
      runs: deps.runs,
      module: contentScoutModule({
        store: this.store,
        adapters: deps.adapters,
        ranker: deps.ranker,
        ...(deps.opportunityProjects ? { opportunityProjects: deps.opportunityProjects } : {}),
        supersede: (oldRunId, newRunId) => this.supersede(oldRunId, newRunId),
        intakeCompleted: (period) => {
          if (period) this.store.recordSuccessfulPeriod("intake", period);
        },
        shortlistSize: () =>
          deps.configStore?.get().modules[CONTENT_SCOUT_MODULE_ID].shortlistSize ?? 5,
        ...(deps.isOwnerProfileConfirmed
          ? { isOwnerProfileConfirmed: deps.isOwnerProfileConfirmed }
          : {}),
        now,
        sleep:
          deps.sleep ??
          ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
        recordSanitizedDiagnostic: (id, contentType, body) =>
          this.retention.recordSanitizedDiagnostic({ id, contentType, body }),
      }),
      now,
      log: deps.log,
    });
    this.discoveryRunner = new Runner({
      runs: deps.runs,
      module: contentScoutDiscoveryModule({
        store: this.store,
        discoverer: deps.discoverer ?? { discover: async () => [] },
        discoveryCompleted: (period) => {
          if (period) this.store.recordSuccessfulPeriod("discovery", period);
        },
      }),
      now,
      log: deps.log,
    });
    this.brandProfileRunner = new Runner({
      runs: deps.runs,
      module: brandProfileScanModule({
        store: this.store,
        crawler: deps.brandProfileCrawler ?? {
          crawl: async () => {
            throw new Error("Brand Profile crawler is not configured.");
          },
        },
        proposer: deps.brandProfileProposer ?? {
          propose: async () => {
            throw new Error("Brand Profile proposer is not configured.");
          },
        },
        now,
      }),
      now,
      log: deps.log,
    });
    this.backfillRunner = new Runner({
      runs: deps.runs,
      module: contentScoutBackfillModule({
        store: this.store,
        adapters: deps.adapters,
        now,
        sleep:
          deps.sleep ??
          ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
        recordSanitizedDiagnostic: (id, contentType, body) =>
          this.retention.recordSanitizedDiagnostic({ id, contentType, body }),
      }),
      now,
      log: deps.log,
    });
    this.canaryStore = new ContentScoutCanaryStore(deps.workspaceDir, now);
    this.canaryRunner = new ContentScoutCanaryRunner({
      adapters: deps.adapters,
      store: this.canaryStore,
      now,
      // Say it before it happens: a batch reaches public third-party services, and
      // issue #104 was that the traffic was invisible at the moment it left.
      announce: (targetCount) =>
        deps.log(
          `Content Scout canary batch starting: ${targetCount} public target(s) will be contacted`,
        ),
      intervalMs: () => this.canaryIntervalMs(),
      disabledAdapters: () =>
        this.deps.configStore?.get().modules[CONTENT_SCOUT_MODULE_ID].canaryDisabledAdapters ?? [],
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
  }

  acceptBrandProfile(input: {
    markdown: string;
    sourceScan: BrandProfileSourceScan;
    note?: string | null;
    siteBaselineMarkdown?: string;
  }): BrandProfileRevision {
    return this.store.acceptBrandProfile(input);
  }

  addSourceTarget(input: { adapterId: string; label: string; url: string }): SourceTarget {
    return this.store.addSourceTarget(input);
  }

  listSourceTargets(): SourceTarget[] {
    return this.store.listSourceTargets();
  }

  currentBrandProfile(): BrandProfileRevision | null {
    return this.store.currentBrandProfile();
  }

  brandProfileProposal(): BrandProfileProposal | null {
    return this.store.brandProfileProposal();
  }

  setSourceTargetState(id: string, state: "active" | "archived"): SourceTarget {
    return this.store.setSourceTargetState(id, state);
  }

  activeShortlist(): ContentShortlist | null {
    return this.store.activeShortlist();
  }

  listSourceSuggestions() {
    return this.store.listSourceSuggestions();
  }

  scheduleState() {
    return this.store.scheduleState();
  }

  recordSanitizedDiagnostic(input: { id: string; contentType: string; body: string }): void {
    this.retention.recordSanitizedDiagnostic(input);
  }

  recordTemporaryMedia(input: { id: string; outcome: "processed" | "failed"; bytes: string }): {
    retained: boolean;
  } {
    return this.retention.recordTemporaryMedia(input);
  }

  retainEvidenceTranscript(input: { id: string; text: string }): void {
    this.retention.retainEvidenceTranscript(input);
  }

  storageUse() {
    return this.retention.storageUse();
  }

  previewTemporaryCleanup() {
    return this.retention.preview();
  }

  cleanupTemporaryData(dryRun = false) {
    return this.retention.cleanup(dryRun);
  }

  decideSourceSuggestion(
    id: string,
    decision: "approved" | "dismissed" | "proposed",
    reason: string | null,
  ) {
    return this.store.decideSourceSuggestion(id, decision, reason);
  }

  async select(
    runId: string,
    opportunityIds: string[],
    project: OpportunityProjectInput,
  ): Promise<RunMeta> {
    if (this.deps.isOwnerProfileConfirmed && !this.deps.isOwnerProfileConfirmed()) {
      throw new Error(
        "owner_not_confirmed: confirm the workspace owner Profile before starting a Content Project",
      );
    }
    this.validateProjectInput(project);
    this.store.recordSelection(runId, opportunityIds, project);
    return await this.runner.resumeRun(runId);
  }

  /** Fail fast on governed Project inputs before a Run consumes them (#133). */
  private validateProjectInput(project: OpportunityProjectInput): void {
    if (!project.objective.trim()) {
      throw new Error("invalid_project_input: an objective is required for the Content Project.");
    }
    if (!project.audience.trim()) {
      throw new Error("invalid_project_input: an audience is required for the Content Project.");
    }
    if (
      project.targets.length === 0 ||
      project.targets.some((target) => !CONTENT_PROJECT_TARGETS.includes(target))
    ) {
      throw new Error(
        "invalid_project_input: select at least one known publication target for the Content Project.",
      );
    }
    if (
      project.researchMode !== null &&
      !CONTENT_PROJECT_RESEARCH_MODES.includes(project.researchMode)
    ) {
      throw new Error(
        "invalid_project_input: choose a known research mode for the Content Project.",
      );
    }
  }

  async skip(runId: string): Promise<RunMeta> {
    this.store.recordSkip(runId);
    return await this.runner.resumeRun(runId);
  }

  decideOpportunity(
    runId: string,
    opportunityId: string,
    decision: "dismiss_angle" | "not_relevant" | "already_covered",
  ) {
    this.store.decideOpportunity(runId, opportunityId, decision);
    return this.activeShortlist();
  }

  scoutNow(
    invocation: "manual" | "scheduled" = "manual",
    period: string | null = null,
  ): Promise<string> {
    this.retention.enforce();
    return this.runner.startRun(
      {
        intake: CONTENT_SCOUT_INTAKE,
        fileName: "Content Scout shortlist.md",
        sourceUrl: null,
        externalId: period,
      },
      { kind: "intake", invocation },
    );
  }

  discoverNow(
    invocation: "manual" | "scheduled" = "manual",
    period: string | null = null,
  ): Promise<string> {
    return this.discoveryRunner.startRun(
      {
        intake: CONTENT_SCOUT_DISCOVERY_INTAKE,
        fileName: "Content Scout source suggestions.json",
        sourceUrl: null,
        externalId: period,
      },
      { invocation },
    );
  }

  backfillSourceTarget(targetId: string, windowDays: SourceBackfillWindowDays): Promise<string> {
    const target = this.listSourceTargets().find((candidate) => candidate.id === targetId);
    if (!target) {
      throw new Error(`Source Target not found: ${targetId}`);
    }
    if (target.state !== "active") {
      throw new Error("Only an active Source Target can be backfilled.");
    }
    return this.backfillRunner.startRun(
      {
        intake: CONTENT_SCOUT_BACKFILL_INTAKE,
        fileName: `${target.label} — ${windowDays}-day backfill`,
        sourceUrl: target.url,
        externalId: backfillExternalId({ targetId, windowDays }),
      },
      { targetId, windowDays },
    );
  }

  scanBrandProfile(websiteUrl: string): Promise<string> {
    return this.brandProfileRunner.startRun(
      {
        intake: CONTENT_SCOUT_BRAND_SCAN_INTAKE,
        fileName: "Content Scout Brand Profile proposal.md",
        sourceUrl: websiteUrl,
        externalId: null,
      },
      { websiteUrl },
    );
  }

  canaryReceipts() {
    return this.canaryStore.list();
  }

  canaryHealth() {
    return this.canaryStore.allHealth(this.deps.adapters);
  }

  /** Configured hours between automatic batches, falling back to the shipped cadence. */
  private canaryIntervalMs(): number {
    const hours = this.deps.configStore?.get().modules[CONTENT_SCOUT_MODULE_ID].canaryIntervalHours;
    return typeof hours === "number" && hours > 0 ? hours * 60 * 60 * 1000 : CANARY_INTERVAL_MS;
  }

  /**
   * What the Settings surface needs to tell the truth about outbound canary traffic:
   * whether automatic batches are running at all, and when the last one went out.
   */
  canarySchedule(): { lastRunAt: string | null; automatic: boolean; intervalHours: number } {
    const lastRunAt = this.canaryStore.lastRunAt();
    return {
      lastRunAt,
      automatic: lastRunAt !== null,
      intervalHours: Math.round(this.canaryIntervalMs() / (60 * 60 * 1000)),
    };
  }

  async runCanaries() {
    return await this.canaryRunner.runOnce();
  }

  async checkCanarySchedule(): Promise<void> {
    if (this.checkingCanary) return;
    this.checkingCanary = true;
    try {
      const result = await this.canaryRunner.checkSchedule();
      if (result && result.length > 0) {
        this.deps.log(`Content Scout canary batch: ${result.length} receipts`);
      }
    } catch (error) {
      this.deps.log(
        `Content Scout canary schedule failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.checkingCanary = false;
    }
  }

  retryRun(id: string): Promise<RunMeta> {
    const run = this.deps.runs.open(id);
    const meta = run?.read();
    const intake = meta?.intake;
    if (intake === CONTENT_SCOUT_DISCOVERY_INTAKE) return this.discoveryRunner.retryRun(id);
    if (intake === CONTENT_SCOUT_BRAND_SCAN_INTAKE) return this.brandProfileRunner.retryRun(id);
    // Daily Intake and a Source Target backfill both name their collection
    // Stage "collect" and share the collection-progress.json shape, so a
    // manual retry of either clears its non-completed entries first:
    // collectSourceTargets otherwise treats an exhausted-but-retryable
    // failure as final and refuses to attempt it again.
    if (
      (intake === CONTENT_SCOUT_INTAKE || intake === CONTENT_SCOUT_BACKFILL_INTAKE) &&
      run &&
      meta?.failedStage === "collect"
    ) {
      const raw = run.readArtifact("collection-progress.json");
      if (raw) {
        try {
          const progress = JSON.parse(raw) as { result?: { kind?: string } }[];
          const completed = progress.filter((entry) => entry.result?.kind === "completed");
          run.writeArtifact("collection-progress.json", `${JSON.stringify(completed, null, 2)}\n`);
        } catch {
          // Preserve a malformed artifact so the retry fails visibly instead of discarding evidence.
        }
      }
    }
    if (intake === CONTENT_SCOUT_BACKFILL_INTAKE) return this.backfillRunner.retryRun(id);
    return this.runner.retryRun(id);
  }

  idle(): Promise<void> {
    return Promise.all([
      this.runner.idle(),
      this.discoveryRunner.idle(),
      this.brandProfileRunner.idle(),
      this.backfillRunner.idle(),
    ]).then(() => undefined);
  }

  start(): void {
    this.runner.startRecoveryLoop();
    this.discoveryRunner.startRecoveryLoop();
    this.brandProfileRunner.startRecoveryLoop();
    this.backfillRunner.startRecoveryLoop();
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    void this.checkSchedules();
    void this.checkCanarySchedule();
    this.scheduleTimer = setInterval(() => {
      void this.checkSchedules();
      void this.checkCanarySchedule();
    }, 30_000);
    this.scheduleTimer.unref();
  }

  stop(): void {
    this.runner.stopRecoveryLoop();
    this.discoveryRunner.stopRecoveryLoop();
    this.brandProfileRunner.stopRecoveryLoop();
    this.backfillRunner.stopRecoveryLoop();
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  async checkSchedules(): Promise<void> {
    if (this.checkingSchedule || !this.deps.configStore) return;
    this.checkingSchedule = true;
    try {
      const config = this.deps.configStore.get().modules[CONTENT_SCOUT_MODULE_ID];
      const local = DateTime.fromJSDate((this.deps.now ?? (() => new Date()))()).setZone(
        config.timeZone,
      );
      if (!local.isValid) {
        this.deps.log(`Content Scout schedule has invalid IANA time zone: ${config.timeZone}`);
        return;
      }
      const state = this.store.scheduleState();
      const hasBrandProfile = this.currentBrandProfile() !== null;
      const hasActiveSource = this.listSourceTargets().some((target) => target.state === "active");
      const dailyPeriod = local.toISODate();
      const [dailyHour, dailyMinute] = parseLocalTime(config.dailyTime);
      const dailyDue =
        local.hour > dailyHour || (local.hour === dailyHour && local.minute >= dailyMinute);
      if (
        hasBrandProfile &&
        hasActiveSource &&
        dailyDue &&
        state.lastSuccessfulIntakePeriod !== dailyPeriod &&
        !this.periodRunExists(CONTENT_SCOUT_INTAKE, dailyPeriod)
      ) {
        await this.scoutNow("scheduled", dailyPeriod);
      }

      const weeklyPeriod = `${local.weekYear}-W${String(local.weekNumber).padStart(2, "0")}`;
      const [weeklyHour, weeklyMinute] = parseLocalTime(config.weeklyDiscoveryTime);
      const weeklyDue =
        local.weekday > config.weeklyDiscoveryDay ||
        (local.weekday === config.weeklyDiscoveryDay &&
          (local.hour > weeklyHour || (local.hour === weeklyHour && local.minute >= weeklyMinute)));
      if (
        hasBrandProfile &&
        weeklyDue &&
        state.lastSuccessfulDiscoveryPeriod !== weeklyPeriod &&
        !this.periodRunExists(CONTENT_SCOUT_DISCOVERY_INTAKE, weeklyPeriod)
      ) {
        await this.discoverNow("scheduled", weeklyPeriod);
      }
    } finally {
      this.checkingSchedule = false;
    }
  }

  routes(app: FastifyInstance): void {
    const persistentIntakeHealth = () => {
      const intakeRuns = this.deps.runs
        .list({ module: CONTENT_SCOUT_MODULE_ID })
        .runs.filter((run) => run.intake === CONTENT_SCOUT_INTAKE);
      const observations: SourceHealthObservation[] = [];
      const degraded = new Map<string, ActiveSourceHealthWarning>();
      for (const run of intakeRuns) {
        const result = this.deps.runs.detail(run.id)
          ?.result as Partial<ContentScoutRunResult> | null;
        for (const adapter of result?.adapters ?? []) {
          const finalAttempts = new Map<string, NonNullable<typeof adapter.attempts>[number]>();
          for (const attempt of adapter.attempts) {
            const current = finalAttempts.get(attempt.targetId);
            if (!current || attempt.attempt > current.attempt) {
              finalAttempts.set(attempt.targetId, attempt);
            }
          }
          if (finalAttempts.size > 0) {
            for (const [targetId, attempt] of finalAttempts) {
              const key = `${adapter.adapterId}:${targetId}`;
              const finishedAt = attempt.finishedAt;
              observations.push({
                key,
                adapterId: adapter.adapterId,
                targetId,
                outcome: attempt.outcome,
                affectedCapabilities:
                  attempt.diagnostic?.affectedCapabilities ?? adapter.affectedCapabilities,
                runId: run.id,
                runCreatedAt: run.createdAt,
                observedAt: Number.isFinite(Date.parse(finishedAt)) ? finishedAt : run.createdAt,
              });
            }
            continue;
          }
          const legacyKey = `${adapter.adapterId}:legacy`;
          const legacyFailure =
            adapter.errorClassifications?.at(-1) ??
            (!isSuccessfulSourceDiagnostic(adapter.outcome) ? adapter.outcome : null);
          observations.push({
            key: legacyKey,
            adapterId: adapter.adapterId,
            targetId: null,
            outcome: legacyFailure ?? adapter.outcome,
            affectedCapabilities: adapter.affectedCapabilities,
            runId: run.id,
            runCreatedAt: run.createdAt,
            observedAt: run.createdAt,
          });
        }
      }
      observations.sort(
        (left, right) =>
          left.observedAt.localeCompare(right.observedAt) ||
          left.runCreatedAt.localeCompare(right.runCreatedAt) ||
          left.runId.localeCompare(right.runId) ||
          left.key.localeCompare(right.key),
      );
      for (const observation of observations) {
        if (isSuccessfulSourceDiagnostic(observation.outcome)) {
          const existing = degraded.get(observation.key);
          const stillAffected = new Set(observation.affectedCapabilities);
          const remaining =
            existing?.affectedCapabilities.filter((capability) => stillAffected.has(capability)) ??
            [];
          if (existing && remaining.length > 0) {
            degraded.set(observation.key, { ...existing, affectedCapabilities: remaining });
          } else {
            degraded.delete(observation.key);
          }
        } else {
          degraded.set(observation.key, observation);
        }
      }
      const activeWarnings = [...degraded.values()].sort(
        (left, right) =>
          left.observedAt.localeCompare(right.observedAt) ||
          left.adapterId.localeCompare(right.adapterId) ||
          (left.targetId ?? "").localeCompare(right.targetId ?? ""),
      );
      return {
        runId: activeWarnings.at(-1)?.runId ?? null,
        warnings: activeWarnings.map(({ adapterId, targetId, outcome, affectedCapabilities }) => ({
          adapterId,
          targetId,
          outcome,
          affectedCapabilities,
        })),
      };
    };
    app.get("/api/content-scout", async () => {
      const runtimeCapabilities = await (this.deps.runtimeInspector?.inspect() ??
        Promise.resolve([]));
      const intakeHealth = persistentIntakeHealth();
      const canaryHealth = this.canaryHealth();
      const canaryReceipts = this.canaryReceipts();
      const canaryWarnings = canaryHealth
        .filter((entry) => entry.degraded)
        .flatMap((entry) => {
          const failure = entry.recentReceipts.find(
            (receipt) => receipt.outcome !== "items_found" || receipt.itemsFound === 0,
          );
          return failure
            ? [
                {
                  adapterId: entry.adapterId,
                  targetId: null as string | null,
                  outcome: failure.outcome,
                  affectedCapabilities: failure.diagnostic.affectedCapabilities,
                },
              ]
            : [];
        });
      const mergedWarnings = [...intakeHealth.warnings, ...canaryWarnings];
      const linkedinEvidence: LinkedInCanaryEvidence[] = canaryReceipts
        .filter((receipt) => receipt.adapterId === "linkedin")
        .map((receipt) => ({
          targetUrl: receipt.target.url,
          adapterVersion: receipt.adapterVersion,
          outcome: receipt.outcome,
          itemsFound: receipt.itemsFound,
          hasUsefulItem: receipt.outcome === "items_found" && receipt.itemsFound > 0,
          observedAt: receipt.checkedAt,
          diagnostic: receipt.diagnostic,
        }));
      const linkedinEvidenceGate = evaluateLinkedInEvidenceGate(
        linkedinEvidence,
        this.deps.now ?? (() => new Date()),
      );
      return {
        brandProfile: this.currentBrandProfile(),
        brandProfileProposal: this.brandProfileProposal(),
        brandProfileRevisions: this.store.listBrandProfiles(),
        sourceTargets: this.listSourceTargets(),
        shortlist: this.activeShortlist(),
        sourceSuggestions: this.listSourceSuggestions(),
        schedule: this.scheduleState(),
        health: {
          runId: intakeHealth.runId,
          warnings: mergedWarnings,
          runtimeWarnings: runtimeCapabilities
            .filter((capability) => capability.state !== "available")
            .map((capability) => capability.id),
          canary: canaryHealth,
        },
        canary: {
          receipts: canaryReceipts.slice(-30),
          health: canaryHealth,
        },
        adapters: this.deps.adapters.map((adapter) => ({
          id: adapter.id,
          state: adapter.state,
          version: adapter.version,
          backfillWindowsDays: [...(adapter.backfillWindowsDays ?? [])],
          canaryTargets: [...(adapter.canaryTargets ?? [])],
          promotionEligible: this.canaryStore.promotionEligible(
            adapter,
            (this.deps.now ?? (() => new Date()))(),
          ),
        })),
        runtimeCapabilities,
        settings: this.deps.configStore?.get().modules[CONTENT_SCOUT_MODULE_ID] ?? null,
        storage: this.storageUse(),
        linkedinEvidenceGate,
      };
    });

    app.post("/api/content-scout/storage/cleanup/preview", async () =>
      this.previewTemporaryCleanup(),
    );
    app.post("/api/content-scout/storage/cleanup", async (request, reply) => {
      const body = request.body as { scope?: string; confirm?: boolean };
      if (body.scope !== "expired_temporary_data" || body.confirm !== true) {
        reply.code(400).send({
          error: "Confirm the expired_temporary_data scope before deleting temporary files.",
        });
        return;
      }
      return this.cleanupTemporaryData(false);
    });

    app.post("/api/content-scout/brand-profile", async (request, reply) => {
      const body = request.body as Partial<{
        markdown: string;
        websiteUrl: string;
        includedUrls: string[];
        excludedUrls: string[];
        note: string;
      }>;
      if (!body.markdown?.trim() || !body.websiteUrl?.trim()) {
        reply.code(400).send({ error: "Brand Profile Markdown and website URL are required." });
        return;
      }
      const revision = this.acceptBrandProfile({
        markdown: body.markdown,
        sourceScan: {
          websiteUrl: body.websiteUrl,
          includedUrls: body.includedUrls ?? [],
          excludedUrls: body.excludedUrls ?? [],
        },
        note: body.note ?? null,
      });
      reply.code(201);
      return { revision };
    });

    app.post("/api/content-scout/brand-profile/scan", async (request, reply) => {
      const websiteUrl = (request.body as { websiteUrl?: string }).websiteUrl?.trim();
      if (!websiteUrl) {
        reply.code(400).send({ error: "A public company website URL is required." });
        return;
      }
      try {
        const parsed = new URL(websiteUrl);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error();
      } catch {
        reply.code(400).send({ error: "A public HTTP or HTTPS website URL is required." });
        return;
      }
      return { runId: await this.scanBrandProfile(websiteUrl) };
    });

    app.post("/api/content-scout/brand-profile/proposals/:id/accept", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        acceptedSections?: unknown;
        includedUrls?: unknown;
        excludedUrls?: unknown;
        note?: string;
      };
      const proposal = this.brandProfileProposal();
      if (!proposal || proposal.id !== id) {
        reply.code(404).send({ error: "Brand Profile proposal not found." });
        return;
      }
      if (
        !Array.isArray(body.acceptedSections) ||
        body.acceptedSections.some((value) => typeof value !== "string")
      ) {
        reply.code(400).send({ error: "acceptedSections must be an array of section names." });
        return;
      }
      const includedUrls =
        Array.isArray(body.includedUrls) &&
        body.includedUrls.every((value) => typeof value === "string")
          ? body.includedUrls
          : proposal.pages.filter((page) => page.included).map((page) => page.url);
      const excludedUrls =
        Array.isArray(body.excludedUrls) &&
        body.excludedUrls.every((value) => typeof value === "string")
          ? body.excludedUrls
          : proposal.pages.filter((page) => !page.included).map((page) => page.url);
      const markdown = acceptedProposalMarkdown(proposal, body.acceptedSections as string[]);
      const revision = this.acceptBrandProfile({
        markdown,
        sourceScan: { websiteUrl: proposal.websiteUrl, includedUrls, excludedUrls },
        note: body.note ?? null,
        siteBaselineMarkdown: proposal.proposedMarkdown,
      });
      this.store.clearBrandProfileProposal(id);
      reply.code(201);
      return { revision };
    });

    app.get("/api/content-scout/brand-profile/revisions/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const revision = this.store.brandProfile(id);
      if (!revision) {
        reply.code(404).send({ error: "Brand Profile revision not found." });
        return;
      }
      return { revision };
    });

    app.post("/api/content-scout/brand-profile/revisions/:id/restore", async (request, reply) => {
      const { id } = request.params as { id: string };
      const stored = this.store.brandProfile(id);
      if (!stored) {
        reply.code(404).send({ error: "Brand Profile revision not found." });
        return;
      }
      /* Restoring is itself a new immutable revision: history never rewrites. */
      const revision = this.acceptBrandProfile({
        markdown: stored.markdown,
        sourceScan: stored.sourceScan,
        note: `Restored from ${stored.id}`,
      });
      reply.code(201);
      return { revision };
    });

    app.post("/api/content-scout/sources", async (request, reply) => {
      const body = request.body as Partial<{ adapterId: string; label: string; url: string }>;
      if (!body.adapterId || !body.label?.trim() || !body.url?.trim()) {
        reply.code(400).send({ error: "Adapter, label and recurring public URL are required." });
        return;
      }
      const adapter = this.deps.adapters.find((candidate) => candidate.id === body.adapterId);
      if (!adapter) {
        reply.code(400).send({ error: "That Source Adapter is not configured." });
        return;
      }
      if (adapter.state === "coming_later") {
        reply
          .code(409)
          .send({ error: "That Source Adapter is Coming later and cannot be monitored yet." });
        return;
      }
      try {
        const parsed = new URL(body.url);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error();
      } catch {
        reply.code(400).send({ error: "A public HTTP or HTTPS URL is required." });
        return;
      }
      reply.code(201);
      return {
        target: this.addSourceTarget(body as { adapterId: string; label: string; url: string }),
      };
    });

    app.patch("/api/content-scout/sources/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { state?: string };
      if (body.state !== "active" && body.state !== "archived") {
        reply.code(400).send({ error: "Source Target state must be active or archived." });
        return;
      }
      try {
        return { target: this.setSourceTargetState(id, body.state) };
      } catch (error) {
        reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.post("/api/content-scout/sources/:id/backfill", async (request, reply) => {
      const { id } = request.params as { id: string };
      const windowDays = (request.body as { windowDays?: number }).windowDays;
      if (!SOURCE_BACKFILL_WINDOWS_DAYS.includes(windowDays as SourceBackfillWindowDays)) {
        reply.code(400).send({ error: "Choose a 7-, 30-, or 90-day backfill window." });
        return;
      }
      const target = this.listSourceTargets().find((candidate) => candidate.id === id);
      if (!target) {
        reply.code(404).send({ error: "Source Target not found." });
        return;
      }
      if (target.state !== "active") {
        reply.code(409).send({ error: "Only an active Source Target can be backfilled." });
        return;
      }
      reply.code(201);
      return {
        runId: await this.backfillSourceTarget(target.id, windowDays as SourceBackfillWindowDays),
      };
    });

    app.post("/api/content-scout/run", async () => ({ runId: await this.scoutNow() }));
    app.post("/api/content-scout/discovery/run", async () => ({ runId: await this.discoverNow() }));
    app.post("/api/content-scout/canary/run", async () => {
      const receipts = await this.runCanaries();
      return { receipts };
    });
    app.get("/api/content-scout/canary", async () => ({
      receipts: this.canaryReceipts(),
      health: this.canaryHealth(),
      schedule: this.canarySchedule(),
    }));

    app.patch("/api/content-scout/suggestions/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { decision?: string; reason?: string | null };
      if (
        body.decision !== "approved" &&
        body.decision !== "dismissed" &&
        body.decision !== "proposed"
      ) {
        reply
          .code(400)
          .send({ error: "Suggestion decision must be approved, dismissed, or proposed." });
        return;
      }
      try {
        return { suggestion: this.decideSourceSuggestion(id, body.decision, body.reason ?? null) };
      } catch (error) {
        reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.patch("/api/content-scout/settings", async (request, reply) => {
      if (!this.deps.configStore) {
        reply.code(503).send({ error: "Content Scout settings are unavailable." });
        return;
      }
      const body = request.body as Partial<{
        timeZone: string;
        dailyTime: string;
        weeklyDiscoveryDay: number;
        weeklyDiscoveryTime: string;
        shortlistSize: number;
        canaryIntervalHours: number;
        canaryDisabledAdapters: string[];
      }>;
      if (
        !body.timeZone ||
        !DateTime.now().setZone(body.timeZone).isValid ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.dailyTime ?? "") ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.weeklyDiscoveryTime ?? "") ||
        !Number.isInteger(body.weeklyDiscoveryDay) ||
        body.weeklyDiscoveryDay! < 1 ||
        body.weeklyDiscoveryDay! > 7 ||
        !Number.isInteger(body.shortlistSize) ||
        body.shortlistSize! < 3 ||
        body.shortlistSize! > 10 ||
        !Number.isInteger(body.canaryIntervalHours) ||
        body.canaryIntervalHours! < 1 ||
        body.canaryIntervalHours! > 168 ||
        !Array.isArray(body.canaryDisabledAdapters) ||
        body.canaryDisabledAdapters.some((id) => typeof id !== "string")
      ) {
        reply.code(400).send({
          error:
            "Use an IANA time zone, valid local times, weekday 1–7, shortlist size 3–10, and a canary interval of 1–168 hours.",
        });
        return;
      }
      const current = this.deps.configStore.get().modules[CONTENT_SCOUT_MODULE_ID];
      this.deps.configStore.setModuleConfig(CONTENT_SCOUT_MODULE_ID, {
        ...current,
        timeZone: body.timeZone,
        dailyTime: body.dailyTime!,
        weeklyDiscoveryDay: body.weeklyDiscoveryDay!,
        weeklyDiscoveryTime: body.weeklyDiscoveryTime!,
        shortlistSize: body.shortlistSize!,
        canaryIntervalHours: body.canaryIntervalHours!,
        canaryDisabledAdapters: body.canaryDisabledAdapters,
      });
      return {
        settings: this.deps.configStore.get().modules[CONTENT_SCOUT_MODULE_ID],
        schedule: this.scheduleState(),
      };
    });

    app.post("/api/content-scout/shortlists/:runId/select", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const body = request.body as {
        opportunityIds?: unknown;
        project?: Partial<OpportunityProjectInput>;
      };
      if (
        !Array.isArray(body.opportunityIds) ||
        body.opportunityIds.some((id) => typeof id !== "string")
      ) {
        reply.code(400).send({ error: "opportunityIds must be an array of one to three ids." });
        return;
      }
      const project = body.project;
      if (
        !project ||
        typeof project.objective !== "string" ||
        typeof project.audience !== "string" ||
        !Array.isArray(project.targets) ||
        !("researchMode" in project)
      ) {
        reply.code(400).send({
          error:
            "The Content Project inputs (objective, audience, targets, researchMode) are required.",
        });
        return;
      }
      try {
        const meta = await this.select(runId, body.opportunityIds as string[], {
          objective: project.objective,
          audience: project.audience,
          constraints: project.constraints ?? [],
          targets: project.targets,
          researchMode: project.researchMode ?? null,
          seedMaterial: project.seedMaterial ?? [],
          ...(project.authorProfileId ? { authorProfileId: project.authorProfileId } : {}),
        });
        const detail = this.deps.runs.detail(runId);
        const result = detail?.result as Partial<ContentScoutRunResult> | null;
        if (meta.status === "failed") {
          reply.code(409).send({
            error: detail?.failureHint ?? "The selected Opportunities could not start a Project.",
          });
          return;
        }
        return { status: meta.status, projects: result?.projects ?? [] };
      } catch (error) {
        reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.post("/api/content-scout/shortlists/:runId/skip", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        const meta = await this.skip(runId);
        return { status: meta.status };
      } catch (error) {
        reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.patch(
      "/api/content-scout/shortlists/:runId/opportunities/:opportunityId",
      async (request, reply) => {
        const { runId, opportunityId } = request.params as { runId: string; opportunityId: string };
        const decision = (request.body as { decision?: string }).decision;
        if (
          decision !== "dismiss_angle" &&
          decision !== "not_relevant" &&
          decision !== "already_covered"
        ) {
          reply
            .code(400)
            .send({ error: "Choose Dismiss this angle, Not relevant, or Already covered." });
          return;
        }
        try {
          return { shortlist: this.decideOpportunity(runId, opportunityId, decision) };
        } catch (error) {
          reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
          return;
        }
      },
    );
  }

  private supersede(oldRunId: string, newRunId: string): void {
    const run = this.deps.runs.open(oldRunId);
    if (!run || run.read().status !== "blocked") return;
    const raw = run.readArtifact("shortlist.json");
    if (raw) {
      try {
        const shortlist = JSON.parse(raw) as ContentShortlist;
        shortlist.supersededByRunId = newRunId;
        run.writeArtifact("shortlist.json", `${JSON.stringify(shortlist, null, 2)}\n`);
      } catch {
        // The terminal reason remains visible even if the Module artifact is damaged.
      }
    }
    run.finished({ status: "skipped", reason: `Superseded by ${newRunId}.` });
  }

  private periodRunExists(intake: string, period: string): boolean {
    return this.deps.runs.list({ module: CONTENT_SCOUT_MODULE_ID }).runs.some((summary) => {
      const run = this.deps.runs.open(summary.id)?.read();
      return run?.intake === intake && run.externalId === period;
    });
  }
}

function parseLocalTime(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return [0, 0];
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? [hour, minute] : [0, 0];
}
