import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@chief-of-staff-demo/shared";
import {
  DIRECTORIES,
  WHOLE_FILES,
  previewWorkspaceMigration,
  type RemoteRecordDisclosure,
  type UnsafeMixedStateFinding,
  type WorkspaceMigrationCategory,
  type WorkspaceMigrationDisposition,
  type WorkspaceMigrationClassification,
  type WorkspaceMigrationPreview,
} from "../../../apps/server/src/migration/workspace";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store";
import { PersonResearchQueue } from "../../../apps/server/src/person-profile/research-queue";
import type { PersonResearch } from "../../../apps/server/src/person-profile/research";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { previewGeneratedData } from "../../../apps/server/src/clear-data/workspace";

/**
 * The Workspace migration contract — issue://119, ADR-0043. Every fixture is a
 * throwaway temporary directory; the preview is never pointed at the Workspace
 * this repository runs on.
 */

const TIMESTAMP = "2026-08-31T12:00:00.000Z";

/**
 * Every credential and every stored value the fixtures hold. The preview must
 * report category names and counts and never any of these.
 */
const STORED_VALUES = [
  "llm-api-key-secret",
  "google-client-id",
  "google-client-secret",
  "google-refresh-token",
  "notion-token",
  "hubspot-token",
  "guest-profile-api-key",
  "relay-installation-secret",
  "relay-channel-token",
  "calendar-channel-token",
  "drive-folder-id",
  "Board minutes",
  "youtube-spreadsheet-id",
  "https://sheets.test/ideas",
  "notion-database-id",
  "a diagnostic detail",
  "an idea prompt",
  "a policy reason",
  "found42.test",
  "a private artifact",
  "A Named Person",
];

function completeConfig() {
  /* Parsed by the real schema, so every key the app can store is in the fixture
     and the classifier has to have an answer for all of them. */
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
        /* A recorded policy action (issue #137). Defaulted empty, this is the
           one config record a fixture has to populate on purpose or the
           classifier is never asked about its interior. */
        providerPolicy: {
          crm: { disabled: true, changedAt: TIMESTAMP, reason: "a policy reason" },
        },
      },
    },
  });
}

/** A legacy pre-cutover config.json carrying the retired Notion calendar
    mapping — exactly the shape the reset must keep classifying fail-closed. */
function legacyConfigWithNestedCredential(extraMapping: Record<string, unknown> | null = null) {
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
      ...(extraMapping ?? { apiKey: "a nested credential" }),
    },
  };
  modules["content-scout"] = scout;
  return { ...config, modules };
}

function workspace(label: string, files: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), `cos-migration-${label}-`));
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

/** Everything a fixture Workspace holds, so a preview can be proved to change none of it. */
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

function completeWorkspace(label: string): string {
  return workspace(label, {
    "config.json": completeConfig(),
    "relay.json": {
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
    },
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
    /* Drive Intake's ingested transcript ids are the Transcript workflow's state. */
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
  });
}

function categories(preview: WorkspaceMigrationPreview): WorkspaceMigrationCategory[] {
  if (preview.outcome !== "inventory") {
    throw new Error(`expected an inventory, got ${JSON.stringify(preview)}`);
  }
  return preview.categories;
}

/** One category by name, without the name, so an assertion reads as the boundary it checks. */
function inventory(
  preview: WorkspaceMigrationPreview,
): Map<string, Omit<WorkspaceMigrationCategory, "name">> {
  return new Map(
    categories(preview).map((category) => [
      category.name,
      { classification: category.classification, count: category.count },
    ]),
  );
}

function named(
  preview: WorkspaceMigrationPreview,
  classification: WorkspaceMigrationClassification,
): string[] {
  return categories(preview)
    .filter((category) => category.classification === classification)
    .map((category) => category.name);
}

function remoteRecords(preview: WorkspaceMigrationPreview): RemoteRecordDisclosure[] {
  if (preview.outcome !== "inventory") {
    throw new Error(`expected an inventory, got ${JSON.stringify(preview)}`);
  }
  return preview.remoteRecords;
}

/** What the preview must say about one category, minus the name it is looked up by. */
function category(
  classification: WorkspaceMigrationDisposition,
  count: number,
): Omit<WorkspaceMigrationCategory, "name"> {
  return { classification, count };
}

/** What the preview must say about every kind of provider-owned record. */
function disclosure(name: string, count: number): RemoteRecordDisclosure {
  return {
    name,
    classification: "remote-reference",
    count,
    localCategory: "non-auth-workflow-configuration",
    deletedByReset: false,
  };
}

function findings(preview: WorkspaceMigrationPreview): UnsafeMixedStateFinding[] {
  if (preview.outcome !== "unsafe-mixed-state") {
    throw new Error(`expected a fail-closed result, got ${JSON.stringify(preview)}`);
  }
  return preview.findings;
}

/* No preview may reach a provider, so every test runs with the network refused. */
let providerCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  providerCalls = 0;
  globalThis.fetch = () => {
    providerCalls += 1;
    throw new Error("the migration preview must not call a provider");
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(providerCalls).toBe(0);
});

describe("Workspace migration preview", () => {
  it("reports every category at zero for an empty Workspace", () => {
    const preview = previewWorkspaceMigration(workspace("empty"));
    const categories = inventory(preview);

    expect([...categories.values()].every((category) => category.count === 0)).toBe(true);
    expect([...categories.keys()]).toEqual([
      "provider-api-keys",
      "oauth-client-registrations",
      "provider-tokens",
      "connection-credentials",
      "connection-verification-state",
      "owner-onboarding-state",
      "runs-and-artifacts",
      "person-profiles",
      "content-state",
      "research-state",
      "meeting-state",
      "task-state",
      "transcript-catalog",
      "module-state-and-checkpoints",
      "intake-schedules",
      "calendar-schedule-and-checkpoints",
      "watch-channel-registrations",
      "non-auth-workflow-configuration",
      "mock-provider-state",
      "operating-system-metadata",
    ]);
    expect(remoteRecords(preview).every((record) => record.count === 0)).toBe(true);
    expect(remoteRecords(preview).map((record) => record.name)).toEqual([
      "google-tasklists",
      "google-drive-folders",
      "google-sheets-spreadsheets",
      "youtube-channels",
      "notion-databases",
      "asana-destinations",
    ]);
  });

  it("classifies every recognized credential category as authentication", () => {
    const categories = inventory(previewWorkspaceMigration(completeWorkspace("credentials")));

    /* The Shell's model key — the Meeting Brief guest profile key is
       retired (#136), so the Shell's model key is the only one left. */
    expect(categories.get("provider-api-keys")).toEqual(category("authentication", 1));
    /* The Google OAuth client id and secret. */
    expect(categories.get("oauth-client-registrations")).toEqual(category("authentication", 2));
    /* The Google refresh token, the Notion token, the HubSpot token. */
    expect(categories.get("provider-tokens")).toEqual(category("authentication", 3));
    /* The relay installation identifier and its secret. */
    expect(categories.get("connection-credentials")).toEqual(category("authentication", 2));
  });

  it("classifies connection verification metadata as disposable, not authentication", () => {
    const root = workspace("verification-metadata", {
      "config.json": {
        google: { lastConnectedAt: TIMESTAMP, hasExpiredBefore: true },
        notion: { lastVerifiedAt: TIMESTAMP },
        modules: {
          "meeting-brief-generator": {
            guestProfile: { lastVerifiedAt: TIMESTAMP },
            hubspot: { lastVerifiedAt: TIMESTAMP },
          },
        },
      },
    });

    const preview = previewWorkspaceMigration(root);
    expect(inventory(preview).get("connection-verification-state")).toEqual(
      category("disposable-product-state", 5),
    );
    /* The fixture holds no credential, registration, token or identifier. */
    expect(named(preview, "authentication")).toEqual([
      "provider-api-keys",
      "oauth-client-registrations",
      "provider-tokens",
      "connection-credentials",
    ]);
  });

  it("classifies Runs, profiles, product stores, schedules and checkpoints as disposable", () => {
    const categories = inventory(previewWorkspaceMigration(completeWorkspace("disposable")));

    expect(categories.get("runs-and-artifacts")).toEqual(category("disposable-product-state", 3));
    expect(categories.get("person-profiles")).toEqual(category("disposable-product-state", 3));
    expect(categories.get("content-state")).toEqual(category("disposable-product-state", 4));
    expect(categories.get("research-state")).toEqual(category("disposable-product-state", 2));
    /* Transcript ingest checkpoints live in state.json, alongside the relay wake-up. */
    expect(categories.get("module-state-and-checkpoints")).toEqual(
      category("disposable-product-state", 2),
    );
    expect(categories.get("intake-schedules")).toEqual(category("disposable-product-state", 1));
    expect(categories.get("calendar-schedule-and-checkpoints")).toEqual(
      category("disposable-product-state", 1),
    );
    expect(categories.get("watch-channel-registrations")).toEqual(
      category("disposable-product-state", 1),
    );
    /* When each connection was last verified, and whether Google has ever
       expired — operational metadata, not credentials. */
    expect(categories.get("connection-verification-state")).toEqual(
      category("disposable-product-state", 4),
    );
    /* Post-cutover workflow settings (including whether Asana is enabled)
       plus the 8 local values that name a remote record. The retired Notion
       calendar keys stay classified in the inventory for legacy Workspaces,
       but a clean config carries none. */
    expect(categories.get("non-auth-workflow-configuration")).toEqual(
      category("disposable-product-state", 31),
    );
    expect(categories.get("mock-provider-state")).toEqual(category("disposable-product-state", 1));
    expect(categories.get("operating-system-metadata")).toEqual(
      category("disposable-product-state", 1),
    );
  });

  it("deletes the local value that names a remote record and leaves the record standing", () => {
    const preview = previewWorkspaceMigration(completeWorkspace("remote"));

    /* Every one of these is a destination setting, so the local value goes with
       the rest of the non-auth workflow configuration — the reset must not
       restore an old destination — while the record it names is provider-owned. */
    expect(remoteRecords(preview)).toEqual([
      disclosure("google-tasklists", 1),
      disclosure("google-drive-folders", 2),
      disclosure("google-sheets-spreadsheets", 4),
      disclosure("youtube-channels", 1),
      disclosure("notion-databases", 0),
      /* A Workspace that never connected carries no Asana destination, so
         the record list names the category with nothing disclosed (issue #189). */
      disclosure("asana-destinations", 0),
    ]);
    const disclosed = remoteRecords(preview).reduce((total, record) => total + record.count, 0);
    expect(disclosed).toBe(8);
    /* Those same 8 values are on the delete side, inside the category every
       disclosure names, so nothing is preserved by being disclosed. */
    expect(inventory(preview).get("non-auth-workflow-configuration")).toEqual(
      category("disposable-product-state", 31),
    );
    /* No category answers "deleted or kept" with a remote reference: the
       destination gids drop with the rest of the non-auth configuration, and
       only the disclosure names the record they used to point at. */
    expect(named(preview, "remote-reference")).toEqual([]);
  });

  /* The migration's own directory is not Workspace state. A reset clears it
     before it reclassifies, but a preview only reads, so it has to read past
     the bookkeeping of a finished or interrupted run rather than fail closed
     on the artifact of the very reset it is previewing. */
  it("reads past its own bookkeeping instead of failing closed on it", () => {
    const root = workspace("own-bookkeeping", {
      "config.json": completeConfig(),
      "migration/receipt.json": { schemaVersion: 1 },
      "migration/completed.json": { migratedAt: TIMESTAMP },
      /* A rewrite a crash left staged, cleared by the next attempt. */
      "migration/config.json.tmp": completeConfig(),
    });

    const preview = previewWorkspaceMigration(root);

    /* Read past, not counted: no category grew by the three files, so the
       receipt cannot be reported as one more product record to delete. */
    expect(
      [...inventory(preview).values()].reduce((total, entry) => total + entry.count, 0),
    ).toEqual(
      [
        ...inventory(
          previewWorkspaceMigration(
            workspace("no-bookkeeping", {
              "config.json": completeConfig(),
            }),
          ),
        ).values(),
      ].reduce((total, entry) => total + entry.count, 0),
    );
  });

  it("fails closed on anything else the migration directory holds", () => {
    const root = workspace("foreign-bookkeeping", {
      "config.json": completeConfig(),
      "migration/completed.json": { migratedAt: TIMESTAMP },
      "migration/notes.txt": "something nobody classified",
    });

    /* Named by structure — the directory and the file inside it — never by
       what the file holds. */
    expect(findings(previewWorkspaceMigration(root))).toEqual([
      { entry: "migration", key: "notes.txt", reason: "unrecognized-entry" },
    ]);
  });

  it("keeps operating system metadata out of the fail-closed path", () => {
    const root = workspace("os-metadata", { ".DS_Store": "\u0000\u0000\u0000\u0001Bud1" });

    expect(inventory(previewWorkspaceMigration(root)).get("operating-system-metadata")).toEqual(
      category("disposable-product-state", 1),
    );
  });

  it("reports counts without any stored value", () => {
    const preview = previewWorkspaceMigration(completeWorkspace("content-free"));

    const serialized = JSON.stringify(preview);
    for (const value of STORED_VALUES) expect(serialized).not.toContain(value);
  });

  it("changes nothing in the Workspace it previews", () => {
    const root = completeWorkspace("read-only");
    const before = snapshot(root);

    previewWorkspaceMigration(root);

    expect(snapshot(root)).toEqual(before);
  });

  it("fails closed on a configuration key it cannot place on either side", () => {
    const root = workspace("unrecognized-key", {
      "config.json": { ...completeConfig(), sendgrid: { token: "an unclassified credential" } },
    });

    const preview = previewWorkspaceMigration(root);

    expect(findings(preview)).toEqual([
      { entry: "config.json", key: "sendgrid.token", reason: "unrecognized-key" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("an unclassified credential");
  });

  it("fails closed on an unknown key nested inside a composite configuration entry", () => {
    const root = workspace("nested-mapping-key", {
      /* A legacy pre-cutover config.json: the Notion calendar mapping no
         longer exists in the schema, but the reset still classifies these
         keys fail-closed, and a nested credential under a recognized entry
         must fail the preview closed, never ride in as disposable product
         state inside a recognized entry. */
      "config.json": legacyConfigWithNestedCredential(),
    });

    const preview = previewWorkspaceMigration(root);
    expect(findings(preview)).toEqual([
      {
        entry: "config.json",
        key: "modules.content-scout.notion.mapping.apiKey",
        reason: "unrecognized-key",
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain("a nested credential");
  });

  it("fails closed on an unknown key nested inside a stored watch channel", () => {
    const config = completeConfig();
    const root = workspace("nested-channel-key", {
      "config.json": {
        ...config,
        modules: {
          ...config.modules,
          "youtube-trends": {
            ...config.modules["youtube-trends"],
            channels: [
              {
                id: "UCyoutube",
                handle: "@found42",
                title: "Found42",
                uploadsPlaylistId: "UUyoutube",
                addedAt: TIMESTAMP,
                apiKey: "a channel credential",
              },
            ],
          },
        },
      },
    });

    const preview = previewWorkspaceMigration(root);
    expect(findings(preview)).toEqual([
      {
        entry: "config.json",
        key: "modules.youtube-trends.channels.0.apiKey",
        reason: "unrecognized-key",
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain("a channel credential");
  });

  it("fails closed on an unknown key nested inside a relay channel registration", () => {
    const root = workspace("nested-relay-key", {
      "relay.json": {
        installationId: "relay-installation-id",
        secret: "relay-installation-secret",
        relayBaseUrl: "https://relay.test",
        channels: [
          {
            channelId: "relay-channel-id",
            token: "relay-channel-token",
            resourceId: null,
            expiration: null,
            verification: "a relay channel credential",
          },
        ],
      },
    });

    const preview = previewWorkspaceMigration(root);
    expect(findings(preview)).toEqual([
      { entry: "relay.json", key: "channels.0.verification", reason: "unrecognized-key" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("a relay channel credential");
  });

  it("fails closed when a composite value does not match the schema it mirrors", () => {
    const config = completeConfig();
    const root = workspace("composite-malformed", {
      "config.json": {
        ...config,
        modules: {
          ...config.modules,
          "youtube-trends": {
            ...config.modules["youtube-trends"],
            channels: { id: "UCyoutube" },
          },
        },
      },
    });

    expect(findings(previewWorkspaceMigration(root))).toEqual([
      { entry: "config.json", key: "modules.youtube-trends.channels", reason: "malformed" },
    ]);
  });

  it("fails closed on a nested object where the schema holds a scalar", () => {
    const config = completeConfig();
    const root = workspace("nested-object-at-scalar", {
      "config.json": {
        ...config,
        modules: {
          ...config.modules,
          "idea-engine": {
            ...config.modules["idea-engine"],
            /* A prompt record's values are strings; an object parked under a
               prompt type is structure the shape does not declare. */
            prompts: { article: { apiKey: "a prompt credential" } },
          },
        },
      },
    });

    const preview = previewWorkspaceMigration(root);
    expect(findings(preview)).toEqual([
      { entry: "config.json", key: "modules.idea-engine.prompts.article", reason: "malformed" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("a prompt credential");
  });

  it("fails closed on a nested key inherited from Object.prototype", () => {
    const root = workspace("prototype-key", {
      /* "toString" must not resolve through Object.prototype to a truthy
         table entry that skips validation. */
      "config.json": legacyConfigWithNestedCredential({
        toString: { secret: "a mapping credential" },
      }),
    });

    const preview = previewWorkspaceMigration(root);
    expect(findings(preview)).toEqual([
      {
        entry: "config.json",
        key: "modules.content-scout.notion.mapping.toString",
        reason: "unrecognized-key",
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain("a mapping credential");
  });

  /* ADR-0062 put six new directories and one queue file in the Workspace. The
     boundary is one table with two consumers, so a writer that is not in it
     fails the preview closed and survives the generated-data clear. This drives
     the real store rather than a copied list of names, so a seventh directory
     fails here rather than in a Playwright journey. */
  it("inventories automatically researched dossier state with the Profiles it describes", () => {
    const root = workspace("person-dossiers");
    const dossiers = new PersonDossierStore(root);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ fullName: "Ada Fixture", primaryEmail: "ada@example.com" });
    const quote = "Ada Fixture maintains the fictional Ledger indexer.";
    const source = dossiers.retainSource({
      url: "https://example.com/ada",
      title: "Fictional source",
      author: null,
      publishedAt: null,
      retrievedAt: TIMESTAMP,
      text: quote,
      family: "example.com",
      sourceClass: "independent-account",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "public-search/website",
    });
    dossiers.publish(person.id, 0, {
      claims: [
        {
          id: "ledger",
          section: "work",
          statement: quote,
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: source.id, quote }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    });
    // Detaching writes the rejection record and a scrubbed revision; deleting writes the tombstone.
    dossiers.detach(person.id, source.id);
    dossiers.privacyDelete(person.id);
    new PersonResearchQueue({
      workspaceDir: root,
      people,
      research: {} as unknown as PersonResearch,
      enabled: () => true,
    }).configure({});

    const preview = previewWorkspaceMigration(root);

    expect(preview.outcome).toBe("inventory");
    expect(inventory(preview).get("person-profiles")?.classification).toBe(
      "disposable-product-state",
    );
    expect(inventory(preview).get("person-profiles")?.count).toBeGreaterThan(0);
  });

  /* The vocabulary itself, on an empty Workspace so no fixture's contents can
     stand in for it: every category a boundary table can assign has to be one
     the preview reports. `meeting-state` was assignable from DIRECTORIES while
     no preview ever named it, so a reset deleted the Meeting store and the
     inventory the owner reads before authorizing never mentioned it. A
     category that deletes without disclosing is the one failure this preview
     exists to prevent. */
  it("reports every category the boundary tables can assign", () => {
    const preview = previewWorkspaceMigration(workspace("boundary-vocabulary"));
    const reported = new Set(inventory(preview).keys());
    const assignable = new Set<string>([
      ...Object.values(DIRECTORIES),
      ...Object.values(WHOLE_FILES),
    ]);
    expect([...assignable].filter((name) => !reported.has(name)).sort()).toEqual([]);
  });

  /* Tasks became canonical Workspace state in #172 without joining the
     boundary, which broke both consumers at once: the migration preview failed
     closed on any Workspace holding a Task, and the generated-data clear —
     which shares this table and is reachable from Settings — deleted the
     Meetings and Debriefs that Action Items point at while leaving the Action
     Items themselves standing. Driving the real store means the next product
     area that writes a directory fails here. */
  it("inventories canonical Task state for both consumers of the boundary", () => {
    const root = workspace("task-state");
    const tasks = new TaskStore(root);
    tasks.writeTasks([]);
    tasks.writeActionItems([]);

    const preview = previewWorkspaceMigration(root);

    expect(preview.outcome).toBe("inventory");
    expect(inventory(preview).get("task-state")).toEqual({
      classification: "disposable-product-state",
      count: 2,
    });
    // The clear shares the table, so the same directory has to reach its inventory.
    expect(previewGeneratedData(root).entries.map((entry) => entry.name)).toContain("tasks");
  });

  it("fails closed on an unrecognized Workspace entry", () => {
    const root = workspace("unrecognized-entry", { "future-store/record.json": { a: 1 } });

    expect(findings(previewWorkspaceMigration(root))).toEqual([
      { entry: "future-store", key: null, reason: "unrecognized-entry" },
    ]);
  });

  it("fails closed on a malformed Workspace", () => {
    const malformed = '{"google":{"refreshToken":"a token that must not leak"';
    const root = workspace("malformed", { "config.json": malformed, "relay.json": "[]" });

    const preview = previewWorkspaceMigration(root);

    expect([...findings(preview)].sort((a, b) => a.entry.localeCompare(b.entry))).toEqual([
      { entry: "config.json", key: null, reason: "unreadable" },
      { entry: "relay.json", key: null, reason: "unreadable" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("a token that must not leak");
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(malformed);
  });
});
