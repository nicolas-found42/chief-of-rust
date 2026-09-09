import type { FastifyInstance } from "fastify";
import {
  AddChannelSchema,
  type AppConfig,
  type RunMeta,
  type YoutubeChannel,
} from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../../config.js";
import type { HostedModule } from "../../engine/host.js";
import { Runner } from "../../engine/runner.js";
import { googleFailureHint, type GoogleConnection } from "../../google/connection.js";
import type { Runs } from "../../runs.js";
import {
  appendRows,
  createSpreadsheet,
  ensureTab,
  isSpreadsheetMissing,
} from "../../google/sheets.js";
import type { GoogleAuth } from "../../google/oauth.js";
import { ChannelUrlError, parseChannelUrl } from "../../source-adapters/youtube-channels.js";
import { youtubeClient, type YouTubeClient } from "./client.js";
import {
  SPREADSHEET_HEADER,
  SPREADSHEET_TITLE,
  tabNameFor,
  type SheetsAccess,
  type SheetsClient,
} from "./spreadsheet.js";
import { NothingToMeasureError, YoutubeIntake } from "./intake.js";
import {
  YOUTUBE_INTAKE,
  YOUTUBE_MODULE_ID,
  YOUTUBE_MODULE_VERSION,
  youtubeTrendsModule,
  type ClientAccess,
  type YoutubeInput,
} from "./module.js";
import { TrendIndex } from "./trend.js";

export interface YoutubeHostDeps {
  runs: Runs;
  configStore: ConfigStore;
  workspaceDir: string;
  port: number;
  google: GoogleConnection;
  log: (message: string) => void;
  /** Test seam: the clock the daily due-check reads. */
  now?: () => Date;
  /** Test seam: the YouTube client, as the Drive Intake takes a Drive client. */
  getClient?: (auth: GoogleAuth) => YouTubeClient;
  /** Test seam: the Sheets Output Adapter. */
  getSheetsClient?: (auth: GoogleAuth) => SheetsClient;
}

/**
 * YouTube Trends as the Shell holds it: its Runs, its daily Intake, its derived
 * trend, and the endpoints its own tab calls. The Shell knows none of those
 * nouns — it holds a `HostedModule` and nothing more.
 */
export class YoutubeHost implements HostedModule {
  readonly id = YOUTUBE_MODULE_ID;
  readonly version = YOUTUBE_MODULE_VERSION;
  private readonly runner: Runner<YoutubeInput>;
  private readonly intake: YoutubeIntake;
  private readonly trend: TrendIndex;

  constructor(private readonly deps: YoutubeHostDeps) {
    this.runner = new Runner({
      runs: deps.runs,
      module: youtubeTrendsModule({
        getClient: () => this.client(),
        getSheets: () => this.sheets(),
        observe: (error) => deps.google.observe(error),
        getChannels: () => this.channels(),
        invalidateTrend: () => this.trend.invalidate(),
      }),
      log: deps.log,
    });
    this.intake = new YoutubeIntake({
      getChannels: () => this.channels(),
      workspaceDir: deps.workspaceDir,
      /* The day rides on the Run record as its external id: the calendar day is
         what this Run is about in the world outside, and stamping it once is
         what keeps one Run per day true across midnight. */
      startRun: (day) =>
        this.runner.startRun(
          { intake: YOUTUBE_INTAKE, sourceUrl: null, externalId: day },
          { kind: "measure" },
        ),
      now: deps.now ?? (() => new Date()),
      log: deps.log,
    });
    this.trend = new TrendIndex({
      runs: deps.runs,
      getChannels: () => this.channels(),
      status: () => this.intake.status(),
      spreadsheet: () => this.spreadsheet(),
    });
  }

  retryRun(id: string): Promise<RunMeta> {
    return this.runner.retryRun(id);
  }

  /** Resolves when every enqueued Run has settled (test seam). */
  idle(): Promise<void> {
    return this.runner.idle();
  }

  start(): void {
    this.runner.startRecoveryLoop();
    this.intake.start();
  }

  stop(): void {
    this.runner.stopRecoveryLoop();
    this.intake.stop();
  }

  routes(app: FastifyInstance): void {
    /* Read-only, from Runs on disk. No Google call, so an expired connection
       does not blank a page of data already measured. */
    app.get("/api/youtube/trends", async () => this.trend.read());

    app.post("/api/youtube/channels", async (request, reply) => {
      const parsed = AddChannelSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "A channel URL is required." });
        return;
      }
      let ref;
      try {
        ref = parseChannelUrl(parsed.data.url);
      } catch (error) {
        /* Checked while the operator is still looking at it: a typo is their
           problem now rather than a silent gap in tomorrow's data. */
        reply.code(400).send({
          error: error instanceof ChannelUrlError ? error.message : String(error),
        });
        return;
      }
      const access = this.client();
      if (!access.ok) {
        reply.code(400).send({ error: googleFailureHint(access.state) });
        return;
      }
      let resolved;
      try {
        resolved = await access.client.resolveChannel(ref);
      } catch (error) {
        this.deps.google.observe(error);
        reply.code(502).send({
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!resolved) {
        reply.code(404).send({ error: "YouTube knows no channel at that address." });
        return;
      }
      const channels = this.channels();
      if (channels.some((channel) => channel.id === resolved.id)) {
        reply.code(409).send({ error: `${resolved.title} is already being tracked.` });
        return;
      }
      /* Stored resolved, once: no Run ever re-resolves or guesses. */
      const channel: YoutubeChannel = { ...resolved, addedAt: new Date().toISOString() };
      this.setChannels([...channels, channel]);
      await this.addTabFor(channel);
      reply.code(201);
      return { channel };
    });

    /* Stops future work and erases nothing: past Runs are immutable, and
       re-adding resumes with a visible gap rather than a fabricated line. */
    app.delete("/api/youtube/channels/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const channels = this.channels();
      if (!channels.some((channel) => channel.id === id)) {
        reply.code(404).send({ error: "That channel is not being tracked." });
        return;
      }
      this.setChannels(channels.filter((channel) => channel.id !== id));
      return { removed: id };
    });

    /**
     * The Module creates its own spreadsheet, names it, and hands back the
     * link. Offered as an action rather than performed silently by the first
     * Run: setup belongs in the settings flow, and a link buried in a Run
     * record scrolls out of Home's feed. It refuses to make a second one — two
     * spreadsheets and no way to tell which is live is the failure this avoids.
     */
    app.post("/api/youtube/spreadsheet", async (_request, reply) => {
      const existing = this.spreadsheet();
      if (existing) {
        reply.code(409).send({
          error: "A spreadsheet already exists for this Module.",
          spreadsheet: existing,
        });
        return;
      }
      const access = this.sheets();
      if (!access.ok) {
        reply.code(400).send({ error: googleFailureHint(access.state) });
        return;
      }
      let created;
      try {
        created = await access.client.createSpreadsheet(SPREADSHEET_TITLE);
        /* One tab per channel, created with the spreadsheet for the channels
           already being tracked. */
        for (const channel of this.channels()) {
          await access.client.ensureTab(created.id, tabNameFor(channel), SPREADSHEET_HEADER);
        }
      } catch (error) {
        this.deps.google.observe(error);
        reply.code(502).send({
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.deps.configStore.setModuleConfig(YOUTUBE_MODULE_ID, {
        ...this.config(),
        spreadsheetId: created.id,
        spreadsheetUrl: created.url,
      });
      reply.code(201);
      return { spreadsheet: created };
    });

    app.post("/api/youtube/run", async (_request, reply) => {
      try {
        return { runId: await this.intake.runNow() };
      } catch (error) {
        if (error instanceof NothingToMeasureError) {
          reply.code(400).send({ error: error.message });
          return;
        }
        throw error;
      }
    });
  }

  /**
   * One tab per channel, created when the channel is added. `publish` ensures
   * it too — a channel added before the spreadsheet existed has none — so a
   * failure here costs the operator nothing but the tab appearing a day later,
   * and must not stop the channel being tracked.
   */
  private async addTabFor(channel: YoutubeChannel): Promise<void> {
    const access = this.sheets();
    if (!access.ok || access.spreadsheet === null) {
      return;
    }
    try {
      await access.client.ensureTab(access.spreadsheet.id, tabNameFor(channel), SPREADSHEET_HEADER);
    } catch (error) {
      this.deps.log(
        `Could not add a spreadsheet tab for ${channel.title}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private channels(): YoutubeChannel[] {
    return this.config().channels;
  }

  private config(): AppConfig["modules"]["youtube-trends"] {
    return this.deps.configStore.get().modules[YOUTUBE_MODULE_ID];
  }

  private setChannels(channels: YoutubeChannel[]): void {
    /* No invalidation: the trend reads the channel list fresh on every read, so
       only the Stage that writes a day's counts ever invalidates the scan. */
    this.deps.configStore.setModuleConfig(YOUTUBE_MODULE_ID, { ...this.config(), channels });
  }

  /**
   * The Shell holds the authorization; this Module makes its own calls with it
   * (ADR-0018). Never touches the network — the state is decided from what is
   * stored, exactly as the outputs surface decides it.
   */
  /** The link the Module keeps somewhere permanent, or null before it made one. */
  private spreadsheet(): { id: string; url: string } | null {
    const { spreadsheetId, spreadsheetUrl } = this.config();
    return spreadsheetId ? { id: spreadsheetId, url: spreadsheetUrl } : null;
  }

  private sheetsClient(auth: GoogleAuth): SheetsClient {
    return (
      this.deps.getSheetsClient?.(auth) ?? {
        createSpreadsheet: (title) => createSpreadsheet(auth, title),
        ensureTab: (id, title, header) => ensureTab(auth, id, title, header),
        appendRows: (id, tab, rows) => appendRows(auth, id, tab, rows),
        isMissing: isSpreadsheetMissing,
      }
    );
  }

  private sheets(): SheetsAccess {
    const access = this.deps.google.auth();
    if (!access.ok) {
      return { ok: false, state: access.state };
    }
    return {
      ok: true,
      client: this.sheetsClient(access.auth),
      spreadsheet: this.spreadsheet(),
    };
  }

  private client(): ClientAccess {
    const access = this.deps.google.auth();
    if (!access.ok) {
      return { ok: false, state: access.state };
    }
    const build = this.deps.getClient ?? youtubeClient;
    return { ok: true, client: build(access.auth) };
  }
}
