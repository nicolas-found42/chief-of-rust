import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod/v3";
import {
  CONTENT_RESEARCH_MODULE_ID,
  CONTENT_RESEARCH_MODULE_VERSION,
  type ContentResearchIndex,
  type ContentResearchRunResult,
  type NamedPerson,
  type PersonProfileProjection,
  type PersonSuggestion,
  type RunMeta,
  type SourceItem,
} from "@chief-of-staff-demo/shared";
import type { HostedModule } from "../../engine/host.js";
import { Runner } from "../../engine/runner.js";
import type { Runs } from "../../runs.js";
import type { ConfigStore } from "../../config.js";
import { ContentResearchStore } from "./store.js";
import { createFeedDiscoverer, type FeedDiscoverer } from "../../source-adapters/feeds.js";
import { createPublicSearch, type PublicSearch } from "../../source-adapters/search.js";
import type { HookExtractor, PeopleDiscoverer, SheetsAccess, GmailAccess } from "./ports.js";
import type { SourceAdapter } from "../../source-adapters/source-adapter.js";
import {
  CONTENT_RESEARCH_DISCOVERY_INTAKE,
  CONTENT_RESEARCH_INTAKE,
  CONTENT_RESEARCH_BACKFILL_INTAKE,
  contentResearchBackfillModule,
  contentResearchModule,
  peopleDiscoveryModule,
  type ContentResearchInput,
} from "./module.js";
import { DateTime } from "luxon";
import { errorMessage } from "../../engine/failure.js";

/**
 * Why a watch creation or activation was refused (spec #134): a Named Person
 * is always backed by a confirmed Person Profile, never by a bare name.
 */
export class ContentResearchProfileRefusal extends Error {
  constructor(
    public readonly code: "profile-required" | "profile-not-found",
    message: string,
  ) {
    super(message);
    this.name = "ContentResearchProfileRefusal";
  }
}

export interface ContentResearchHostDeps {
  runs: Runs;
  workspaceDir: string;
  adapters: SourceAdapter[];
  /** The public-safe Profile projection seam (spec #134). Watches are created
      and re-activated only through it — never against a bare name. */
  profileProjection: (profileId: string) => PersonProfileProjection | null;
  /** Injected so the Profile lifecycle registry can be composed over the same
      store; defaults to a private store when nobody else holds one. */
  store?: ContentResearchStore;
  hookExtractor: HookExtractor;
  discoverer?: PeopleDiscoverer;
  sheetsFactory?: () => SheetsAccess;
  gmailFactory?: () => GmailAccess;
  getOwnerEmail?: () => string | null;
  getBrandProfile?: () => { markdown: string } | null;
  discoverFeeds?: FeedDiscoverer;
  searchPublic?: PublicSearch;
  configStore?: ConfigStore;
  now?: () => Date;
  log?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class ContentResearchHost implements HostedModule {
  readonly id = CONTENT_RESEARCH_MODULE_ID;
  readonly version = CONTENT_RESEARCH_MODULE_VERSION;

  private readonly store: ContentResearchStore;
  private readonly runner: Runner<ContentResearchInput>;
  private readonly backfillRunner: Runner<{ windowDays: 7 | 30 | 90 }>;
  private readonly discoveryRunner: Runner<{ invocation: "manual" | "scheduled" }>;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private checkingSchedule = false;
  private readonly deps: ContentResearchHostDeps;
  private readonly discoverFeeds: FeedDiscoverer;

  constructor(deps: ContentResearchHostDeps) {
    this.deps = deps;
    const now = deps.now ?? (() => new Date());
    const log = deps.log ?? (() => {});
    const sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.store = deps.store ?? new ContentResearchStore(deps.workspaceDir, now);
    this.discoverFeeds = deps.discoverFeeds ?? createFeedDiscoverer();

    const hookExtractor = deps.hookExtractor;
    const sheets = deps.sheetsFactory ?? (() => ({ ok: false, state: "unconfigured" }));
    const gmail = deps.gmailFactory ?? (() => ({ ok: false, state: "unconfigured" }));
    const getOwnerEmail = deps.getOwnerEmail ?? (() => null);

    this.runner = new Runner({
      runs: deps.runs,
      module: contentResearchModule({
        store: this.store,
        adapters: deps.adapters,
        profileProjection: deps.profileProjection,
        hookExtractor,
        sheets,
        gmail,
        getOwnerEmail,
        now,
        sleep,
        runs: deps.runs,
        log,
      }),
      now,
      log,
    });

    this.backfillRunner = new Runner({
      runs: deps.runs,
      module: contentResearchBackfillModule({
        store: this.store,
        adapters: deps.adapters,
        profileProjection: deps.profileProjection,
        hookExtractor,
        sheets,
        gmail,
        getOwnerEmail,
        now,
        sleep,
        runs: deps.runs,
      }),
      now,
      log,
    });

    this.discoveryRunner = new Runner({
      runs: deps.runs,
      module: peopleDiscoveryModule({
        store: this.store,
        brandProfile: deps.getBrandProfile ?? (() => null),
        discoverer: deps.discoverer ?? {
          async discover() {
            return [];
          },
        },
        searchPublic: deps.searchPublic ?? createPublicSearch(),
        now,
      }),
      now,
      log,
    });
  }

  /**
   * The watch-creation seam (spec #134): a Named Person is created only against
   * a confirmed Profile. The projection is resolved first, so the watch's name
   * is the public-safe projection's own name and an unknown, archived, merged,
   * or privacy-deleted Profile never becomes a watch.
   */
  addPerson(input: {
    /** Optional at the type level so an absent id answers the typed refusal
        instead of a TypeError; the route coerces a missing field to "". */
    profileId?: string;
    handleHints?: NamedPerson["handleHints"];
    discoveredSourceTargets?: NamedPerson["discoveredSourceTargets"];
  }): NamedPerson {
    const profileId = input.profileId?.trim() ?? "";
    if (!profileId)
      throw new ContentResearchProfileRefusal(
        "profile-required",
        "A watch needs a confirmed Profile id.",
      );
    const projection = this.deps.profileProjection(profileId);
    if (projection?.purpose !== "public-safe")
      throw new ContentResearchProfileRefusal(
        "profile-not-found",
        "No active Person Profile with that id — create and confirm one before watching.",
      );
    return this.store.addPerson({
      profileId,
      name: projection.fullName ?? profileId,
      ...(input.handleHints ? { handleHints: input.handleHints } : {}),
      ...(input.discoveredSourceTargets
        ? { discoveredSourceTargets: input.discoveredSourceTargets }
        : {}),
    });
  }

  /** A paused watch stays configured — it is lifecycle state, not deletion. */
  pauseWatch(personId: string): NamedPerson {
    return this.store.pausePerson(personId);
  }

  /** Resuming re-resolves the Profile: a watch never reactivates against a
      Profile that is archived, merged away, or privacy-deleted. */
  resumeWatch(personId: string): NamedPerson {
    const person = this.store.getPerson(personId);
    if (!person) throw new Error(`Named Person not found: ${personId}`);
    const projection = this.deps.profileProjection(person.profileId);
    if (projection?.purpose !== "public-safe")
      throw new ContentResearchProfileRefusal(
        "profile-not-found",
        "The Profile this watch points at is no longer active — re-point or archive the watch.",
      );
    return this.store.resumePerson(personId);
  }

  /** The re-point action the lifecycle disclosure offers a paused watch
      (#134): it resolves through the same public-safe seam as creation. */
  repointWatch(personId: string, profileId?: string): NamedPerson {
    const target = profileId?.trim() ?? "";
    if (!target)
      throw new ContentResearchProfileRefusal(
        "profile-required",
        "Re-pointing a watch needs the confirmed Profile it will watch.",
      );
    const projection = this.deps.profileProjection(target);
    if (projection?.purpose !== "public-safe")
      throw new ContentResearchProfileRefusal(
        "profile-not-found",
        "No active Person Profile with that id — confirm one before re-pointing.",
      );
    return this.store.repointPerson(personId, target);
  }

  /**
   * Resolve the feeds a Named Person's known sites declare about themselves and
   * record them as `rss` Source Targets, so adding or approving a person is one
   * click and the watchlist covers wherever they publish (spec #116 stories 2
   * and 24). A site that cannot be reached simply contributes no feed: the
   * person stays watched on every surface that resolved.
   */
  async resolveSourceTargets(personId: string): Promise<NamedPerson> {
    const person = this.store.getPerson(personId);
    if (!person) throw new Error(`Named Person not found: ${personId}`);
    const targets = [...person.discoveredSourceTargets];
    const known = new Set(targets.map((target) => target.url));
    const sites = new Set<string>();
    for (const value of [
      ...person.handleHints.blogRssHints,
      ...person.discoveredSourceTargets.map((target) => target.url),
    ]) {
      try {
        sites.add(`${new URL(value).origin}/`);
      } catch {
        // a hint that is not a URL names no site to ask
      }
    }
    for (const site of sites) {
      let feeds: Awaited<ReturnType<FeedDiscoverer>>;
      try {
        feeds = await this.discoverFeeds(site);
      } catch (error) {
        this.deps.log?.(`Feed discovery failed for ${site}: ${errorMessage(error)}`);
        continue;
      }
      for (const feed of feeds) {
        if (known.has(feed.url)) continue;
        known.add(feed.url);
        targets.push({
          adapterId: "rss",
          url: feed.url,
          label: feed.title ?? `${person.name} feed`,
        });
      }
    }
    return targets.length === person.discoveredSourceTargets.length
      ? person
      : this.store.updatePersonSourceTargets(personId, targets);
  }

  /** Resolves when every enqueued Run has settled (test seam). */
  idle(): Promise<void> {
    return Promise.all([
      this.runner.idle(),
      this.backfillRunner.idle(),
      this.discoveryRunner.idle(),
    ]).then(() => undefined);
  }

  listPeople(): NamedPerson[] {
    return this.store.listPeople();
  }

  listAllPeople(): NamedPerson[] {
    return this.store.listAllPeople();
  }

  /** Every collected Source Item, for the Profile lifecycle registry's
      residual-source disclosure (it scans for documents naming a person). */
  listSourceItems(): SourceItem[] {
    return this.store.listAllItems();
  }

  archivePerson(id: string): NamedPerson {
    return this.store.archivePerson(id);
  }

  listSuggestions(): PersonSuggestion[] {
    return this.store.listSuggestions();
  }

  /**
   * Suggestion acceptance (spec #134): the operator must select an existing
   * Profile — or create and confirm one — before the watch is created. The
   * Profile is resolved here, at the same seam watch creation uses; the store
   * refuses a name-only approval outright.
   */
  decideSuggestion(
    id: string,
    decision: "approved" | "dismissed",
    reason: string | null,
    profileId?: string,
  ): PersonSuggestion {
    if (decision === "approved") {
      if (!profileId)
        throw new ContentResearchProfileRefusal(
          "profile-required",
          "Select or confirm a Profile for this suggestion before approving it.",
        );
      const projection = this.deps.profileProjection(profileId);
      if (projection?.purpose !== "public-safe")
        throw new ContentResearchProfileRefusal(
          "profile-not-found",
          "No active Person Profile with that id — create and confirm one before approving.",
        );
    }
    return this.store.decideSuggestion(id, decision, reason, profileId);
  }

  restoreSuggestion(id: string): PersonSuggestion {
    return this.store.restoreSuggestion(id);
  }

  scheduleState() {
    return this.store.scheduleState();
  }

  getDailyCheckpoint(): string | null {
    return this.store.getDailyCheckpoint();
  }

  async researchNow(
    invocation: "manual" | "scheduled" = "manual",
    period?: string,
  ): Promise<string> {
    return this.runner.startRun(
      {
        intake: CONTENT_RESEARCH_INTAKE,
        fileName: "Content Research daily",
        sourceUrl: null,
        externalId: period ?? null,
      },
      { kind: "intake", invocation },
    );
  }

  async backfillNow(windowDays: 7 | 30 | 90): Promise<string> {
    return this.backfillRunner.startRun(
      {
        intake: CONTENT_RESEARCH_BACKFILL_INTAKE,
        fileName: `Content Research backfill ${windowDays}d`,
        sourceUrl: null,
        externalId: `backfill:${windowDays}`,
      },
      { windowDays },
    );
  }
  async discoverNow(
    invocation: "manual" | "scheduled" = "manual",
    period?: string,
  ): Promise<string> {
    return this.discoveryRunner.startRun(
      {
        intake: CONTENT_RESEARCH_DISCOVERY_INTAKE,
        fileName: "People Discovery",
        sourceUrl: null,
        externalId: period ?? null,
      },
      { invocation },
    );
  }

  /**
   * The three Runners share this Module id, so the Run's own Intake — not a
   * chain of failed attempts — says which one owns it.
   */
  async retryRun(id: string): Promise<RunMeta> {
    const intake = this.deps.runs.open(id)?.read().intake;
    if (intake === CONTENT_RESEARCH_BACKFILL_INTAKE) return this.backfillRunner.retryRun(id);
    if (intake === CONTENT_RESEARCH_DISCOVERY_INTAKE) return this.discoveryRunner.retryRun(id);
    return this.runner.retryRun(id);
  }

  getIndex(): ContentResearchIndex {
    const all = this.deps.runs.list({ module: this.id, limit: 200 });
    const byPersonMap = new Map<string, ContentResearchIndex["byPerson"][number]>();
    const runs: ContentResearchIndex["runs"] = [];

    for (const summary of all.runs) {
      runs.push({
        runId: summary.id,
        intake: summary.intake,
        status: summary.status,
        createdAt: summary.createdAt,
        summary: summary.summary ?? "",
      });

      const handle = this.deps.runs.open(summary.id);
      if (!handle) continue;
      const raw = handle.readArtifact("result.json");
      if (!raw) continue;
      try {
        const result = JSON.parse(raw) as ContentResearchRunResult;
        for (const report of result.reports) {
          let entry = byPersonMap.get(report.personId);
          if (!entry) {
            entry = { personId: report.personId, personName: report.personName, reports: [] };
            byPersonMap.set(report.personId, entry);
          }
          const maxScore =
            report.items.length > 0 ? Math.max(...report.items.map((i) => i.resonanceScore)) : 0;
          entry.reports.push({
            runId: summary.id,
            generatedAt: report.generatedAt,
            resonanceScoreMax: maxScore,
            items: report.items,
          });
        }
      } catch {
        // ignore parse failure
      }
    }

    // Sort reports newest first
    for (const entry of byPersonMap.values()) {
      entry.reports.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
    }

    return { byPerson: [...byPersonMap.values()], runs };
  }

  start(): void {
    this.runner.startRecoveryLoop();
    this.backfillRunner.startRecoveryLoop();
    this.discoveryRunner.startRecoveryLoop();
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    void this.checkSchedules();
    this.scheduleTimer = setInterval(() => {
      void this.checkSchedules();
    }, 30_000);
    this.scheduleTimer.unref();
  }

  stop(): void {
    this.runner.stopRecoveryLoop();
    this.backfillRunner.stopRecoveryLoop();
    this.discoveryRunner.stopRecoveryLoop();
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  /** Daily Run at the configured local time; weekly People Discovery, same clock. */
  async checkSchedules(): Promise<void> {
    if (this.checkingSchedule || !this.deps.configStore) return;
    this.checkingSchedule = true;
    try {
      const config = this.deps.configStore.get().modules[CONTENT_RESEARCH_MODULE_ID];
      const local = DateTime.fromJSDate((this.deps.now ?? (() => new Date()))()).setZone(
        config.timeZone,
      );
      if (!local.isValid) {
        this.deps.log?.(`Content Research schedule has invalid IANA time zone: ${config.timeZone}`);
        return;
      }
      const state = this.store.scheduleState();
      const hasPeople = this.store.listPeople().length > 0;

      const dailyPeriod = local.toISODate();
      const [dailyHour, dailyMinute] = parseLocalTime(config.dailyTime);
      const dailyDue =
        local.hour > dailyHour || (local.hour === dailyHour && local.minute >= dailyMinute);
      if (
        hasPeople &&
        dailyDue &&
        state.lastSuccessfulDailyPeriod !== dailyPeriod &&
        !this.periodRunExists(CONTENT_RESEARCH_INTAKE, dailyPeriod)
      ) {
        await this.researchNow("scheduled", dailyPeriod);
      }

      const weeklyPeriod = `${local.weekYear}-W${String(local.weekNumber).padStart(2, "0")}`;
      const [weeklyHour, weeklyMinute] = parseLocalTime(config.weeklyDiscoveryTime);
      const weeklyDue =
        local.weekday > config.weeklyDiscoveryDay ||
        (local.weekday === config.weeklyDiscoveryDay &&
          (local.hour > weeklyHour || (local.hour === weeklyHour && local.minute >= weeklyMinute)));
      if (
        hasPeople &&
        weeklyDue &&
        state.lastSuccessfulDiscoveryPeriod !== weeklyPeriod &&
        !this.periodRunExists(CONTENT_RESEARCH_DISCOVERY_INTAKE, weeklyPeriod)
      ) {
        await this.discoverNow("scheduled", weeklyPeriod);
      }
    } finally {
      this.checkingSchedule = false;
    }
  }

  private periodRunExists(intake: string, period: string): boolean {
    return this.deps.runs.list({ module: this.id }).runs.some((summary) => {
      const run = this.deps.runs.open(summary.id)?.read();
      return run?.intake === intake && run.externalId === period;
    });
  }
  routes(app: FastifyInstance): void {
    app.get("/api/content-research/people", async () => this.listPeople());
    app.get("/api/content-research/people/all", async () => this.listAllPeople());

    app.post("/api/content-research/people", async (request, reply) => {
      const body = (request.body ?? {}) as { profileId?: unknown; handleHints?: unknown };
      const handleHints = (body.handleHints as NamedPerson["handleHints"] | undefined) ?? {
        blogRssHints: [],
      };
      try {
        const person = this.addPerson({
          profileId: typeof body.profileId === "string" ? body.profileId : "",
          handleHints,
        });
        /* Adding a person is one click: their sites are asked what feeds they
           publish before the answer comes back (spec #116 story 2). */
        return this.resolveSourceTargets(person.id);
      } catch (error) {
        return sendProfileOrUnknownError(reply, error);
      }
    });

    /* Archived, not deleted: the Runs that already scored this person keep
       naming someone the Workspace can still resolve. */
    app.delete("/api/content-research/people/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return this.archivePerson(id);
      } catch (error) {
        reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.get("/api/content-research/discovery/suggestions", async () => this.listSuggestions());

    app.post("/api/content-research/discovery/:id/approve", async (request, reply) => {
      const params = request.params as { id: string };
      const body = (request.body ?? {}) as { profileId?: unknown };
      try {
        const suggestion = this.decideSuggestion(
          params.id,
          "approved",
          null,
          typeof body.profileId === "string" ? body.profileId : undefined,
        );
        const person = this.listPeople().find(
          (candidate) => candidate.name.toLowerCase() === suggestion.name.toLowerCase(),
        );
        if (person) await this.resolveSourceTargets(person.id);
        return suggestion;
      } catch (error) {
        return sendProfileOrUnknownError(reply, error);
      }
    });

    /* Watch lifecycle (spec #134): pausing keeps the configuration while the
       operator resolves the Profile-side decision; resuming re-resolves the
       Profile through the projection seam. */
    app.post("/api/content-research/people/:id/pause", async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return this.pauseWatch(id);
      } catch (error) {
        return sendProfileOrUnknownError(reply, error);
      }
    });

    app.post("/api/content-research/people/:id/repoint", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { profileId?: unknown };
      try {
        return this.repointWatch(id, typeof body.profileId === "string" ? body.profileId : "");
      } catch (error) {
        return sendProfileOrUnknownError(reply, error);
      }
    });

    app.post("/api/content-research/people/:id/resume", async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return this.resumeWatch(id);
      } catch (error) {
        return sendProfileOrUnknownError(reply, error);
      }
    });

    app.post("/api/content-research/discovery/:id/dismiss", async (request, reply) => {
      const params = request.params as { id: string };
      const body = (request.body as { reason?: unknown } | null) ?? {};
      const reason = typeof body.reason === "string" ? body.reason : null;
      try {
        const result = this.decideSuggestion(params.id, "dismissed", reason);
        return result;
      } catch (error) {
        reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.post("/api/content-research/discovery/:id/restore", async (request, reply) => {
      const params = request.params as { id: string };
      try {
        const result = this.restoreSuggestion(params.id);
        return result;
      } catch (error) {
        reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });

    app.get("/api/content-research/index", async () => this.getIndex());

    app.get("/api/content-research/runs", async () => {
      const page = this.deps.runs.list({ module: this.id, limit: 50 });
      return page;
    });

    app.get("/api/content-research/report/:runId", async (request, reply) => {
      const params = request.params as { runId: string };
      const handle = this.deps.runs.open(params.runId);
      if (!handle) {
        reply.code(404).send({ error: "Run not found" });
        return;
      }
      const raw = handle.readArtifact("result.json");
      if (!raw) {
        reply.code(404).send({ error: "Result not found" });
        return;
      }
      reply.header("content-type", "application/json");
      return reply.send(raw);
    });

    app.post("/api/content-research/run", async () => {
      const id = await this.researchNow("manual");
      return { runId: id };
    });

    const backfillSchema = z.object({
      windowDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    });
    app.post("/api/content-research/backfill", async (request, reply) => {
      const parsed = backfillSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "windowDays must be 7, 30, or 90" });
        return;
      }
      const id = await this.backfillNow(parsed.data.windowDays);
      return { runId: id };
    });

    app.post("/api/content-research/discover", async () => {
      const id = await this.discoverNow("manual");
      return { runId: id };
    });

    app.get("/api/content-research/schedule", async () => this.scheduleState());
  }
}

function parseLocalTime(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return [0, 0];
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? [hour, minute] : [0, 0];
}

/**
 * Route mapping for the watch seams (spec #134): a Profile refusal answers with
 * its typed code and message — 400 when no Profile id was stated, 404 when the
 * stated one is not an active Profile — and anything else stays the plain
 * unknown-entity answer the other watchlist routes use.
 */
function sendProfileOrUnknownError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof ContentResearchProfileRefusal) {
    reply.code(error.code === "profile-required" ? 400 : 404);
    return { error: error.code, message: error.message };
  }
  reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  return reply;
}
