import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { YoutubeChannel, YoutubeRunResult } from "@chief-of-staff-demo/shared";
import { Runner } from "../../../apps/server/src/engine/runner";
import type { YouTubeClient } from "../../../apps/server/src/modules/youtube/client";
import type {
  SheetsAccess,
  SheetsClient,
} from "../../../apps/server/src/modules/youtube/spreadsheet";
import { YoutubeIntake, dueNow } from "../../../apps/server/src/modules/youtube/intake";
import {
  YOUTUBE_INTAKE,
  YOUTUBE_MODULE_ID,
  YOUTUBE_MODULE_VERSION,
  youtubeTrendsModule,
  type ClientAccess,
  type YoutubeInput,
} from "../../../apps/server/src/modules/youtube/module";
import { TrendIndex } from "../../../apps/server/src/modules/youtube/trend";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

/**
 * The Module driven by its own `run` over a temporary Workspace, with fakes only
 * at the edges the app does not own: YouTube, and the clock. Everything asserted
 * is something a person could observe — the Run's status, its events, its
 * result, and the trend derived from them.
 */
const CHANNEL: YoutubeChannel = {
  id: "UC_found42",
  handle: "@found42",
  title: "Found42",
  uploadsPlaylistId: "UU_found42",
  addedAt: "2026-08-01T00:00:00.000Z",
};

interface FakeYouTube extends YouTubeClient {
  uploads: string[];
  views: Record<string, number>;
  /** Ids YouTube will not answer for — deleted, private, gone. */
  unavailable: Set<string>;
  /** Thrown by every call, when set. */
  throws: Error | null;
  calls: { uploads: number; statistics: number };
}

function fakeYouTube(): FakeYouTube {
  const client: FakeYouTube = {
    uploads: ["v1", "v2"],
    views: { v1: 100, v2: 40 },
    unavailable: new Set(),
    throws: null,
    calls: { uploads: 0, statistics: 0 },
    resolveChannel: async () => null,
    listUploads: async () => {
      client.calls.uploads += 1;
      if (client.throws) {
        throw client.throws;
      }
      return client.uploads;
    },
    videoStatistics: async (ids) => {
      client.calls.statistics += 1;
      if (client.throws) {
        throw client.throws;
      }
      const answered = ids.filter((id) => !client.unavailable.has(id));
      return {
        videos: answered.map((id) => ({
          id,
          title: `Video ${id}`,
          viewCount: client.views[id] ?? 0,
        })),
        failedIds: ids.filter((id) => client.unavailable.has(id)),
      };
    },
  };
  return client;
}

/** Google's own refusal when the consent screen never granted the scope. */
const SCOPE_MISSING = Object.assign(new Error("Request had insufficient authentication scopes."), {
  response: {
    data: {
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        errors: [{ reason: "insufficientPermissions" }],
      },
    },
  },
});

/** The spreadsheet as the Module sees it: what was appended, and where. */
interface FakeSheets extends SheetsClient {
  tabs: string[];
  appended: { tab: string; rows: (string | number)[][] }[];
  /** Thrown by every write, when set. */
  throws: Error | null;
}

function fakeSheets(): FakeSheets {
  const client: FakeSheets = {
    tabs: [],
    appended: [],
    throws: null,
    createSpreadsheet: async () => ({ id: "sheet-1", url: "https://docs.google.com/x" }),
    ensureTab: async (_id, title) => {
      if (client.throws) {
        throw client.throws;
      }
      if (!client.tabs.includes(title)) {
        client.tabs.push(title);
      }
    },
    appendRows: async (_id, tab, rows) => {
      if (client.throws) {
        throw client.throws;
      }
      client.appended.push({ tab, rows });
    },
    isMissing: (error) => (error as { code?: number }).code === 404,
  };
  return client;
}

let workspaceDir: string;
let runs: Runs;
let youtube: FakeYouTube;
let access: ClientAccess;
let sheets: FakeSheets;
let sheetsAccess: () => SheetsAccess;
let channels: YoutubeChannel[];
let invalidated: number;

function runner(): Runner<YoutubeInput> {
  return new Runner({
    runs,
    module: youtubeTrendsModule({
      getClient: () => access,
      getSheets: sheetsAccess,
      /* The real classifier's verdict: a test cannot decide `expired` into
         existence, and a 403 about scopes says nothing about the token. */
      observe: () => null,
      getChannels: () => channels,
      invalidateTrend: () => {
        invalidated += 1;
      },
    }),
  });
}

async function measure(day = "2026-08-23"): Promise<string> {
  const engine = runner();
  const id = await engine.startRun(
    { intake: YOUTUBE_INTAKE, sourceUrl: null, externalId: day },
    { kind: "measure" },
  );
  await engine.idle();
  return id;
}

const resultOf = (id: string): YoutubeRunResult => runs.detail(id)!.result as YoutubeRunResult;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-youtube-"));
  runs = openRuns(workspaceDir);
  youtube = fakeYouTube();
  access = { ok: true, client: youtube };
  sheets = fakeSheets();
  /* No spreadsheet by default: the operator has not asked for one, and the
     trend is complete without it. */
  sheetsAccess = () => ({ ok: true, client: sheets, spreadsheet: null });
  channels = [CHANNEL];
  invalidated = 0;
});

/** With a spreadsheet configured, as it is once the operator creates one. */
function withSpreadsheet(): void {
  sheetsAccess = () => ({
    ok: true,
    client: sheets,
    spreadsheet: { id: "sheet-1", url: "https://docs.google.com/x" },
  });
}

describe("the daily Run", () => {
  it("records every video on the channel, and says so in one line", async () => {
    withSpreadsheet();
    const id = await measure();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    expect(detail.summary).toBe("1 channel, 2 videos");
    expect(resultOf(id).day).toBe("2026-08-23");
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "channel_enumerated",
      "stage_started",
      "channel_counted",
      "stage_started",
      "rows_appended",
      "run_done",
    ]);
    const result = resultOf(id);
    expect(result.channels[0]).toMatchObject({
      channelId: "UC_found42",
      handle: "@found42",
      title: "Found42",
      failedIds: [],
    });
    expect(result.channels[0].videos).toEqual([
      { id: "v1", title: "Video v1", viewCount: 100 },
      { id: "v2", title: "Video v2", viewCount: 40 },
    ]);
    /* The day's counts are the Run's own file, so the derived view is stale the
       moment they land and refreshes itself once. */
    expect(invalidated).toBe(1);
  });

  it("reads the back catalogue too, in chunks, with no cutoff", async () => {
    withSpreadsheet();
    youtube.uploads = Array.from({ length: 120 }, (_, index) => `v${index}`);
    youtube.views = Object.fromEntries(youtube.uploads.map((id, index) => [id, index]));

    const id = await measure();
    expect(resultOf(id).channels[0].videos).toHaveLength(120);
    /* Fifty per call: a "most recent fifty" window would silently stop tracking
       the part of a channel a trend is most interesting for. */
    expect(youtube.calls.statistics).toBe(3);
  });

  it("names a video YouTube will not answer for, and finishes anyway", async () => {
    withSpreadsheet();
    youtube.unavailable = new Set(["v2"]);

    const id = await measure();
    const detail = runs.detail(id)!;
    /* Three deleted videos must not look like a broken automation. */
    expect(detail.status).toBe("done");
    expect(detail.summary).toBe("1 channel, 1 video, 1 unavailable");
    expect(resultOf(id).channels[0].failedIds).toEqual(["v2"]);
    expect(detail.events.find((event) => event.type === "videos_unavailable")?.detail).toEqual({
      channelId: "UC_found42",
      ids: ["v2"],
    });
  });

  it("fails the Run when the saved sign-in lacks the scope, naming what to add", async () => {
    youtube.throws = SCOPE_MISSING;

    const id = await measure();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("enumerate");
    /* "Nothing was measured" must never look like "nothing changed", and the
       fix must not need a developer. */
    expect(detail.failureHint).toContain("youtube.readonly");
    expect(detail.failureHint).toContain("Data Access");
  });

  it("fails the Run when there is no connection to call with", async () => {
    access = { ok: false, state: "expired" };

    const id = await measure();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("failed");
    expect(detail.connectionState).toBe("expired");
    expect(detail.failureHint).toContain("Reconnect in Settings");
    expect(detail.events.map((event) => event.type)).toContain("google_unavailable");
  });

  it("retries in place, from the top, rather than as a second Run for the day", async () => {
    withSpreadsheet();
    youtube.throws = SCOPE_MISSING;
    const id = await measure();
    expect(runs.detail(id)!.status).toBe("failed");

    youtube.throws = null;
    const engine = runner();
    await engine.retryRun(id);
    await engine.idle();

    expect(runs.detail(id)!.status).toBe("done");
    /* One Run for the day, whatever happened to it. */
    expect(runs.list().runs).toHaveLength(1);
  });

  it("recovers an orphaned measurement in place from enumeration", async () => {
    withSpreadsheet();
    const orphan = runs.create({
      module: YOUTUBE_MODULE_ID,
      moduleVersion: YOUTUBE_MODULE_VERSION,
      intake: YOUTUBE_INTAKE,
      sourceUrl: null,
      externalId: "2026-08-23",
    });
    orphan.started("fetch");
    const afterRestart = runner();

    expect(await afterRestart.recoverRuns()).toBe(1);
    await afterRestart.idle();

    expect(runs.detail(orphan.id)?.status).toBe("done");
    expect(runs.list({ module: YOUTUBE_MODULE_ID }).runs).toHaveLength(1);
    expect(
      runs.detail(orphan.id)?.events.find((event) => event.type === "run_recovered")?.detail,
    ).toEqual({
      fromStage: "enumerate",
      previousStatus: "running",
      reason: "no_measured_snapshot_survived_restart",
    });
  });

  it("recovers orphaned publication from the measured counts without reading YouTube again", async () => {
    withSpreadsheet();
    const orphan = runs.create({
      module: YOUTUBE_MODULE_ID,
      moduleVersion: YOUTUBE_MODULE_VERSION,
      intake: YOUTUBE_INTAKE,
      sourceUrl: null,
      externalId: "2026-08-23",
    });
    orphan.writeArtifact(
      "result.json",
      JSON.stringify({
        version: 1,
        day: "2026-08-23",
        measuredAt: "2026-08-23T12:00:00.000Z",
        channels: [
          {
            channelId: CHANNEL.id,
            handle: CHANNEL.handle,
            title: CHANNEL.title,
            videos: [{ id: "v1", title: "Video v1", viewCount: 100 }],
            failedIds: [],
          },
        ],
      }),
    );
    orphan.started("publish");
    const afterRestart = runner();

    expect(await afterRestart.recoverRuns()).toBe(1);
    await afterRestart.idle();

    expect(runs.detail(orphan.id)?.status).toBe("done");
    expect(youtube.calls).toEqual({ uploads: 0, statistics: 0 });
    expect(sheets.appended).toHaveLength(1);
    expect(
      runs.detail(orphan.id)?.events.find((event) => event.type === "run_recovered")?.detail,
    ).toEqual({
      fromStage: "publish",
      previousStatus: "running",
      reason: "measured_snapshot_survived_restart",
    });
  });
});

describe("the spreadsheet", () => {
  it("keeps the measured result but fails publish visibly until a spreadsheet exists", async () => {
    const id = await measure();
    expect(runs.detail(id)!.events.map((event) => event.type)).not.toContain("rows_appended");
    expect(sheets.appended).toEqual([]);
    expect(runs.detail(id)).toMatchObject({
      status: "failed",
      failedStage: "publish",
      failureHint: expect.stringContaining("Create the spreadsheet"),
    });
    expect(runs.open(id)!.readArtifact("result.json")).not.toBeNull();
  });

  it("appends the day as rows, one tab per channel, long rather than wide", async () => {
    withSpreadsheet();
    const id = await measure("2026-08-23");

    expect(sheets.tabs).toEqual(["Found42"]);
    expect(sheets.appended).toEqual([
      {
        tab: "Found42",
        rows: [
          ["2026-08-23", "v1", "Video v1", 100],
          ["2026-08-23", "v2", "Video v2", 40],
        ],
      },
    ]);
    expect(runs.detail(id)!.events.find((event) => event.type === "rows_appended")?.detail).toEqual(
      { channelId: "UC_found42", tab: "Found42", rows: 2 },
    );
  });

  it("retries a publish failure from the counts already fetched, reading YouTube no second time", async () => {
    withSpreadsheet();
    sheets.throws = new Error("Sheets is having a moment");
    const id = await measure();

    const failed = runs.detail(id)!;
    expect(failed.status).toBe("failed");
    expect(failed.failedStage).toBe("publish");
    expect(failed.failureHint).toContain("will not be fetched again");
    const statisticsCalls = youtube.calls.statistics;

    sheets.throws = null;
    const engine = runner();
    await engine.retryRun(id);
    await engine.idle();

    expect(runs.detail(id)!.status).toBe("done");
    /* The whole point: a retry must not mix two snapshots, taken hours apart,
       into one day of the trend. */
    expect(youtube.calls.statistics).toBe(statisticsCalls);
    expect(sheets.appended).toHaveLength(1);
  });

  it("fails the Run when the spreadsheet has been deleted, rather than creating a second", async () => {
    withSpreadsheet();
    sheets.throws = Object.assign(new Error("Requested entity was not found."), { code: 404 });

    const id = await measure();
    const detail = runs.detail(id)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("publish");
    /* Two spreadsheets and no idea which is live is a worse failure than a red
       Run, so this points at the action that makes one and stops. */
    expect(detail.failureHint).toContain("Create a new one in Settings");
    expect(sheets.appended).toEqual([]);
  });
});

describe("one Run per calendar day", () => {
  const at = (iso: string) => new Date(iso);

  function intake(now: () => Date, started: string[]): YoutubeIntake {
    return new YoutubeIntake({
      getChannels: () => channels,
      workspaceDir,
      startRun: async (day) => {
        started.push(day);
        return `run_2026010${started.length}-000000_0000000${started.length}`;
      },
      now,
      log: () => {},
    });
  }

  it("waits until six in the morning, then records the day once", () => {
    /* An interval timer would be simply wrong here: a restart resets it, so a
       machine restarted every few days would never fire. */
    expect(dueNow(at("2026-08-23T05:59:00"), null)).toBe(false);
    expect(dueNow(at("2026-08-23T06:00:00"), null)).toBe(true);
    /* A machine woken at nine still records that day. */
    expect(dueNow(at("2026-08-23T09:00:00"), null)).toBe(true);
    expect(dueNow(at("2026-08-23T09:00:00"), "2026-08-23")).toBe(false);
    expect(dueNow(at("2026-08-24T09:00:00"), "2026-08-23")).toBe(true);
  });

  it("starts exactly one Run on a due day, whatever else ticks", async () => {
    const started: string[] = [];
    let now = at("2026-08-23T07:00:00");
    const daily = intake(() => now, started);

    expect(await daily.tick()).not.toBeNull();
    expect(await daily.tick()).toBeNull();
    now = at("2026-08-23T23:30:00");
    expect(await daily.tick()).toBeNull();
    expect(started).toHaveLength(1);

    now = at("2026-08-24T06:30:00");
    expect(await daily.tick()).not.toBeNull();
    /* The day the Intake decided travels with the Run, so nothing downstream
       re-derives it from a clock that has since moved on. */
    expect(started).toEqual(["2026-08-23", "2026-08-24"]);
  });

  it("allows repeat manual runs on a day already recorded, so intra-day view changes are visible", async () => {
    /* View counts move through the day, so a person may measure whenever they
       like. The automatic schedule stays at one Run per day; only the manual
       trigger repeats, and every Run is kept because each is a measurement. */
    const started: string[] = [];
    const now = at("2026-08-23T07:00:00");
    const daily = intake(() => now, started);
    await daily.runNow();
    await daily.runNow();
    await daily.runNow();

    expect(started).toEqual(["2026-08-23", "2026-08-23", "2026-08-23"]);
    expect(daily.status()).toEqual({ lastRunDay: "2026-08-23", todayRecorded: true });
  });

  it("keeps the automatic schedule at one Run per day", async () => {
    const started: string[] = [];
    let now = at("2026-08-23T07:00:00");
    const daily = intake(() => now, started);
    expect(await daily.tick()).not.toBeNull();
    await daily.runNow();
    now = at("2026-08-23T18:00:00");
    expect(await daily.tick()).toBeNull();
    expect(started).toEqual(["2026-08-23", "2026-08-23"]);
  });

  it("does not burn the day when there is nothing to measure yet", async () => {
    channels = [];
    const started: string[] = [];
    let now = at("2026-08-23T07:00:00");
    const daily = intake(() => now, started);

    expect(await daily.tick()).toBeNull();
    /* Adding a channel this afternoon must still record today. */
    channels = [CHANNEL];
    now = at("2026-08-23T14:00:00");
    expect(await daily.tick()).not.toBeNull();
    expect(started).toHaveLength(1);
  });
});

describe("the trend, derived from the Runs", () => {
  function index(): TrendIndex {
    return new TrendIndex({
      runs,
      getChannels: () => channels,
      status: () => ({ lastRunDay: null, todayRecorded: false }),
      spreadsheet: () => null,
    });
  }

  /** A Run whose result says it measured `day`, as the daily Run writes it. */
  function recordDay(day: string, views: Record<string, number>): void {
    const handle = runs.create({
      module: "youtube-trends",
      moduleVersion: 1,
      intake: YOUTUBE_INTAKE,
      sourceUrl: null,
      externalId: null,
    });
    const result: YoutubeRunResult = {
      version: 1,
      day,
      measuredAt: `${day}T07:00:00.000Z`,
      channels: [
        {
          channelId: CHANNEL.id,
          handle: CHANNEL.handle,
          title: CHANNEL.title,
          videos: Object.entries(views).map(([id, viewCount]) => ({
            id,
            title: `Video ${id}`,
            viewCount,
          })),
          failedIds: [],
        },
      ],
    };
    handle.writeArtifact("result.json", JSON.stringify(result));
    handle.finished({ status: "done", summary: "1 channel, 2 videos" });
  }

  it("reads a channel's total and each video's line out of the Runs", () => {
    recordDay("2026-08-01", { v1: 100, v2: 40 });
    recordDay("2026-08-08", { v1: 150, v2: 60 });

    const trend = index().read();
    expect(trend.lastDay).toBe("2026-08-08");
    const channel = trend.channels[0];
    expect(channel.totals).toEqual([
      { day: "2026-08-01", measuredAt: "2026-08-01T07:00:00.000Z", views: 140 },
      { day: "2026-08-08", measuredAt: "2026-08-08T07:00:00.000Z", views: 210 },
    ]);
    expect(channel.latest).toBe(210);
    /* Seven days back is a measurement, not an interpolation. */
    expect(channel.change7).toBe(70);
    expect(channel.change30).toBeNull();
    /* The videos carrying the channel first. */
    expect(channel.videos.map((video) => [video.id, video.latest, video.change7])).toEqual([
      ["v1", 150, 50],
      ["v2", 60, 20],
    ]);
  });

  it("reports a day the machine was off as a gap, never as a line through it", () => {
    recordDay("2026-08-01", { v1: 100 });
    // 2026-08-02: nothing ran. No API returns a past day's view count.
    recordDay("2026-08-03", { v1: 130 });

    const points = index().read().channels[0].totals;
    expect(points.map((point) => point.day)).toEqual(["2026-08-01", "2026-08-03"]);
    expect(points.some((point) => point.day === "2026-08-02")).toBe(false);
  });

  it("says something useful before there is any data", () => {
    const trend = index().read();
    expect(trend.channels).toHaveLength(1);
    expect(trend.channels[0]).toMatchObject({ title: "Found42", totals: [], videos: [] });
    expect(trend.lastDay).toBeNull();
  });

  it("drops a removed channel from the view and erases none of its history", () => {
    recordDay("2026-08-01", { v1: 100 });
    channels = [];
    expect(index().read().channels).toEqual([]);

    /* Re-added, it resumes against the history that was there all along —
       with the gap visible rather than a fabricated line across it. */
    channels = [CHANNEL];
    recordDay("2026-08-20", { v1: 400 });
    expect(
      index()
        .read()
        .channels[0].totals.map((point) => point.day),
    ).toEqual(["2026-08-01", "2026-08-20"]);
  });

  it("caches the scan of the Runs, and nothing else", () => {
    recordDay("2026-08-01", { v1: 100 });
    const trend = index();
    expect(trend.read().channels[0].latest).toBe(100);

    recordDay("2026-08-02", { v1: 120 });
    /* Nothing told it, so it answers what it already knew — which is the whole
       point of one invalidator. */
    expect(trend.read().channels[0].latest).toBe(100);
    trend.invalidate();
    expect(trend.read().channels[0].latest).toBe(120);
  });

  it("reads everything that is not a measured day fresh, so one invalidator is enough", () => {
    /* The cache covering more than its one invalidator knows about is the drift
       this rule exists to prevent: a channel added or removed, or a spreadsheet
       created, changes the answer without any day being measured. */
    recordDay("2026-08-01", { v1: 100 });
    const trend = index();
    expect(trend.read().channels).toHaveLength(1);

    channels = [];
    expect(trend.read().channels).toEqual([]);

    channels = [CHANNEL];
    expect(trend.read().channels).toHaveLength(1);
  });
});
