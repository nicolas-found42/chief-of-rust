import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@chief-of-staff-demo/shared";
import {
  MIGRATION_CONFIRMATION_PHRASE,
  executeWorkspaceMigration,
  readMigrationReceipt,
  readMigrationState,
} from "../../../apps/server/src/migration/workspace";

/**
 * The destructive half of the Workspace migration contract — issue://144. Every
 * fixture is a throwaway temporary directory; the reset is never pointed at the
 * Workspace this repository runs on. Nothing here may reach a provider: the
 * reset validates the rewritten files structurally, never by fetching.
 */

const TIMESTAMP = "2026-08-31T12:00:00.000Z";

function completeConfig() {
  return ConfigSchema.parse({
    provider: "openai",
    model: "gpt-test",
    apiKey: "llm-api-key-secret",
    tasklistName: "Meeting Followups",
    google: {
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      refreshToken: "google-refresh-token",
      lastConnectedAt: TIMESTAMP,
      hasExpiredBefore: false,
    },
    notion: { token: "notion-token", lastVerifiedAt: TIMESTAMP },
    drive: {
      enabled: true,
      folderId: "drive-folder-id",
      folderName: "Board minutes",
      pollIntervalMinutes: 2,
    },
    ollama: { baseUrl: "http://ollama.test:11434" },
    modules: {
      "youtube-trends": {
        channels: [
          {
            id: "UCyoutube",
            handle: "@found42",
            title: "Found42",
            uploadsPlaylistId: "UUyoutube",
            addedAt: TIMESTAMP,
          },
        ],
        spreadsheetId: "youtube-spreadsheet-id",
        spreadsheetUrl: "https://sheets.test/youtube",
      },
      "idea-engine": {
        spreadsheetId: "idea-spreadsheet-id",
        spreadsheetUrl: "https://sheets.test/ideas",
        prompts: { article: "an idea prompt" },
      },
      "content-scout": {
        timeZone: "Europe/Paris",
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
        shortlistSize: 5,
        canaryIntervalHours: 12,
        canaryDisabledAdapters: ["reddit"],
      },
      "content-research": {
        timeZone: "Europe/Paris",
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
      },
      "meeting-brief-generator": {
        internalDomains: ["found42.test"],
        hubspot: { token: "hubspot-token", lastVerifiedAt: TIMESTAMP },
      },
    },
  });
}

/** The full relay fixture, whose installation identity must survive the reset. */
function completeRelay() {
  return {
    installationId: "relay-installation-id",
    secret: "relay-installation-secret",
    relayBaseUrl: "https://relay.test",
    channels: [
      {
        channelId: "relay-channel-id",
        token: "relay-channel-token",
        resourceId: "relay-resource-id",
        expiration: TIMESTAMP,
      },
    ],
    lastWakeUpAt: TIMESTAMP,
  };
}

/** Everything a pre-cutover Workspace holds that is not config.json or relay.json. */
const PRODUCT_FILES: Record<string, unknown> = {
  "meeting-brief-calendar.json": {
    channel: {
      channelId: "calendar-channel-id",
      token: "calendar-channel-token",
      resourceId: "calendar-resource-id",
      expiration: TIMESTAMP,
      calendarId: "primary",
    },
    syncToken: "calendar-sync-token",
    lastSyncAt: TIMESTAMP,
    cancellations: [],
  },
  "state.json": {
    drive: { ingestedIds: ["drive-file-id"] },
    youtubeTrends: { lastRunDay: "2026-08-30" },
    ideaEngine: { ingestedIds: ["idea-row-id"] },
  },
  "intake-schedules.json": [{ key: "content-scout:daily", dueAt: TIMESTAMP }],
  "mock-result.json": { tasks: [] },
  "runs/run_20260831-120000_0a1b2c3d/meta.json": { id: "run_20260831-120000_0a1b2c3d" },
  "runs/run_20260831-120000_0a1b2c3d/events.jsonl": '{"type":"started"}\n',
  "runs/run_20260831-120000_0a1b2c3d/artifact.md": "a private artifact\n",
  "person-profiles/person_1/current.json": { name: "A Named Person", revision: 2 },
  "person-profiles/person_1/revisions/1.json": { name: "A Named Person", revision: 1 },
  "person-profiles/person_1/revisions/2.json": { name: "A Named Person", revision: 2 },
  "content-scout/state.json": { opportunities: [] },
  "content-scout/canary-state.json": { adapters: [] },
  "content-scout/brand-profiles/brand_1.md": "# Brand\n",
  "content-scout/evidence-transcripts/item_1.txt": "evidence\n",
  "content-research/people.json": { people: [] },
  "content-research/items/item_1.json": { url: "https://example.test" },
  ".DS_Store": "\u0000\u0000\u0000\u0001Bud1",
};

function workspace(label: string, files: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), `cos-migration-reset-${label}-`));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

function completeWorkspace(label: string): string {
  return workspace(label, {
    "config.json": completeConfig(),
    "relay.json": completeRelay(),
    ...PRODUCT_FILES,
  });
}

/** Everything a fixture Workspace holds, so a reset can be proved to change none of it. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return files;
}

/** The config.json a completed reset must leave: every preserved key, nothing else. */
function authOnlyConfig() {
  return {
    apiKey: "llm-api-key-secret",
    google: {
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      refreshToken: "google-refresh-token",
    },
    notion: { token: "notion-token" },
    modules: { "meeting-brief-generator": { hubspot: { token: "hubspot-token" } } },
    /* The Asana credential slot survives the reset structurally, even when
       the Workspace never connected (issue #189). */
    tasks: { asana: { token: "" } },
  };
}

/** Values the reset must leave nowhere in the rewritten configuration. */
const DROPPED_DESTINATIONS = [
  "youtube-spreadsheet-id",
  "https://sheets.test/youtube",
  "idea-spreadsheet-id",
  "https://sheets.test/ideas",
  "drive-folder-id",
  "Board minutes",
  "Meeting Followups",
  "@found42",
];

/* No reset may reach a provider, so every test runs with the network refused. */
let providerCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  providerCalls = 0;
  globalThis.fetch = () => {
    providerCalls += 1;
    throw new Error("the workspace reset must not call a provider");
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(providerCalls).toBe(0);
});

describe("migration confirmation phrase", () => {
  it("is the house exact-match kind: a constant typed character for character", () => {
    expect(MIGRATION_CONFIRMATION_PHRASE).toBe("RESET WORKSPACE");
    expect(
      executeWorkspaceMigration(completeWorkspace("phrase"), {
        typedConfirmation: "reset workspace",
      }).outcome,
    ).toBe("confirmation-mismatch");
  });
});

describe("readMigrationState", () => {
  it("calls a Workspace that does not exist fresh", () => {
    expect(readMigrationState(join(tmpdir(), "cos-migration-reset-not-there"))).toBe("fresh");
  });

  it("calls an empty Workspace fresh", () => {
    expect(readMigrationState(workspace("empty"))).toBe("fresh");
  });

  it("calls a Workspace with product state required", () => {
    expect(readMigrationState(completeWorkspace("full"))).toBe("required");
  });

  it("calls a Workspace whose only product input is one whole-file record required", () => {
    expect(readMigrationState(workspace("whole-file", { "state.json": { drive: {} } }))).toBe(
      "required",
    );
  });

  it("calls a Workspace with a marker completed", () => {
    const root = completeWorkspace("marked");
    mkdirSync(join(root, "migration"), { recursive: true });
    writeFileSync(join(root, "migration", "completed.json"), "{}\n", "utf8");
    expect(readMigrationState(root)).toBe("completed");
  });
});

describe("executeWorkspaceMigration", () => {
  it("deletes the classified product state and rewrites the mixed files to their authentication keys", () => {
    const root = completeWorkspace("happy");
    expect(readMigrationState(root)).toBe("required");

    const result = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    if (result.outcome !== "completed")
      throw new Error(`expected completion, got ${result.outcome}`);

    expect(readMigrationState(root)).toBe("completed");
    expect(readdirSync(root).sort()).toEqual(["config.json", "migration", "relay.json"]);
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8"))).toEqual(authOnlyConfig());
    expect(JSON.parse(readFileSync(join(root, "relay.json"), "utf8"))).toEqual({
      installationId: "relay-installation-id",
      secret: "relay-installation-secret",
    });

    /* The marker holds the migrated-at instant and nothing else. */
    expect(JSON.parse(readFileSync(join(root, "migration", "completed.json"), "utf8"))).toEqual({
      migratedAt: expect.any(String),
    });

    /* The receipt is the counts the boundary held, content-free. */
    const expectedCategories = {
      directories: 4,
      files: 5,
      preservedConfigKeys: 7,
      droppedConfigKeys: 43,
      preservedRelayKeys: 2,
      droppedRelayKeys: 3,
    };
    expect(result.receipt.schemaVersion).toBe(1);
    expect(result.receipt.categories).toEqual(expectedCategories);
    expect(readMigrationReceipt(root)).toEqual(result.receipt);

    const receipt = JSON.parse(readFileSync(join(root, "migration", "receipt.json"), "utf8"));
    expect(receipt).toEqual({
      schemaVersion: 1,
      migratedAt: expect.any(String),
      durationMs: expect.any(Number),
      categories: expectedCategories,
    });
    const stringified = JSON.stringify(receipt);
    for (const name of [
      "person-profiles",
      "runs",
      "config.json",
      "relay.json",
      "state.json",
      "google-refresh-token",
    ])
      expect(stringified).not.toContain(name);
  });

  it("does not restore old destinations", () => {
    const root = completeWorkspace("destinations");
    const result = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    if (result.outcome !== "completed")
      throw new Error(`expected completion, got ${result.outcome}`);

    const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const stringified = JSON.stringify(config);
    for (const destination of DROPPED_DESTINATIONS) expect(stringified).not.toContain(destination);
    expect(config.tasklistName).toBeUndefined();
    expect(config.drive).toBeUndefined();
    expect(config.modules).toEqual({
      "meeting-brief-generator": { hubspot: { token: "hubspot-token" } },
    });

    const relay = JSON.parse(readFileSync(join(root, "relay.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(relay.relayBaseUrl).toBeUndefined();
    expect(relay.channels).toBeUndefined();
    expect(relay.lastWakeUpAt).toBeUndefined();
  });

  it("preserves every recognized credential structurally", () => {
    const root = completeWorkspace("credentials");
    const result = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    if (result.outcome !== "completed")
      throw new Error(`expected completion, got ${result.outcome}`);

    const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    expect(config).toEqual(authOnlyConfig());
    const relay = JSON.parse(readFileSync(join(root, "relay.json"), "utf8"));
    expect(relay.installationId).toBe("relay-installation-id");
    expect(relay.secret).toBe("relay-installation-secret");
  });

  it("refuses a mismatched typed confirmation and leaves the Workspace byte for byte unchanged", () => {
    const root = completeWorkspace("mismatch");
    const before = snapshot(root);
    const result = executeWorkspaceMigration(root, { typedConfirmation: "DELETE EVERYTHING" });
    expect(result).toEqual({ outcome: "confirmation-mismatch" });
    expect(snapshot(root)).toEqual(before);
    expect(readMigrationState(root)).toBe("required");
  });

  it("checks the confirmation before every other answer, including fail-closed state", () => {
    const unsafeRoot = workspace("mismatch-unsafe", {
      "config.json": legacyConfigWithNestedCredential(),
    });
    expect(executeWorkspaceMigration(unsafeRoot, { typedConfirmation: "wrong" }).outcome).toBe(
      "confirmation-mismatch",
    );

    const completedRoot = completeWorkspace("mismatch-completed");
    expect(
      executeWorkspaceMigration(completedRoot, { typedConfirmation: MIGRATION_CONFIRMATION_PHRASE })
        .outcome,
    ).toBe("completed");
    expect(executeWorkspaceMigration(completedRoot, { typedConfirmation: "wrong" }).outcome).toBe(
      "confirmation-mismatch",
    );
  });

  it("fails closed on mixed state and deletes nothing", () => {
    const root = workspace("unsafe", { "config.json": legacyConfigWithNestedCredential() });
    const before = snapshot(root);
    const result = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    expect(result.outcome).toBe("unsafe-mixed-state");
    if (result.outcome === "unsafe-mixed-state") expect(result.findings.length).toBeGreaterThan(0);
    expect(snapshot(root)).toEqual(before);
    expect(readMigrationState(root)).toBe("required");
  });

  it("fails closed on a foreign migration directory, like any unrecognized entry", () => {
    const root = completeWorkspace("foreign-migration");
    mkdirSync(join(root, "migration"), { recursive: true });
    writeFileSync(join(root, "migration", "notes.txt"), "not ours\n", "utf8");
    const before = snapshot(root);
    const result = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    expect(result.outcome).toBe("unsafe-mixed-state");
    expect(snapshot(root)).toEqual(before);
  });

  it("is a no-op once the marker exists, and re-running stays idempotent", () => {
    const root = completeWorkspace("idempotent");
    const first = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    if (first.outcome !== "completed") throw new Error(`expected completion, got ${first.outcome}`);
    const afterFirst = snapshot(root);

    const second = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    expect(second).toEqual({ outcome: "already-completed" });
    expect(snapshot(root)).toEqual(afterFirst);
    expect(readMigrationReceipt(root)).toEqual(first.receipt);
  });

  it("completes cleanly after a simulated mid-reset crash", () => {
    const root = completeWorkspace("crash");
    /* The crash struck between deletion and the marker: two product directories
       and one whole file are already gone, a stale receipt and a staged rewrite
       sit in the migration directory, and the marker was never written. */
    rmSync(join(root, "runs"), { recursive: true, force: true });
    rmSync(join(root, "person-profiles"), { recursive: true, force: true });
    rmSync(join(root, "mock-result.json"), { force: true });
    mkdirSync(join(root, "migration"), { recursive: true });
    writeFileSync(join(root, "migration", "receipt.json"), '{"schemaVersion":1}\n', "utf8");
    writeFileSync(join(root, "migration", "config.json.tmp"), "{ torn", "utf8");
    expect(readMigrationState(root)).toBe("required");

    const result = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    if (result.outcome !== "completed")
      throw new Error(`expected completion, got ${result.outcome}`);

    expect(readMigrationState(root)).toBe("completed");
    expect(readdirSync(root).sort()).toEqual(["config.json", "migration", "relay.json"]);
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8"))).toEqual(authOnlyConfig());
    expect(existsSync(join(root, "migration", "config.json.tmp"))).toBe(false);
    /* Only what the crashed attempt had not yet reached is counted. */
    expect(result.receipt.categories).toEqual({
      directories: 2,
      files: 4,
      preservedConfigKeys: 7,
      droppedConfigKeys: 43,
      preservedRelayKeys: 2,
      droppedRelayKeys: 3,
    });
    expect(
      executeWorkspaceMigration(root, { typedConfirmation: MIGRATION_CONFIRMATION_PHRASE }),
    ).toEqual({
      outcome: "already-completed",
    });
  });
});

describe("readMigrationReceipt", () => {
  it("returns null when no reset has completed", () => {
    expect(readMigrationReceipt(completeWorkspace("no-receipt"))).toBeNull();
  });

  it("returns the completed reset's receipt", () => {
    const root = completeWorkspace("receipt");
    const result = executeWorkspaceMigration(root, {
      typedConfirmation: MIGRATION_CONFIRMATION_PHRASE,
    });
    if (result.outcome !== "completed")
      throw new Error(`expected completion, got ${result.outcome}`);
    const receipt = readMigrationReceipt(root);
    expect(receipt).not.toBeNull();
    expect(receipt?.migratedAt).toEqual(expect.any(String));
    expect(receipt?.durationMs).toEqual(expect.any(Number));
    expect(receipt?.categories).toEqual(result.receipt.categories);
  });
});

/** A legacy pre-cutover config carrying a credential nested under a composite —
    exactly the shape the reset must keep classifying fail-closed. */
function legacyConfigWithNestedCredential() {
  const config = completeConfig() as Record<string, unknown>;
  const modules = config.modules as Record<string, Record<string, unknown>>;
  const scout = structuredClone(modules["content-scout"]);
  scout["notion"] = {
    databaseId: "",
    dataSourceId: "",
    databaseUrl: "",
    mapping: {
      name: "Name",
      status: "Status",
      platform: "Platform",
      format: "Format",
      scheduledDate: "Scheduled date",
      apiKey: "a nested credential",
    },
  };
  modules["content-scout"] = scout;
  return { ...config, modules };
}
