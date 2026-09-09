import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The destructive boundary of the consolidation cutover, as a read-only inventory
 * — issue://119, ADR-0043.
 *
 * The preview classifies every local persistence category the Workspace can hold
 * and reports nothing but category names and counts, so a person can see what a
 * reset would take and what it would keep without any stored value being shown.
 * The preview itself reads and never writes; the reset (issue://144) shares this
 * module and deletes, rewrites, and marks exactly what the preview classifies.
 * Neither ever calls a provider: the reset's validation reads the rewritten
 * files back and checks structure, never reachability.
 *
 * `config.json` and `relay.json` each hold authentication material and product
 * state in one file. They are parsed key by key against an explicit table rather
 * than preserved wholesale, and a key the table does not name fails the whole
 * preview closed: an unclassifiable key is exactly the ambiguity the reset must
 * never guess its way through.
 *
 * Composite entries — a channel list, a prompt record, a destination mapping,
 * a list of declined adapters —
 * are validated to the leaves their schema declares, so a credential nested
 * inside one fails closed exactly like an unknown key at the top.
 *
 * A remote reference is not a third answer to "does the reset delete this?". A
 * spreadsheet id is non-auth workflow configuration: the local value goes with
 * everything else, and the spreadsheet it names is provider-owned and survives
 * untouched. The preview states both, because a reader who saw only the first
 * would delete a spreadsheet and a reader who saw only the second would restore
 * an old destination.
 */

/** Where one piece of local persistence sits relative to the destructive boundary. */
export type WorkspaceMigrationClassification =
  "authentication" | "disposable-product-state" | "remote-reference" | "unsafe-mixed-state";

/**
 * The only two answers to "does the reset delete this?". `remote-reference` is
 * not one of them — it describes what a local value points at, not whether that
 * value survives — and `unsafe-mixed-state` ends the preview instead of joining it.
 */
export type WorkspaceMigrationDisposition = Extract<
  WorkspaceMigrationClassification,
  "authentication" | "disposable-product-state"
>;

/**
 * One inventoried category. `count` is the number of records it holds: files for
 * a directory- or file-backed category, stored values for a configuration one.
 */
export interface WorkspaceMigrationCategory {
  name: string;
  classification: WorkspaceMigrationDisposition;
  count: number;
}

/**
 * A kind of provider-owned record that local values name — a Sheet, a Drive
 * folder, a Notion database. Disclosed so the reset cannot mistake a pointer for
 * the thing it points at: the local values are deleted, counted in
 * `localCategory` like any other non-auth configuration, and the records
 * themselves are left exactly as they are.
 */
export interface RemoteRecordDisclosure {
  name: string;
  classification: Extract<WorkspaceMigrationClassification, "remote-reference">;
  /** How many local values name a record of this kind. */
  count: number;
  /** The category those local values are deleted with. */
  localCategory: string;
  /** Always false. No reset deletes provider-owned data. */
  deletedByReset: false;
}

/** Why the boundary could not be drawn. Names structure — a file, a key — never a stored value. */
export interface UnsafeMixedStateFinding {
  /** A recognized Workspace entry, or the unrecognized entry's own name. */
  entry: string;
  /**
   * A dotted key path inside a recognized mixed file, the name of an entry
   * inside a recognized directory, or null when the entry itself is the
   * finding. Structure either way — never a stored value.
   */
  key: string | null;
  /**
   * `unreadable`: not valid JSON, or not a JSON object. `malformed`: a
   * composite value whose structure does not match the schema it mirrors.
   */
  reason: "unreadable" | "malformed" | "unrecognized-key" | "unrecognized-entry";
}

export type WorkspaceMigrationPreview =
  | {
      outcome: "inventory";
      categories: WorkspaceMigrationCategory[];
      remoteRecords: RemoteRecordDisclosure[];
    }
  | { outcome: "unsafe-mixed-state"; findings: UnsafeMixedStateFinding[] };

/** One category in the Workspace boundary tables. Shared with the repeatable generated-data clear. */
export type CategoryName =
  | "provider-api-keys"
  | "oauth-client-registrations"
  | "provider-tokens"
  | "connection-credentials"
  | "connection-verification-state"
  | "owner-onboarding-state"
  | "runs-and-artifacts"
  | "person-profiles"
  | "content-state"
  | "meeting-state"
  | "task-state"
  | "research-state"
  | "transcript-catalog"
  | "module-state-and-checkpoints"
  | "intake-schedules"
  | "calendar-schedule-and-checkpoints"
  | "watch-channel-registrations"
  | "non-auth-workflow-configuration"
  | "mock-provider-state"
  | "operating-system-metadata";

/** A kind of provider-owned record local values point at. */
type RemoteRecordName =
  | "google-tasklists"
  | "google-drive-folders"
  | "google-sheets-spreadsheets"
  | "youtube-channels"
  | "notion-databases"
  | "asana-destinations";

/**
 * A table value whose flat key stops at a composite — an array or object. The
 * whole value is counted into `category` like any other entry, but its interior
 * is validated key by key against `shape` before it is, so a credential added
 * under a composite fails closed instead of riding in as product state.
 */
interface CompositeEntry {
  category: CategoryName | RemoteRecordName;
  shape: CompositeShape;
}

/**
 * The interior of a `CompositeEntry`, mirroring the schema that entry mirrors.
 * An `object` declares every key it allows — one it does not fails closed. An
 * `array` validates every element, indexed by position, which is structure. A
 * `record` holds free keys by the schema's own definition, so a key there is
 * recognized by construction and only its value is validated. A `scalar` is a
 * leaf: nothing can be nested inside one.
 */
type CompositeShape =
  | { kind: "object"; keys: Record<string, CompositeShape> }
  | { kind: "array"; elements: CompositeShape }
  | { kind: "record"; values: CompositeShape }
  | { kind: "scalar" };

/** One `config.json` or `relay.json` table value. */
type TableEntry = CategoryName | RemoteRecordName | CompositeEntry;

/**
 * Every category the preview reports, in the order it reports them. A category
 * with nothing in it is still reported, at zero, so the boundary reads the same
 * for an empty Workspace as for a full one.
 */
const CATEGORIES: ReadonlyArray<readonly [CategoryName, WorkspaceMigrationDisposition]> = [
  ["provider-api-keys", "authentication"],
  ["oauth-client-registrations", "authentication"],
  ["provider-tokens", "authentication"],
  ["connection-credentials", "authentication"],
  /* When each connection was last verified, and whether Google has ever seen a
     grant expire — operational metadata, not a credential. The spec preserves
     tokens, keys, client registrations, identifiers and secrets, never the
     health check that watched them work. */
  ["connection-verification-state", "disposable-product-state"],
  /* The owner confirmation is product state the onboarding flow writes, not a
     credential: a reset deletes it and onboarding asks for it again. */
  ["owner-onboarding-state", "disposable-product-state"],
  ["runs-and-artifacts", "disposable-product-state"],
  ["person-profiles", "disposable-product-state"],
  ["content-state", "disposable-product-state"],
  ["research-state", "disposable-product-state"],
  /* The durable Meeting store, and the canonical Tasks and Action Items the
     Debrief materializes into. Both are assignable from DIRECTORIES, so both
     have to be reported: a category the reset deletes but the preview never
     names is a deletion the owner authorizes without being told about it. */
  ["meeting-state", "disposable-product-state"],
  ["task-state", "disposable-product-state"],
  /* The Transcript Catalog's retained corpus, identity decisions, relevance
     candidates and its tombstones and deletion receipts. */
  ["transcript-catalog", "disposable-product-state"],
  ["module-state-and-checkpoints", "disposable-product-state"],
  ["intake-schedules", "disposable-product-state"],
  ["calendar-schedule-and-checkpoints", "disposable-product-state"],
  ["watch-channel-registrations", "disposable-product-state"],
  ["non-auth-workflow-configuration", "disposable-product-state"],
  ["mock-provider-state", "disposable-product-state"],
  ["operating-system-metadata", "disposable-product-state"],
];

/**
 * Every kind of provider-owned record the preview discloses, in the order it
 * discloses them. Like a category, one with nothing in it is still reported.
 */
const REMOTE_RECORDS: readonly RemoteRecordName[] = [
  "google-tasklists",
  "google-drive-folders",
  "google-sheets-spreadsheets",
  "youtube-channels",
  "notion-databases",
  "asana-destinations",
];

/** Directories whose every file belongs to one category. The migration's delete side and the
    repeatable generated-data clear both act on exactly this table — one boundary, two consumers. */
export const DIRECTORIES: Readonly<Record<string, CategoryName>> = {
  runs: "runs-and-artifacts",
  "person-profiles": "person-profiles",
  "person-profile-tombstones": "person-profiles",
  "person-profile-deletion-receipts": "person-profiles",
  /* ADR-0062: a Profile's automatically researched dossier, its revisions, the
     source documents its claims quote, and the rejection and tombstone records
     that keep a detached source or a deleted person from being researched back
     into existence. Every one of them is generated from public and Workspace
     material, so the reset takes them with the Profiles they describe. */
  "person-dossiers": "person-profiles",
  "person-dossier-revisions": "person-profiles",
  "person-dossier-rejections": "person-profiles",
  "person-dossier-tombstones": "person-profiles",
  "person-source-documents": "person-profiles",
  "person-source-families": "person-profiles",
  "content-scout": "content-state",
  "content-engine": "content-state",
  "content-research": "research-state",
  /* ADR-0050: the durable Meeting store the Meeting Wizard and Brief read.
     Without this row the migration preview fails closed on every Workspace
     that has recorded a Meeting, and the generated-data clear leaves it. */
  meetings: "meeting-state",
  /* ADR-0058: the Tasks product area's canonical Tasks, Task Lists and the
     Action Items a Debrief proposed. Without this row the preview fails closed
     on any Workspace holding a Task, and the generated-data clear deletes the
     Meetings and Debriefs those Action Items cite while leaving the Action
     Items themselves behind. */
  tasks: "task-state",
  "transcript-catalog": "transcript-catalog",
  onboarding: "owner-onboarding-state",
};

/** Files that hold no authentication material, so the whole file is one record. Shared with the
    repeatable generated-data clear, same as DIRECTORIES. */
export const WHOLE_FILES: Readonly<Record<string, CategoryName>> = {
  // Drive Intake's ingested transcript ids, YouTube Trends' last run day, Idea Engine's ingested ids.
  "state.json": "module-state-and-checkpoints",
  "intake-schedules.json": "intake-schedules",
  // The dossier research queue: allowances, job states and their retry bookkeeping.
  "person-research.json": "person-profiles",
  // The Calendar watch channel and sync checkpoint are re-established after a reset, never preserved.
  "meeting-brief-calendar.json": "calendar-schedule-and-checkpoints",
  "mock-result.json": "mock-provider-state",
  /* Named rather than ignored: the Workspace of anyone who has opened it on a
     Mac holds one of these, and OS metadata is not the ambiguity the fail-closed
     path is for. Leaving it unnamed would block every real preview and invite
     the next person to loosen the rule that matters. */
  ".DS_Store": "operating-system-metadata",
  "._.DS_Store": "operating-system-metadata",
  "Thumbs.db": "operating-system-metadata",
  "desktop.ini": "operating-system-metadata",
};

/**
 * `config.json`, key by key. Mirrors `ConfigSchema`; an addition there must land
 * here too. A `CategoryName` names the category the stored value is counted in.
 * A `RemoteRecordName` says the value names a provider-owned record of that
 * kind: it is counted as non-auth workflow configuration like any other
 * destination setting, so the reset deletes it, and it is disclosed so the reset
 * knows the record it named is not its to delete. A `CompositeEntry` marks a
 * value the flat key stops at — a channel list, a prompt record, a destination
 * mapping — counted whole, but validated to the leaves its schema declares.
 */
const SCALAR: CompositeShape = { kind: "scalar" };

const composite = (
  category: CategoryName | RemoteRecordName,
  shape: CompositeShape,
): CompositeEntry => ({ category, shape });

const PURPOSE_MODELS: CompositeShape = {
  kind: "object",
  keys: {
    personResearch: SCALAR,
    researchPlanning: SCALAR,
    evaluationJudge: SCALAR,
    contentGeneration: SCALAR,
    contentDiscovery: SCALAR,
    contentResearch: SCALAR,
    meetingBrief: SCALAR,
    meetingDebrief: SCALAR,
  },
};
const CONFIG_KEYS: Record<string, TableEntry> = {
  provider: "non-auth-workflow-configuration",
  model: "non-auth-workflow-configuration",
  models: composite("non-auth-workflow-configuration", {
    kind: "object",
    keys: {
      openai: PURPOSE_MODELS,
      anthropic: PURPOSE_MODELS,
      openrouter: PURPOSE_MODELS,
      gemini: PURPOSE_MODELS,
      ollama: PURPOSE_MODELS,
      mock: PURPOSE_MODELS,
    },
  }),
  apiKey: "provider-api-keys",
  tasklistName: "google-tasklists",
  "google.clientId": "oauth-client-registrations",
  "google.clientSecret": "oauth-client-registrations",
  "google.refreshToken": "provider-tokens",
  "google.lastConnectedAt": "connection-verification-state",
  "google.hasExpiredBefore": "connection-verification-state",
  "notion.token": "provider-tokens",
  "notion.lastVerifiedAt": "connection-verification-state",
  "drive.enabled": "non-auth-workflow-configuration",
  "drive.folderId": "google-drive-folders",
  "drive.folderName": "google-drive-folders",
  "drive.pollIntervalMinutes": "non-auth-workflow-configuration",
  /* The Action Item Policy (issue #181): a Workspace-local preference about
     how a proposal is reviewed. It names no remote record and holds no
     credential, so a reset returns it to Stage all with the rest of the
     workflow configuration. */
  "tasks.actionItemPolicy": "non-auth-workflow-configuration",
  /* The Google Tasks destination (issue #184): a choice about where work is
     filed, and the id of a Google-owned Task List. Neither is a credential —
     the grant itself lives in `google.refreshToken`. */
  "tasks.googleTasks.enabled": "non-auth-workflow-configuration",
  "tasks.googleTasks.taskListId": "google-tasklists",
  "tasks.googleTasks.taskListTitle": "google-tasklists",
  /* The Asana destination (issue #189): a personal access token, the fact it
     was verified, and the workspace/project/section it files work into. The
     gids and names point at Asana-owned records the reset never touches. */
  "tasks.asana.token": "provider-tokens",
  "tasks.asana.lastVerifiedAt": "connection-verification-state",
  "tasks.asana.enabled": "non-auth-workflow-configuration",
  "tasks.asana.workspaceGid": "asana-destinations",
  "tasks.asana.workspaceName": "asana-destinations",
  "tasks.asana.projectGid": "asana-destinations",
  "tasks.asana.projectName": "asana-destinations",
  "tasks.asana.sectionGid": "asana-destinations",
  "tasks.asana.sectionName": "asana-destinations",
  "ollama.baseUrl": "non-auth-workflow-configuration",
  "search.searxngUrl": "non-auth-workflow-configuration",
  "modules.youtube-trends.channels": composite("youtube-channels", {
    kind: "array",
    elements: {
      kind: "object",
      keys: {
        id: SCALAR,
        handle: SCALAR,
        title: SCALAR,
        uploadsPlaylistId: SCALAR,
        addedAt: SCALAR,
      },
    },
  }),
  "modules.youtube-trends.spreadsheetId": "google-sheets-spreadsheets",
  "modules.youtube-trends.spreadsheetUrl": "google-sheets-spreadsheets",
  "modules.idea-engine.spreadsheetId": "google-sheets-spreadsheets",
  "modules.idea-engine.spreadsheetUrl": "google-sheets-spreadsheets",
  /* The schema keys a prompt record freely (an idea content type), so a key
     here is recognized by construction; its value must still be a scalar. */
  "modules.idea-engine.prompts": composite("non-auth-workflow-configuration", {
    kind: "record",
    values: SCALAR,
  }),
  "modules.content-scout.timeZone": "non-auth-workflow-configuration",
  "modules.content-scout.dailyTime": "non-auth-workflow-configuration",
  "modules.content-scout.weeklyDiscoveryDay": "non-auth-workflow-configuration",
  "modules.content-scout.weeklyDiscoveryTime": "non-auth-workflow-configuration",
  "modules.content-scout.shortlistSize": "non-auth-workflow-configuration",
  "modules.content-scout.canaryIntervalHours": "non-auth-workflow-configuration",
  "modules.content-scout.canaryDisabledAdapters": composite("non-auth-workflow-configuration", {
    kind: "array",
    elements: SCALAR,
  }),
  "modules.content-scout.notion.databaseId": "notion-databases",
  "modules.content-scout.notion.dataSourceId": "notion-databases",
  "modules.content-scout.notion.databaseUrl": "notion-databases",
  "modules.content-scout.notion.mapping": composite("non-auth-workflow-configuration", {
    kind: "object",
    keys: {
      name: SCALAR,
      status: SCALAR,
      platform: SCALAR,
      format: SCALAR,
      scheduledDate: SCALAR,
    },
  }),
  "modules.content-research.timeZone": "non-auth-workflow-configuration",
  "modules.content-research.dailyTime": "non-auth-workflow-configuration",
  "modules.content-research.weeklyDiscoveryDay": "non-auth-workflow-configuration",
  "modules.content-research.weeklyDiscoveryTime": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.internalDomains": composite("non-auth-workflow-configuration", {
    kind: "array",
    elements: SCALAR,
  }),
  "modules.meeting-brief-generator.guestProfile.endpoint": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.guestProfile.apiKey": "provider-api-keys",
  "modules.meeting-brief-generator.guestProfile.lastVerifiedAt": "connection-verification-state",
  // Health diagnostics regenerate on the next check; they are not what keeps a connection working.
  "modules.meeting-brief-generator.guestProfile.lastCheckAt": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.guestProfile.lastCheckState": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.guestProfile.lastCheckDetail": "non-auth-workflow-configuration",
  "modules.meeting-brief-generator.hubspot.token": "provider-tokens",
  "modules.meeting-brief-generator.hubspot.lastVerifiedAt": "connection-verification-state",
  /* Recorded provider-policy actions (issue #137). The schema keys the record
     by provider id, so a key here is recognized by construction; the action
     itself is an object, and its three fields are what the reset drops with
     the rest of the workflow configuration — a re-enabled provider is a
     decision the owner makes again after the cutover, not one restored. */
  "modules.meeting-brief-generator.providerPolicy": composite("non-auth-workflow-configuration", {
    kind: "record",
    values: {
      kind: "object",
      keys: { disabled: SCALAR, changedAt: SCALAR, reason: SCALAR },
    },
  }),
};

/** `relay.json`, key by key. The installation identity and its secret authenticate the relay. */
const RELAY_KEYS: Record<string, TableEntry> = {
  installationId: "connection-credentials",
  secret: "connection-credentials",
  relayBaseUrl: "non-auth-workflow-configuration",
  channels: composite("watch-channel-registrations", {
    kind: "array",
    elements: {
      kind: "object",
      keys: { channelId: SCALAR, token: SCALAR, resourceId: SCALAR, expiration: SCALAR },
    },
  }),
  lastWakeUpAt: "module-state-and-checkpoints",
};

const MIXED_FILES: Record<string, Record<string, TableEntry>> = {
  "config.json": CONFIG_KEYS,
  "relay.json": RELAY_KEYS,
};

function isRemoteRecord(name: CategoryName | RemoteRecordName): name is RemoteRecordName {
  return (REMOTE_RECORDS as readonly string[]).includes(name);
}

function isCompositeEntry(entry: TableEntry): entry is CompositeEntry {
  return typeof entry === "object";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many stored records one value holds. An unset credential holds none. */
function recordCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length > 0 ? 1 : 0;
  return 1;
}

/* The migration's own bookkeeping, shared by the preview and the reset: the
   receipt and marker a completed run writes, and the rewrite an interrupted one
   left staged. Declared here because the preview is what meets them first. */
const MIGRATION_DIRECTORY = "migration";
const MIGRATION_MARKER_FILE = "completed.json";
const MIGRATION_RECEIPT_FILE = "receipt.json";

/** Whether one file inside the migration directory is this module's own. */
function isMigrationBookkeeping(name: string): boolean {
  if (name === MIGRATION_MARKER_FILE || name === MIGRATION_RECEIPT_FILE) return true;
  return name.endsWith(".tmp") && Object.hasOwn(MIXED_FILES, name.slice(0, -".tmp".length));
}

function countFiles(directory: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1;
  }
  return count;
}

export function previewWorkspaceMigration(workspaceDir: string): WorkspaceMigrationPreview {
  const counts = new Map<CategoryName, number>();
  const remoteCounts = new Map<RemoteRecordName, number>();
  const findings: UnsafeMixedStateFinding[] = [];
  /* A remote reference is counted twice on purpose, once on each axis: the local
     value is deleted with the non-auth workflow configuration, and the record it
     names is disclosed as one the reset leaves standing. */
  const add = (name: CategoryName | RemoteRecordName, count: number): void => {
    if (isRemoteRecord(name)) {
      remoteCounts.set(name, (remoteCounts.get(name) ?? 0) + count);
      add("non-auth-workflow-configuration", count);
      return;
    }
    counts.set(name, (counts.get(name) ?? 0) + count);
  };

  const entries = existsSync(workspaceDir)
    ? readdirSync(workspaceDir, { withFileTypes: true })
    : [];
  for (const entry of entries) {
    const directory = entry.isDirectory() ? DIRECTORIES[entry.name] : undefined;
    if (directory) {
      add(directory, countFiles(join(workspaceDir, entry.name)));
      continue;
    }
    const wholeFile = entry.isFile() ? WHOLE_FILES[entry.name] : undefined;
    if (wholeFile) {
      add(wholeFile, 1);
      continue;
    }
    const table = entry.isFile() ? MIXED_FILES[entry.name] : undefined;
    if (table) {
      classifyMixedFile(join(workspaceDir, entry.name), entry.name, table, add, findings);
      continue;
    }
    if (entry.isDirectory() && entry.name === MIGRATION_DIRECTORY) {
      /* Not Workspace state, and so counted in no category: this module's own
         record of a finished or interrupted run. The preview only reads, so it
         reads past the bookkeeping rather than failing closed on the artifact
         of the very reset it is previewing — the reset clears it itself before
         it reclassifies. Anything else in there is unclassified all the same. */
      for (const child of readdirSync(join(workspaceDir, entry.name), { withFileTypes: true })) {
        if (child.isFile() && isMigrationBookkeeping(child.name)) continue;
        findings.push({
          entry: MIGRATION_DIRECTORY,
          key: child.name,
          reason: "unrecognized-entry",
        });
      }
      continue;
    }
    findings.push({ entry: entry.name, key: null, reason: "unrecognized-entry" });
  }

  if (findings.length > 0) return { outcome: "unsafe-mixed-state", findings };
  return {
    outcome: "inventory",
    categories: CATEGORIES.map(([name, classification]) => ({
      name,
      classification,
      count: counts.get(name) ?? 0,
    })),
    remoteRecords: REMOTE_RECORDS.map((name) => ({
      name,
      classification: "remote-reference",
      count: remoteCounts.get(name) ?? 0,
      localCategory: "non-auth-workflow-configuration",
      deletedByReset: false,
    })),
  };
}

function classifyMixedFile(
  path: string,
  entry: string,
  table: Record<string, TableEntry>,
  add: (name: CategoryName | RemoteRecordName, count: number) => void,
  findings: UnsafeMixedStateFinding[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    findings.push({ entry, key: null, reason: "unreadable" });
    return;
  }
  if (!isPlainObject(parsed)) {
    findings.push({ entry, key: null, reason: "unreadable" });
    return;
  }
  const walk = (node: unknown, key: string): void => {
    /* Own-name lookup: a key like "toString" must not resolve through
       Object.prototype to a truthy entry that skips validation. */
    const tableEntry = Object.hasOwn(table, key) ? table[key] : undefined;
    if (tableEntry) {
      if (isCompositeEntry(tableEntry)) {
        add(tableEntry.category, recordCount(node));
        validateComposite(node, tableEntry.shape, key, entry, findings);
        return;
      }
      add(tableEntry, recordCount(node));
      return;
    }
    if (isPlainObject(node)) {
      for (const [child, value] of Object.entries(node))
        walk(value, key ? `${key}.${child}` : child);
      return;
    }
    findings.push({ entry, key, reason: "unrecognized-key" });
  };
  walk(parsed, "");
}

/**
 * Validate a composite value against the shape its table entry declares, so a
 * key nested below a recognized composite faces the same fail-closed rule as a
 * key at the top: nothing is counted that was not deliberately parsed.
 */
function validateComposite(
  node: unknown,
  shape: CompositeShape,
  key: string,
  entry: string,
  findings: UnsafeMixedStateFinding[],
): void {
  switch (shape.kind) {
    case "scalar":
      /* A leaf must be a leaf. Null is one — the schema's nullable channel
         fields store it — but an object or array parked where the schema
         holds a scalar is structure the shape does not declare. */
      if (isPlainObject(node) || Array.isArray(node))
        findings.push({ entry, key, reason: "malformed" });
      return;
    case "object": {
      if (!isPlainObject(node)) {
        findings.push({ entry, key, reason: "malformed" });
        return;
      }
      for (const [child, value] of Object.entries(node)) {
        const childKey = `${key}.${child}`;
        const childShape = Object.hasOwn(shape.keys, child) ? shape.keys[child] : undefined;
        if (childShape) validateComposite(value, childShape, childKey, entry, findings);
        else findings.push({ entry, key: childKey, reason: "unrecognized-key" });
      }
      return;
    }
    case "array": {
      if (!Array.isArray(node)) {
        findings.push({ entry, key, reason: "malformed" });
        return;
      }
      /* An element's index is structure, like a key — never a stored value. */
      node.forEach((element, index) =>
        validateComposite(element, shape.elements, `${key}.${index}`, entry, findings),
      );
      return;
    }
    case "record": {
      if (!isPlainObject(node)) {
        findings.push({ entry, key, reason: "malformed" });
        return;
      }
      for (const [child, value] of Object.entries(node))
        validateComposite(value, shape.values, `${key}.${child}`, entry, findings);
      return;
    }
  }
}

/**
 * The destructive half of the consolidation cutover — issue://144. The reset
 * re-runs the fail-closed classifier at execute time, never trusting a stale
 * inventory, then deletes what the classifier named disposable, rewrites the
 * two mixed files down to their authentication keys, and leaves a content-free
 * receipt and a one-time marker. A staged rewrite is renamed into place, so a
 * crash can never tear a mixed file, and the marker is written last: until it
 * exists, the next attempt classifies the Workspace as required and finishes
 * the interrupted reset. Deletion is restart-safe by construction — a record
 * an earlier attempt already removed is simply absent.
 */

/** The three answers to "where does this Workspace stand in the cutover?". */
export type MigrationState = "fresh" | "required" | "completed";

/**
 * The content-free record a completed reset leaves behind: counts, never paths,
 * key names, or stored values. `directories` and `files` count the product
 * directories and whole-file records the reset deleted, mirroring the boundary
 * tables above.
 */
export interface MigrationReceipt {
  schemaVersion: 1;
  migratedAt: string; // ISO timestamp
  durationMs: number;
  categories: {
    directories: number;
    files: number;
    preservedConfigKeys: number;
    droppedConfigKeys: number;
    preservedRelayKeys: number;
    droppedRelayKeys: number;
  };
}

/**
 * The exact confirmation phrase the reset requires, in the house pattern of
 * `PERSON_PROFILE_PRIVACY_DELETE_CONFIRMATION` and
 * `TRANSCRIPT_DELETE_CONFIRMATION`: typed character for character, never
 * normalized, and checked before anything is read or written.
 */
export const MIGRATION_CONFIRMATION_PHRASE = "RESET WORKSPACE";

/** How one reset attempt ended. A `confirmation-mismatch` or `unsafe-mixed-state` changed nothing. */
export type WorkspaceMigrationResult =
  | { outcome: "completed"; receipt: MigrationReceipt }
  | { outcome: "already-completed" }
  | { outcome: "confirmation-mismatch" }
  | { outcome: "unsafe-mixed-state"; findings: UnsafeMixedStateFinding[] };

/** The categories whose stored values a reset keeps, derived from the same table the preview reports. */
const AUTHENTICATION_CATEGORIES: Record<string, true> = Object.fromEntries(
  CATEGORIES.filter(([, classification]) => classification === "authentication").map(([name]) => [
    name,
    true as const,
  ]),
);

/**
 * Where the Workspace stands. `completed` is the marker's word alone. `fresh`
 * holds nothing the classifier would even read — no mixed file, no product
 * directory, no whole-file product record — so there is nothing a reset would
 * change; a Workspace directory that does not exist is fresh by definition.
 */
export function readMigrationState(workspaceDir: string): MigrationState {
  if (existsSync(join(workspaceDir, MIGRATION_DIRECTORY, MIGRATION_MARKER_FILE)))
    return "completed";
  if (!existsSync(workspaceDir)) return "fresh";
  return readdirSync(workspaceDir, { withFileTypes: true }).some(
    (entry) =>
      Object.hasOwn(MIXED_FILES, entry.name) ||
      Object.hasOwn(DIRECTORIES, entry.name) ||
      Object.hasOwn(WHOLE_FILES, entry.name),
  )
    ? "required"
    : "fresh";
}

/** The receipt a completed reset left, or null when there is none or it cannot be read. */
export function readMigrationReceipt(workspaceDir: string): MigrationReceipt | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(workspaceDir, MIGRATION_DIRECTORY, MIGRATION_RECEIPT_FILE), "utf8"),
    );
    if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) return null;
    return parsed as unknown as MigrationReceipt;
  } catch {
    return null;
  }
}

/** A dotted table key's value in a document, or undefined when the key is absent. */
function valueAt(document: Record<string, unknown>, key: string): unknown {
  let node: unknown = document;
  for (const part of key.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Sets a dotted table key in a document, creating the intermediate objects it needs. */
function setDotted(document: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  const leaf = parts.pop();
  /* A table key is never empty, so the leaf always exists. */
  if (leaf === undefined) throw new Error(`cannot set the empty key in a rewrite`);
  let node = document;
  for (const part of parts) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[leaf] = value;
}

/**
 * Sorts one mixed file's stored keys into the authentication values a reset
 * keeps and the keys it drops. Mirrors the classifier's walk: a recognized
 * table entry decides its whole value, and everything the tables do not name
 * has already failed the classifier closed, so nothing unrecognized arrives.
 */
function splitTable(
  parsed: Record<string, unknown>,
  table: Record<string, TableEntry>,
): { preserved: Map<string, unknown>; dropped: string[] } {
  const preserved = new Map<string, unknown>();
  const dropped: string[] = [];
  const walk = (node: unknown, key: string): void => {
    const tableEntry = Object.hasOwn(table, key) ? table[key] : undefined;
    if (tableEntry) {
      const category = isCompositeEntry(tableEntry) ? tableEntry.category : tableEntry;
      if (AUTHENTICATION_CATEGORIES[category]) preserved.set(key, node);
      else dropped.push(key);
      return;
    }
    if (isPlainObject(node))
      for (const [child, value] of Object.entries(node))
        walk(value, key ? `${key}.${child}` : child);
  };
  walk(parsed, "");
  return { preserved, dropped };
}

/** The rewrite plan for one mixed file: the document that keeps only its authentication keys. */
interface TableRewrite {
  entry: string;
  document: Record<string, unknown>;
  preserved: Map<string, unknown>;
  dropped: string[];
}

/** Plans the rewrite of one mixed file, or returns null when the file does not exist. */
function planTableRewrite(
  workspaceDir: string,
  entry: string,
  table: Record<string, TableEntry>,
): TableRewrite | null {
  const path = join(workspaceDir, entry);
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  /* Unreachable behind a classifier that just passed: a non-object mixed file fails closed there. */
  if (!isPlainObject(parsed)) return null;
  const { preserved, dropped } = splitTable(parsed, table);
  const document: Record<string, unknown> = {};
  for (const [key, value] of preserved) setDotted(document, key, value);
  return { entry, document, preserved, dropped };
}

/**
 * The reset's own invariant, checked before anything is deleted: every
 * authentication value the source held survives the rewrite present — and
 * non-empty where the source held one — and every dropped key is gone.
 * Structure only: no value is compared to anything external and no provider is
 * asked anything.
 */
function assertRewriteKeepsAuthentication(rewrite: TableRewrite): void {
  for (const [key, value] of rewrite.preserved) {
    const kept = valueAt(rewrite.document, key);
    if (kept === undefined)
      throw new Error(`the reset lost the preserved ${rewrite.entry} key "${key}"`);
    if (recordCount(value) > 0 && recordCount(kept) === 0)
      throw new Error(`the reset emptied the preserved ${rewrite.entry} key "${key}"`);
  }
  for (const key of rewrite.dropped) {
    if (valueAt(rewrite.document, key) !== undefined)
      throw new Error(`the reset kept the dropped ${rewrite.entry} key "${key}"`);
  }
}

/**
 * Removes this module's own bookkeeping from an interrupted run — a staged
 * rewrite, a receipt, a marker — so the fail-closed classifier re-reads only
 * Workspace state. A `migration` directory holding anything else survives this
 * and fails the preview closed below, like any unrecognized entry.
 */
function clearMigrationBookkeeping(workspaceDir: string): void {
  const directory = join(workspaceDir, MIGRATION_DIRECTORY);
  if (!existsSync(directory)) return;
  for (const name of [
    MIGRATION_MARKER_FILE,
    MIGRATION_RECEIPT_FILE,
    ...Object.keys(MIXED_FILES).map((file) => `${file}.tmp`),
  ])
    rmSync(join(directory, name), { force: true });
  try {
    rmdirSync(directory);
  } catch {
    /* Not ours alone — the classifier fails closed on it. */
  }
}

/**
 * Writes a rewritten mixed file so a crash can never tear it: the new content
 * is staged inside the migration directory and renamed over the file, which is
 * atomic within one filesystem. A staged file a crash leaves behind is this
 * module's own bookkeeping and is cleared on the next attempt.
 */
function writeRewrite(
  workspaceDir: string,
  entry: string,
  document: Record<string, unknown>,
): void {
  const migrationDirectory = join(workspaceDir, MIGRATION_DIRECTORY);
  mkdirSync(migrationDirectory, { recursive: true });
  const staged = join(migrationDirectory, `${entry}.tmp`);
  writeFileSync(staged, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  renameSync(staged, join(workspaceDir, entry));
}

export function executeWorkspaceMigration(
  workspaceDir: string,
  input: { typedConfirmation: string },
): WorkspaceMigrationResult {
  /* The confirmation is checked before anything is read or written — a
     mismatched phrase changes nothing, byte for byte. */
  if (input.typedConfirmation !== MIGRATION_CONFIRMATION_PHRASE)
    return { outcome: "confirmation-mismatch" };
  if (!existsSync(workspaceDir)) throw new Error("the Workspace directory to reset does not exist");
  if (existsSync(join(workspaceDir, MIGRATION_DIRECTORY, MIGRATION_MARKER_FILE)))
    return { outcome: "already-completed" };

  clearMigrationBookkeeping(workspaceDir);

  /* Never trust a stale inventory: the classifier runs again, on the Workspace
     as it stands right now, and a fail-closed finding ends the reset before
     anything is deleted. */
  const preview = previewWorkspaceMigration(workspaceDir);
  if (preview.outcome === "unsafe-mixed-state")
    return { outcome: "unsafe-mixed-state", findings: preview.findings };

  const startedAt = Date.now();
  const rewrites = [
    planTableRewrite(workspaceDir, "config.json", CONFIG_KEYS),
    planTableRewrite(workspaceDir, "relay.json", RELAY_KEYS),
  ].filter((rewrite): rewrite is TableRewrite => rewrite !== null);
  /* Invariants first: if authentication cannot be carried through a rewrite,
     the reset stops here and the Workspace still holds everything it held. */
  for (const rewrite of rewrites) assertRewriteKeepsAuthentication(rewrite);

  /* Deletion mirrors the classifier exactly: a classified directory or whole
     file is removed even if an earlier attempt already removed it. */
  let directories = 0;
  let files = 0;
  for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
    if (entry.isDirectory() && Object.hasOwn(DIRECTORIES, entry.name)) {
      rmSync(join(workspaceDir, entry.name), { recursive: true, force: true });
      directories += 1;
    } else if (entry.isFile() && Object.hasOwn(WHOLE_FILES, entry.name)) {
      rmSync(join(workspaceDir, entry.name), { force: true });
      files += 1;
    }
  }

  for (const rewrite of rewrites) writeRewrite(workspaceDir, rewrite.entry, rewrite.document);

  const configRewrite = rewrites.find((rewrite) => rewrite.entry === "config.json");
  const relayRewrite = rewrites.find((rewrite) => rewrite.entry === "relay.json");
  const receipt: MigrationReceipt = {
    schemaVersion: 1,
    migratedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    categories: {
      directories,
      files,
      preservedConfigKeys: configRewrite?.preserved.size ?? 0,
      droppedConfigKeys: configRewrite?.dropped.length ?? 0,
      preservedRelayKeys: relayRewrite?.preserved.size ?? 0,
      droppedRelayKeys: relayRewrite?.dropped.length ?? 0,
    },
  };

  /* Receipt first, marker last: the marker's existence is the word that the
     whole reset finished. */
  const migrationDirectory = join(workspaceDir, MIGRATION_DIRECTORY);
  mkdirSync(migrationDirectory, { recursive: true });
  writeFileSync(
    join(migrationDirectory, MIGRATION_RECEIPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(migrationDirectory, MIGRATION_MARKER_FILE),
    `${JSON.stringify({ migratedAt: receipt.migratedAt }, null, 2)}\n`,
    "utf8",
  );

  return { outcome: "completed", receipt };
}
