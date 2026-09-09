import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATION_CONFIRMATION_PHRASE,
  readMigrationState,
} from "../../../apps/server/src/migration/workspace";
import {
  registerMigrationGate,
  registerMigrationRoutes,
  type MigrationGate,
  type MigrationRouteDeps,
} from "../../../apps/server/src/api/migration";
import { ConfigStore } from "../../../apps/server/src/config";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store";

/**
 * The migration gate's API surface (issue #144): status, inventory, confirm,
 * receipt, and the preHandler hook that holds every normal /api route behind
 * the gate while the Workspace is pre-cutover. Every fixture is a throwaway
 * temporary Workspace — never the repository's own.
 */

const ONBOARDING_STEP_IDS = [
  "provider-enablement",
  "owner-profile",
  "brand-voice",
  "internal-domains",
  "transcript-folder",
  "sheets-destinations",
  "workflow-bundles",
];

/** A small valid config.json; the schema's defaults fill the rest on load. */
const MINIMAL_CONFIG = {
  provider: "mock",
  model: "",
  apiKey: "",
  tasklistName: "Meeting Followups",
};

interface FakeGate extends MigrationGate {
  active: boolean;
  completedCount: number;
}

function fakeGate(active: boolean): FakeGate {
  const gate: FakeGate = {
    active,
    completedCount: 0,
    isActive() {
      return this.active;
    },
    setActive(value: boolean) {
      this.active = value;
    },
    complete() {
      this.active = false;
      this.completedCount += 1;
    },
  };
  return gate;
}

/** A pre-cutover Workspace the classifier must call required, not fresh. */
function seedPreCutoverWorkspace(workspaceDir: string, configPatch: Record<string, unknown> = {}) {
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  writeFileSync(join(workspaceDir, "runs", "run-1.json"), JSON.stringify({ id: "run-1" }));
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify({ ...MINIMAL_CONFIG, ...configPatch }),
  );
}

function seedCompletedMarker(workspaceDir: string) {
  mkdirSync(join(workspaceDir, "migration"), { recursive: true });
  writeFileSync(
    join(workspaceDir, "migration", "completed.json"),
    JSON.stringify({ migratedAt: "2026-09-01T00:00:00.000Z" }),
  );
}

/**
 * The route deps. The aggregator's ConfigStore deliberately lives OUTSIDE the
 * fixture Workspace — `load()` persists, and a persisted config.json inside
 * the Workspace would tip `readMigrationState` from fresh to required. The
 * Workspace's own state stays under the seed helpers' control alone.
 */
function buildDeps(workspaceDir: string, gate: MigrationGate): MigrationRouteDeps {
  const configDir = mkdtempSync(join(tmpdir(), "cos-migration-routes-config-"));
  const configStore = new ConfigStore(join(configDir, "config.json"));
  configStore.load();
  return {
    workspaceDir,
    gate,
    configStore,
    googleConnection: { state: async () => ({ state: "unconfigured" }) },
    ownerOnboarding: new OwnerOnboarding({
      people: new WorkspacePersonProfiles({
        store: new PersonProfileStore(workspaceDir),
        lifecycle: [],
      }),
      workspaceDir,
    }),
    brandProfiles: new WorkspaceBrandProfileStore(workspaceDir),
  };
}

interface RoutesHarness {
  app: FastifyInstance;
  workspaceDir: string;
  gate: FakeGate;
  deps: MigrationRouteDeps;
}

/** One fastify instance with the gate hook, the migration routes, and nothing else. */
function harness(gateActive: boolean): RoutesHarness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-migration-routes-"));
  const gate = fakeGate(gateActive);
  const deps = buildDeps(workspaceDir, gate);
  const app = fastify();
  registerMigrationGate(app, gate);
  registerMigrationRoutes(app, deps);
  return { app, workspaceDir, gate, deps };
}

describe("GET /api/migration/status", () => {
  let h: RoutesHarness;

  beforeEach(() => {
    h = harness(false);
    return h.app.ready();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it("reports a fresh Workspace with the seven onboarding steps, none done", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/migration/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      state: string;
      onboarding: { complete: boolean; steps: { id: string; done: boolean }[] };
    }>();
    expect(body.state).toBe("fresh");
    expect(body.onboarding.complete).toBe(false);
    expect(body.onboarding.steps.map((step: { id: string }) => step.id)).toEqual(
      ONBOARDING_STEP_IDS,
    );
    expect(body.onboarding.steps.every((step: { done: boolean }) => step.done === false)).toBe(
      true,
    );
  });

  it("reports a pre-cutover Workspace as required", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    const res = await h.app.inject({ method: "GET", url: "/api/migration/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("required");
  });

  it("reports a migrated Workspace as completed", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    seedCompletedMarker(h.workspaceDir);
    const res = await h.app.inject({ method: "GET", url: "/api/migration/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("completed");
  });

  it("reads each step's done from the real store, never hardcoded", async () => {
    h.deps.configStore.update({ apiKey: "model-key" });
    h.deps.configStore.update({
      drive: { enabled: true, folderId: "folder-1", folderName: "Transcripts" },
    });
    h.deps.configStore.setModuleConfig("meeting-brief-generator", {
      internalDomains: ["found42.test"],
      hubspot: { token: "", lastVerifiedAt: null },
      providerPolicy: {
        crm: { disabled: false, changedAt: "2026-09-01T00:00:00.000Z", reason: "onboarding" },
      },
    });
    h.deps.configStore.setModuleConfig("youtube-trends", {
      channels: [],
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://sheets.test/1",
    });
    h.deps.brandProfiles.accept({
      markdown: "# Voice",
      sourceScan: { websiteUrl: "https://found42.test", includedUrls: [], excludedUrls: [] },
      note: null,
    });
    const res = await h.app.inject({ method: "GET", url: "/api/migration/status" });
    const done = Object.fromEntries(
      res
        .json<{ onboarding: { steps: { id: string; done: boolean }[] } }>()
        .onboarding.steps.map((step) => [step.id, step.done]),
    );
    expect(done).toEqual({
      "provider-enablement": false, // Google is still unconfigured
      "owner-profile": false,
      "brand-voice": true,
      "internal-domains": true,
      "transcript-folder": true,
      "sheets-destinations": true,
      "workflow-bundles": true,
    });
    expect(res.json().onboarding.complete).toBe(false);
  });
});

describe("GET /api/migration/inventory", () => {
  let h: RoutesHarness;

  beforeEach(() => {
    h = harness(false);
    return h.app.ready();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it("returns the preview payload for a required Workspace", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    const res = await h.app.inject({ method: "GET", url: "/api/migration/inventory" });
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBeUndefined();
  });

  it("refuses a fresh Workspace with 409 not-required", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/migration/inventory" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "not-required" });
  });

  it("refuses a completed Workspace with 409 not-required", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    seedCompletedMarker(h.workspaceDir);
    const res = await h.app.inject({ method: "GET", url: "/api/migration/inventory" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "not-required" });
  });
});

describe("POST /api/migration/confirm", () => {
  let h: RoutesHarness;

  beforeEach(() => {
    h = harness(false);
    return h.app.ready();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it("executes the reset, flips the gate, and returns the receipt", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/migration/confirm",
      payload: { typedConfirmation: MIGRATION_CONFIRMATION_PHRASE },
    });
    expect(res.statusCode).toBe(200);
    const receipt = res.json().receipt;
    expect(receipt.schemaVersion).toBe(1);
    expect(typeof receipt.migratedAt).toBe("string");
    expect(typeof receipt.durationMs).toBe("number");
    for (const key of [
      "directories",
      "files",
      "preservedConfigKeys",
      "droppedConfigKeys",
      "preservedRelayKeys",
      "droppedRelayKeys",
    ]) {
      expect(typeof receipt.categories[key]).toBe("number");
    }
    expect(h.gate.completedCount).toBe(1);
    expect(h.gate.isActive()).toBe(false);
    expect(readMigrationState(h.workspaceDir)).toBe("completed");
  });

  it("refuses a wrong confirmation phrase with 403 and touches nothing", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/migration/confirm",
      payload: { typedConfirmation: "delete everything" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "confirmation-mismatch" });
    expect(h.gate.completedCount).toBe(0);
    expect(readMigrationState(h.workspaceDir)).toBe("required");
  });

  it("refuses a body without a typed confirmation with 403", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    const res = await h.app.inject({ method: "POST", url: "/api/migration/confirm", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "confirmation-mismatch" });
  });

  it("refuses a Workspace that is not required with 409 not-required", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    seedCompletedMarker(h.workspaceDir);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/migration/confirm",
      payload: { typedConfirmation: MIGRATION_CONFIRMATION_PHRASE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "not-required" });
    expect(h.gate.completedCount).toBe(0);
  });

  it("fails closed over ambiguous mixed state with 409 unsafe-mixed-state", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    /* A stored key the classifier does not recognize: the executor must
       refuse to draw the boundary rather than guess. */
    const configPath = join(h.workspaceDir, "config.json");
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    stored.futureUnknownSetting = true;
    writeFileSync(configPath, JSON.stringify(stored));
    const res = await h.app.inject({
      method: "POST",
      url: "/api/migration/confirm",
      payload: { typedConfirmation: MIGRATION_CONFIRMATION_PHRASE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "unsafe-mixed-state" });
    expect(h.gate.completedCount).toBe(0);
    expect(readMigrationState(h.workspaceDir)).toBe("required");
  });
});

describe("GET /api/migration/receipt", () => {
  let h: RoutesHarness;

  beforeEach(() => {
    h = harness(false);
    return h.app.ready();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it("answers 404 before any migration", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/migration/receipt" });
    expect(res.statusCode).toBe(404);
  });

  it("returns the receipt written by a successful confirm", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    await h.app.inject({
      method: "POST",
      url: "/api/migration/confirm",
      payload: { typedConfirmation: MIGRATION_CONFIRMATION_PHRASE },
    });
    const res = await h.app.inject({ method: "GET", url: "/api/migration/receipt" });
    expect(res.statusCode).toBe(200);
    expect(res.json().schemaVersion).toBe(1);
  });
});

describe("the migration gate preHandler hook", () => {
  let h: RoutesHarness;

  beforeEach(() => {
    h = harness(true);
    h.app.get("/api/runs", async () => ({ runs: [] }));
    h.app.get("/api/health", async () => ({ ok: true }));
    return h.app.ready();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it("rejects a normal API route with 503 migration-required while gated", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/runs" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "migration-required" });
  });

  it("leaves the migration routes and health exempt while gated", async () => {
    const status = await h.app.inject({ method: "GET", url: "/api/migration/status" });
    expect(status.statusCode).toBe(200);
    const health = await h.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });

  it("releases the normal routes once the gate completes", async () => {
    seedPreCutoverWorkspace(h.workspaceDir);
    const confirm = await h.app.inject({
      method: "POST",
      url: "/api/migration/confirm",
      payload: { typedConfirmation: MIGRATION_CONFIRMATION_PHRASE },
    });
    expect(confirm.statusCode).toBe(200);
    const res = await h.app.inject({ method: "GET", url: "/api/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runs: [] });
  });
});
