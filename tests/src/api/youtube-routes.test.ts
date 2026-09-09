import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { YoutubeChannel, YoutubeTrends } from "@chief-of-staff-demo/shared";
import { ConfigStore } from "../../../apps/server/src/config";
import type { YouTubeClient } from "../../../apps/server/src/modules/youtube/client";
import { YoutubeHost } from "../../../apps/server/src/modules/youtube/host";
import {
  YOUTUBE_INTAKE,
  YOUTUBE_MODULE_ID,
  YOUTUBE_MODULE_VERSION,
} from "../../../apps/server/src/modules/youtube/module";
import type { SheetsClient } from "../../../apps/server/src/modules/youtube/spreadsheet";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

/**
 * The Module's own endpoints, over a real server instance and a temporary
 * Workspace. What matters here is the promise the tab makes: a pasted URL is
 * checked against YouTube while the operator is still looking at it.
 */
const PORT = 4317;

let app: FastifyInstance;
let workspaceDir: string;
let configStore: ConfigStore;
let host: YoutubeHost;
let runs: Runs;
let connected: boolean;
let resolves: Record<
  string,
  { id: string; handle: string; title: string; uploadsPlaylistId: string }
>;

const client: YouTubeClient = {
  resolveChannel: async (ref) => resolves[ref.value] ?? null,
  listUploads: async () => [],
  videoStatistics: async () => ({ videos: [], failedIds: [] }),
};

let created: number;
let tabs: string[];
const sheets: SheetsClient = {
  createSpreadsheet: async () => {
    created += 1;
    return { id: `sheet-${created}`, url: `https://docs.google.com/sheet-${created}` };
  },
  ensureTab: async (_id, title) => {
    if (!tabs.includes(title)) {
      tabs.push(title);
    }
  },
  appendRows: async () => {},
  isMissing: () => false,
};

function channels(): YoutubeChannel[] {
  return configStore.get().modules["youtube-trends"].channels;
}

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-youtube-api-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  connected = true;
  created = 0;
  tabs = [];
  resolves = {
    "@found42": {
      id: "UC_found42",
      handle: "@found42",
      title: "Found42",
      uploadsPlaylistId: "UU_found42",
    },
  };

  runs = openRuns(workspaceDir);
  host = new YoutubeHost({
    runs,
    configStore,
    workspaceDir,
    port: PORT,
    google: fromPartial({
      auth: () => (connected ? { ok: true, auth: {} } : { ok: false, state: "disconnected" }),
      observe: () => null,
    }),
    log: () => {},
    now: () => new Date("2026-08-23T09:00:00"),
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

describe("YoutubeHost lifecycle", () => {
  it("recovers an orphaned Run when the Host starts", async () => {
    configStore.setModuleConfig(YOUTUBE_MODULE_ID, {
      ...configStore.get().modules[YOUTUBE_MODULE_ID],
      channels: [
        {
          id: "UC_found42",
          handle: "@found42",
          title: "Found42",
          uploadsPlaylistId: "UU_found42",
          addedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/sheet-1",
    });
    const orphan = runs.create({
      module: YOUTUBE_MODULE_ID,
      moduleVersion: YOUTUBE_MODULE_VERSION,
      intake: YOUTUBE_INTAKE,
      sourceUrl: null,
      externalId: "2026-08-22",
    });
    orphan.started("enumerate");

    host.start();
    await host.idle();

    expect(runs.detail(orphan.id)?.status).toBe("done");
    expect(
      runs.detail(orphan.id)?.events.find((event) => event.type === "run_recovered")?.detail,
    ).toEqual({
      fromStage: "enumerate",
      previousStatus: "running",
      reason: "no_measured_snapshot_survived_restart",
    });
  });
});

describe("POST /api/youtube/channels", () => {
  it("resolves the channel now and stores it resolved, so no Run ever guesses", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().channel).toMatchObject({
      id: "UC_found42",
      title: "Found42",
    });
    /* Its real name shown back, so the operator can confirm they added the
       channel they meant. */
    expect(channels()).toHaveLength(1);
    expect(channels()[0]).toMatchObject({ uploadsPlaylistId: "UU_found42" });
  });

  it("refuses a /c/ URL with the forms that work, without calling Google", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/c/Found42" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("youtube.com/@name");
    expect(channels()).toHaveLength(0);
  });

  it("says so when YouTube knows no such channel", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@nobody" },
    });
    expect(response.statusCode).toBe(404);
    expect(channels()).toHaveLength(0);
  });

  it("refuses the same channel twice, by identity rather than by URL", async () => {
    resolves["UC_found42"] = resolves["@found42"]!;
    await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });
    const again = await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/channel/UC_found42" },
    });
    expect(again.statusCode).toBe(409);
    expect(channels()).toHaveLength(1);
  });

  it("cannot check a paste while there is no connection, and says which state", async () => {
    connected = false;
    const response = await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not connected/i);
  });
});

describe("DELETE /api/youtube/channels/:id", () => {
  it("stops future work and erases nothing", async () => {
    await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });
    const removed = await app.inject({ method: "DELETE", url: "/api/youtube/channels/UC_found42" });
    expect(removed.statusCode).toBe(200);
    expect(channels()).toHaveLength(0);
    /* Nothing on disk went with it: the Runs are the record and are immutable. */
    expect((await app.inject({ method: "GET", url: "/api/youtube/trends" })).statusCode).toBe(200);

    const missing = await app.inject({ method: "DELETE", url: "/api/youtube/channels/UC_nobody" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/youtube/run", () => {
  it("refuses when there is nothing to measure", async () => {
    const response = await app.inject({ method: "POST", url: "/api/youtube/run" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Add a channel first");
  });

  it("records again on a day already recorded, so intra-day movement is visible", async () => {
    await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });
    const first = await app.inject({ method: "POST", url: "/api/youtube/run" });
    expect(first.statusCode).toBe(200);
    await host.idle();

    const second = await app.inject({ method: "POST", url: "/api/youtube/run" });
    expect(second.statusCode).toBe(200);
    await host.idle();
    /* Both Runs are kept: each is a measurement, not a correction of the other. */
    expect(first.json().runId).not.toBe(second.json().runId);
  });
});

describe("POST /api/youtube/spreadsheet", () => {
  it("creates one, hands back the link, and gives every channel its tab", async () => {
    await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });

    const response = await app.inject({ method: "POST", url: "/api/youtube/spreadsheet" });
    expect(response.statusCode).toBe(201);
    expect(response.json().spreadsheet.url).toContain("docs.google.com");
    expect(tabs).toEqual(["Found42"]);

    /* Kept somewhere permanent, so it is findable weeks later without hunting
       through Run history. */
    const trends = (await app.inject({ method: "GET", url: "/api/youtube/trends" })).json();
    expect(trends.spreadsheet?.id).toBe("sheet-1");
  });

  it("refuses to make a second one", async () => {
    await app.inject({ method: "POST", url: "/api/youtube/spreadsheet" });
    const again = await app.inject({ method: "POST", url: "/api/youtube/spreadsheet" });
    /* Two spreadsheets and no idea which is live is the failure this avoids. */
    expect(again.statusCode).toBe(409);
    expect(created).toBe(1);
  });

  it("gives a channel added later its own tab", async () => {
    await app.inject({ method: "POST", url: "/api/youtube/spreadsheet" });
    await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });
    expect(tabs).toEqual(["Found42"]);
  });
});

describe("GET /api/youtube/trends", () => {
  it("answers from the Runs on disk, so an expired connection does not blank it", async () => {
    await app.inject({
      method: "POST",
      url: "/api/youtube/channels",
      payload: { url: "https://www.youtube.com/@found42" },
    });
    await app.inject({ method: "POST", url: "/api/youtube/run" });
    await host.idle();

    connected = false;
    const response = await app.inject({ method: "GET", url: "/api/youtube/trends" });
    expect(response.statusCode).toBe(200);
    const trends = response.json<YoutubeTrends>();
    expect(trends.channels.map((channel) => channel.title)).toEqual(["Found42"]);
    expect(trends.lastDay).toBe("2026-08-23");
    expect(trends.todayRecorded).toBe(true);
  });
});
