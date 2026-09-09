import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { YoutubeChannel } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "../../../apps/server/src/config";
import type { YouTubeClient } from "../../../apps/server/src/modules/youtube/client";
import { YoutubeHost } from "../../../apps/server/src/modules/youtube/host";
import { YOUTUBE_MODULE_ID } from "../../../apps/server/src/modules/youtube/module";
import type { SheetsClient } from "../../../apps/server/src/modules/youtube/spreadsheet";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

/**
 * The clean-output contract the consolidation spec puts on YouTube Trends:
 * post-reset setup never restores the old spreadsheet destination, and a clean
 * output writes only to the newly created spreadsheet — the old remote Sheet is
 * neither written to nor reconciled (spec: "old remote outputs are neither
 * cleared nor reconciled").
 *
 * The reset itself is the cutover's job; what this suite pins is the Module's
 * side of it, over a real server and a fake Sheets adapter that records every
 * spreadsheet id it is ever asked to touch. The pre-reset state — a channel and
 * a spreadsheet the app used to write to — is set up, then erased exactly the
 * way the migration inventory classifies `modules.youtube-trends.*` (channels
 * and the spreadsheet destination are disposable product state, so the reset
 * leaves the Module's config empty and runs gone). Everything after that point
 * must name the new spreadsheet and never the old id.
 */
const PORT = 4331;

let app: FastifyInstance;
let workspaceDir: string;
let configStore: ConfigStore;
let host: YoutubeHost;
let runs: Runs;

/** Every spreadsheet id each call named, in order. The old sheet must never appear. */
let created: string[];
let ensuredTabs: string[];
let appendedTo: string[];
/** When set, the next `appendRows` call fails once — a publish failure to retry. */
let failNextAppend: { error: unknown } | null;

const client: YouTubeClient = {
  resolveChannel: async (ref) =>
    ref.value === "@found42"
      ? { id: "UC_found42", handle: "@found42", title: "Found42", uploadsPlaylistId: "UU_found42" }
      : null,
  listUploads: async () => [],
  videoStatistics: async () => ({ videos: [], failedIds: [] }),
};

const sheets: SheetsClient = {
  createSpreadsheet: async () => {
    const id = `sheet-${created.length + 1}`;
    created.push(id);
    return { id, url: `https://docs.google.com/${id}` };
  },
  ensureTab: async (id, title) => {
    ensuredTabs.push(id);
    if (!tabsOf(id)) tabs.push(`${id}:${title}`);
  },
  appendRows: async (id) => {
    appendedTo.push(id);
    if (failNextAppend) {
      const error = failNextAppend.error;
      failNextAppend = null;
      throw error;
    }
  },
  isMissing: () => false,
};

let tabs: string[];
function tabsOf(id: string): string | undefined {
  return tabs.find((entry) => entry.startsWith(`${id}:`));
}

/** The module config the reset leaves: everything product-shaped erased. */
function resetModuleConfig(): void {
  configStore.setModuleConfig(YOUTUBE_MODULE_ID, {
    channels: [],
    spreadsheetId: "",
    spreadsheetUrl: "",
  });
}

/** The pre-reset state: a tracked channel and the spreadsheet the app wrote to. */
function seedPreResetState(): void {
  const channel: YoutubeChannel = {
    id: "UC_found42",
    handle: "@found42",
    title: "Found42",
    uploadsPlaylistId: "UU_found42",
    addedAt: new Date("2026-08-01T09:00:00").toISOString(),
  };
  configStore.setModuleConfig(YOUTUBE_MODULE_ID, {
    channels: [channel],
    spreadsheetId: "sheet-old",
    spreadsheetUrl: "https://docs.google.com/sheet-old",
  });
}

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-youtube-clean-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  created = [];
  tabs = [];
  ensuredTabs = [];
  appendedTo = [];
  failNextAppend = null;

  runs = openRuns(workspaceDir);
  host = new YoutubeHost({
    runs,
    configStore,
    workspaceDir,
    port: PORT,
    google: fromPartial({
      auth: () => ({ ok: true, auth: {} }),
      observe: () => null,
    }),
    log: () => {},
    now: () => new Date("2026-09-01T09:00:00"),
    getClient: () => client,
    getSheetsClient: () => sheets,
  });

  app = fastify({ logger: false });
  host.routes(app);
  await app.ready();
});

afterEach(async () => {
  host.stop();
  await app.close();
});

describe("post-reset clean output", () => {
  it("restores no spreadsheet destination and writes only to the newly created one", async () => {
    seedPreResetState();
    resetModuleConfig();

    /* Nothing auto-restored: before the operator sets anything up the Module
       has no destination at all, old or new. */
    const bare = (await app.inject({ method: "GET", url: "/api/youtube/trends" })).json();
    expect(bare.spreadsheet).toBeNull();

    /* Clean setup: one new spreadsheet, created from an empty config. */
    const made = await app.inject({ method: "POST", url: "/api/youtube/spreadsheet" });
    expect(made.statusCode).toBe(201);
    expect(made.json().spreadsheet.id).toBe("sheet-1");
    expect(created).toEqual(["sheet-1"]);

    /* A measurement after setup appends to the new spreadsheet, and to nothing
       else — the old remote Sheet is neither written to nor reconciled. */
    await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });
    await app.inject({ method: "POST", url: "/api/youtube/run" });
    await host.idle();

    expect(appendedTo).toEqual(["sheet-1"]);
    expect(ensuredTabs.every((id) => id === "sheet-1")).toBe(true);
    expect(tabsOf("sheet-old")).toBeUndefined();
  });

  it("keeps the retry receipt pointed at the new spreadsheet only", async () => {
    seedPreResetState();
    resetModuleConfig();

    const made = await app.inject({ method: "POST", url: "/api/youtube/spreadsheet" });
    expect(made.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });

    /* The publish fails once — the measured snapshot is durable, so the retry
       resumes from it rather than re-fetching, and the receipt names the new
       spreadsheet throughout. */
    failNextAppend = { error: new Error("Sheets unavailable") };
    await app.inject({ method: "POST", url: "/api/youtube/run" });
    await host.idle();

    const trendRuns = runs.list({ module: YOUTUBE_MODULE_ID }).runs;
    const failed = trendRuns.find((meta) => meta.status === "failed");
    /* The receipt: the failure is the publish Stage, so the retry resumes from
       the already-measured snapshot rather than measuring again. */
    expect(runs.open(failed!.id)?.read().failedStage).toBe("publish");

    await host.retryRun(failed!.id);
    await host.idle();
    expect(runs.open(failed!.id)?.read().status).toBe("done");

    /* Exactly the append that failed and exactly the retry's append — both
       against the new spreadsheet, never the old id. */
    expect(appendedTo).toEqual(["sheet-1", "sheet-1"]);
    expect(ensuredTabs.every((id) => id === "sheet-1")).toBe(true);
  });
});
