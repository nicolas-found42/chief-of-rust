import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { GoogleAuth } from "../../../apps/server/src/google/oauth";
import { CLEAR_GENERATED_DATA_CONFIRMATION } from "@chief-of-staff-demo/shared";
import {
  registerClearDataApi,
  type ClearDataRouteDeps,
} from "../../../apps/server/src/api/clear-data";
import { ConfigStore } from "../../../apps/server/src/config";
import type { GoogleConnection } from "../../../apps/server/src/google/connection";
import { ContentResearchStore } from "../../../apps/server/src/modules/content-research/store";

/**
 * The clear-data API (issue #144's repeatable successor to the migration
 * gate): the local wipe always runs, the Sheets half is best-effort and
 * reported per destination, and the Resonance Ledger's pointer survives the
 * wipe that deletes the file it lives in. Every fixture is a throwaway
 * temporary Workspace — never the repository's own.
 */

const PHRASE = CLEAR_GENERATED_DATA_CONFIRMATION;
const YT_SHEET_ID = "yt-sheet-1";
const LEDGER_SHEET_ID = "ledger-sheet-1";

interface Spy {
  events: string[];
  startOptions: Array<{ seedV1Watchlist: boolean }>;
  clearedSheets: string[];
}

interface Harness {
  app: FastifyInstance;
  workspaceDir: string;
  configStore: ConfigStore;
  contentResearch: ContentResearchStore;
  spy: Spy;
}

function seedWorkspace(label: string): string {
  const workspaceDir = mkdtempSync(join(tmpdir(), `cos-clear-data-routes-${label}-`));
  for (const file of [
    "runs/run_1/meta.json",
    "person-profiles/p1/current.json",
    "transcript-catalog/consents.json",
    "content-scout/state.json",
    "onboarding/owner-confirmation.json",
  ]) {
    const target = join(workspaceDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "{}");
  }
  for (const file of ["state.json", "intake-schedules.json", "meeting-brief-calendar.json"]) {
    writeFileSync(join(workspaceDir, file), "{}");
  }
  writeFileSync(
    join(workspaceDir, "relay.json"),
    JSON.stringify({ relayBaseUrl: "http://127.0.0.1:8787" }),
  );
  mkdirSync(join(workspaceDir, "migration"), { recursive: true });
  writeFileSync(
    join(workspaceDir, "migration", "completed.json"),
    JSON.stringify({ migratedAt: "2026-09-01T00:00:00.000Z" }),
  );
  return workspaceDir;
}

function harness(
  options: {
    connected?: boolean;
    running?: boolean;
    clearRows?: ClearDataRouteDeps["clearRows"];
  } = {},
): Harness {
  const connected = options.connected ?? true;
  const running = options.running ?? true;
  const workspaceDir = seedWorkspace("h");
  const configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  configStore.setModuleConfig("youtube-trends", {
    ...configStore.getModuleConfig("youtube-trends"),
    spreadsheetId: YT_SHEET_ID,
  });
  const contentResearch = new ContentResearchStore(workspaceDir, () => new Date());
  contentResearch.setLedger({
    spreadsheetId: LEDGER_SHEET_ID,
    spreadsheetUrl: "https://sheets.example/ledger",
  });
  contentResearch.addPerson({ profileId: "p-person-1", name: "Watched Person" });

  const fakeAuth = {} as GoogleAuth;
  const google: Pick<GoogleConnection, "auth"> = {
    auth: () => (connected ? { ok: true, auth: fakeAuth } : { ok: false, state: "disconnected" }),
  };
  const spy: Spy = { events: [], startOptions: [], clearedSheets: [] };
  const deps: ClearDataRouteDeps = {
    workspaceDir,
    configStore,
    google,
    contentResearch,
    modulesRunning: () => running,
    stopModules: () => {
      spy.events.push("stop");
    },
    startModules: async (options) => {
      spy.events.push("start");
      spy.startOptions.push(options);
    },
    drain: async () => {
      spy.events.push("drain");
    },
    ...(options.clearRows ? { clearRows: options.clearRows } : {}),
  };
  const app = fastify();
  registerClearDataApi(app, {
    ...deps,
    clearRows: async (auth, spreadsheetId) => {
      spy.clearedSheets.push(spreadsheetId);
      if (deps.clearRows) return deps.clearRows(auth, spreadsheetId);
      return [{ tab: "Tab 1", rowsRemoved: 5 }];
    },
  });
  return { app, workspaceDir, configStore, contentResearch, spy };
}

describe("GET /api/clear-data/inventory", () => {
  it("lists what the Workspace holds, with counts and without values", async () => {
    const h = harness();
    const response = await h.app.inject({ method: "GET", url: "/api/clear-data/inventory" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      entries: Array<{ name: string; kind: string; fileCount: number | null }>;
    }>();
    const byName = new Map(body.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("runs")).toMatchObject({ kind: "directory", fileCount: 1 });
    expect(byName.get("state.json")).toMatchObject({ kind: "file", fileCount: null });
    expect(response.body).not.toContain("Watched Person");
  });
});

describe("POST /api/clear-data/confirm", () => {
  it("refuses a wrong phrase before touching the Modules or the Workspace", async () => {
    const h = harness();
    const before = readFileSync(
      join(h.workspaceDir, "person-profiles", "p1", "current.json"),
      "utf8",
    );

    const response = await h.app.inject({
      method: "POST",
      url: "/api/clear-data/confirm",
      payload: { typedConfirmation: "nope" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "confirmation-mismatch" });
    expect(
      readFileSync(join(h.workspaceDir, "person-profiles", "p1", "current.json"), "utf8"),
    ).toBe(before);
    expect(h.spy.events).toEqual([]);
    expect(h.spy.clearedSheets).toEqual([]);
    expect(h.contentResearch.listAllPeople()).toHaveLength(1);
  });

  it("wipes locally, re-seeds the ledger pointer, clears both Sheets, and resumes unseeded", async () => {
    const h = harness();
    const relayBefore = readFileSync(join(h.workspaceDir, "relay.json"), "utf8");
    const migrationBefore = readFileSync(
      join(h.workspaceDir, "migration", "completed.json"),
      "utf8",
    );

    const response = await h.app.inject({
      method: "POST",
      url: "/api/clear-data/confirm",
      payload: { typedConfirmation: PHRASE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      schemaVersion: number;
      local: { directories: Array<{ name: string; files: number }>; files: string[] };
      sheets: Array<{ destination: string; outcome: string; tabs?: number; rows?: number }>;
    }>();
    expect(body.schemaVersion).toBe(1);
    expect(body.local.directories.map((entry) => entry.name).sort()).toEqual(
      [
        "content-research",
        "content-scout",
        "onboarding",
        "person-profiles",
        "runs",
        "transcript-catalog",
      ].sort(),
    );
    expect(body.local.files).toContain("state.json");
    expect(body.sheets).toEqual([
      { destination: "youtube-trends", outcome: "cleared", tabs: 1, rows: 5 },
      { destination: "content-research-ledger", outcome: "cleared", tabs: 1, rows: 5 },
    ]);
    expect(h.spy.clearedSheets).toEqual([YT_SHEET_ID, LEDGER_SHEET_ID]);

    expect(existsSync(join(h.workspaceDir, "runs"))).toBe(false);
    expect(existsSync(join(h.workspaceDir, "person-profiles"))).toBe(false);
    expect(existsSync(join(h.workspaceDir, "state.json"))).toBe(false);
    expect(readFileSync(join(h.workspaceDir, "relay.json"), "utf8")).toBe(relayBefore);
    expect(readFileSync(join(h.workspaceDir, "migration", "completed.json"), "utf8")).toBe(
      migrationBefore,
    );

    /* The pointer is configuration: it survives the wipe that deletes its file. */
    const fresh = new ContentResearchStore(h.workspaceDir, () => new Date());
    expect(fresh.getLedger().spreadsheetId).toBe(LEDGER_SHEET_ID);
    expect(fresh.listAllPeople()).toEqual([]);

    /* The quiesce ran in order, and the resume withheld the demo watchlist. */
    expect(h.spy.events).toEqual(["stop", "drain", "start"]);
    expect(h.spy.startOptions).toEqual([{ seedV1Watchlist: false }]);
  });

  it("leaves an idle Modules surface idle: no stop, drain, or resume", async () => {
    const h = harness({ running: false });

    const response = await h.app.inject({
      method: "POST",
      url: "/api/clear-data/confirm",
      payload: { typedConfirmation: PHRASE },
    });

    expect(response.statusCode).toBe(200);
    expect(h.spy.events).toEqual([]);
    expect(h.spy.startOptions).toEqual([]);
    expect(existsSync(join(h.workspaceDir, "runs"))).toBe(false);
  });

  it("skips the Sheets half without a connection and still wipes locally", async () => {
    const h = harness({ connected: false });

    const response = await h.app.inject({
      method: "POST",
      url: "/api/clear-data/confirm",
      payload: { typedConfirmation: PHRASE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      sheets: Array<{ destination: string; outcome: string; reason?: string }>;
    }>();
    expect(body.sheets).toHaveLength(2);
    for (const sheet of body.sheets) {
      expect(sheet.outcome).toBe("skipped");
      expect(sheet.reason).toContain("Google");
    }
    expect(h.spy.clearedSheets).toEqual([]);
    expect(existsSync(join(h.workspaceDir, "transcript-catalog"))).toBe(false);
  });

  it("skips destinations that never had a spreadsheet", async () => {
    const h = harness();
    h.configStore.setModuleConfig("youtube-trends", {
      ...h.configStore.getModuleConfig("youtube-trends"),
      spreadsheetId: "",
    });
    h.contentResearch.setLedger({ spreadsheetId: "", spreadsheetUrl: "" });

    const response = await h.app.inject({
      method: "POST",
      url: "/api/clear-data/confirm",
      payload: { typedConfirmation: PHRASE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      sheets: Array<{ destination: string; outcome: string; reason?: string }>;
    }>();
    for (const sheet of body.sheets) {
      expect(sheet.outcome).toBe("skipped");
      expect(sheet.reason).toContain("No spreadsheet has been created");
    }
    expect(h.spy.clearedSheets).toEqual([]);
  });

  it("reports a missing spreadsheet as missing, and still clears the other destination", async () => {
    const h = harness({
      clearRows: async (_auth, spreadsheetId) => {
        if (spreadsheetId === YT_SHEET_ID)
          throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
        return [{ tab: "Ledger", rowsRemoved: 2 }];
      },
    });

    const response = await h.app.inject({
      method: "POST",
      url: "/api/clear-data/confirm",
      payload: { typedConfirmation: PHRASE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      sheets: Array<{ destination: string; outcome: string }>;
    }>();
    const byDestination = new Map(body.sheets.map((sheet) => [sheet.destination, sheet]));
    expect(byDestination.get("youtube-trends")?.outcome).toBe("missing");
    expect(byDestination.get("content-research-ledger")?.outcome).toBe("cleared");
  });

  it("reports a Sheets failure in the receipt without blocking the local wipe", async () => {
    const h = harness({
      clearRows: async () => {
        throw new Error("quota exceeded");
      },
    });

    const response = await h.app.inject({
      method: "POST",
      url: "/api/clear-data/confirm",
      payload: { typedConfirmation: PHRASE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      local: { directories: unknown[] };
      sheets: Array<{ destination: string; outcome: string; reason?: string }>;
    }>();
    expect(body.local.directories.length).toBeGreaterThan(0);
    const byDestination = new Map(body.sheets.map((sheet) => [sheet.destination, sheet]));
    expect(byDestination.get("youtube-trends")).toMatchObject({
      outcome: "failed",
      reason: "quota exceeded",
    });
    expect(byDestination.get("content-research-ledger")).toMatchObject({ outcome: "failed" });
  });
});
