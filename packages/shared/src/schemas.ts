import type { TranscriptCatalogStatus } from "./transcript.js";
// Keep the v3 schema contract for persisted data and zod-to-json-schema.
// Zod 4 ships this compatibility entry point; its root export changes semantics.
import { z } from "zod/v3";
import { YoutubeChannelSchema } from "./youtube.js";
import { ACTION_ITEM_POLICIES } from "./task.js";

// Meeting Brief Generator — Internal Domain normalization helper (issue://83)
export function normalizeInternalDomains(domains: string[]): string[] {
  const normalized = domains.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
  return [...new Set(normalized)];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const PROVIDERS = ["openai", "anthropic", "openrouter", "gemini", "ollama", "mock"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export const ProviderIdSchema = z.enum(PROVIDERS);

/** Default model per provider; free-text editable in Settings. */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.2",
  anthropic: "claude-sonnet-5",
  openrouter: "z-ai/glm-5.3-flash",
  gemini: "gemini-3.7-flash",
  ollama: "nemotron",
  mock: "",
};

/** Ollama's default listen address. `host.docker.internal` inside a container. */
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export const MODEL_PURPOSES = {
  personResearch: "Person evidence extraction and identity",
  researchPlanning: "Person research planning",
  evaluationJudge: "Research evaluation judge",
  contentGeneration: "Content outlines and drafts",
  contentDiscovery: "Content selection and Brand Voice",
  contentResearch: "Content Research",
  meetingBrief: "Meeting preparation and summaries",
  meetingDebrief: "Meeting Debrief extraction",
} as const;
export type ModelPurpose = keyof typeof MODEL_PURPOSES;
const PurposeModelsSchema = z.strictObject({
  personResearch: z.string().max(200).optional(),
  researchPlanning: z.string().max(200).optional(),
  evaluationJudge: z.string().max(200).optional(),
  contentGeneration: z.string().max(200).optional(),
  contentDiscovery: z.string().max(200).optional(),
  contentResearch: z.string().max(200).optional(),
  meetingBrief: z.string().max(200).optional(),
  meetingDebrief: z.string().max(200).optional(),
});
const ModelsSchema = z.record(ProviderIdSchema, PurposeModelsSchema);

export const ConfigSchema = z.strictObject({
  provider: ProviderIdSchema,
  model: z.string(),
  models: ModelsSchema.optional(),
  apiKey: z.string(),
  tasklistName: z.string().default("Meeting Followups"),
  google: z.strictObject({
    clientId: z.string(),
    clientSecret: z.string(),
    refreshToken: z.string().nullable(),
    /* When a sign-in last succeeded. Null means one never has, which is what
       keeps the setup steps on screen for someone whose first attempt failed. */
    lastConnectedAt: z.string().nullable().default(null),
    /* Whether Google has ever refused this grant. The seven-day expiry belongs
       to a consent screen whose publishing status is Testing; an Internal app
       has no publishing status and never expires. This app cannot read its own
       publishing status with the scopes it holds, so it does not guess — it
       predicts an expiry only once it has seen one. */
    hasExpiredBefore: z.boolean().default(false),
  }),
  notion: z
    .strictObject({
      token: z.string(),
      lastVerifiedAt: z.string().nullable().default(null),
    })
    .default({ token: "", lastVerifiedAt: null }),
  drive: z.strictObject({
    enabled: z.boolean().default(false),
    folderId: z.string().default(""),
    folderName: z.string().default(""),
    pollIntervalMinutes: z.number().int().positive().default(2),
  }),
  /**
   * The Tasks product area's own configuration (issue #184). Google Tasks is
   * enabled here and nowhere else: the Google connection is one authorization,
   * but the Tasks scope is asked for only when the owner has chosen to file
   * work outward, so every other Google capability stays usable without it.
   */
  tasks: z
    .strictObject({
      /**
       * What happens to a freshly materialized Action Item (issue #181).
       * Stage all is the default in every Workspace: automation over the
       * owner's own commitments is a choice they make, never one they
       * inherit.
       */
      actionItemPolicy: z.enum(ACTION_ITEM_POLICIES).default("stage-all"),
      googleTasks: z
        .strictObject({
          enabled: z.boolean().default(false),
          /** The Google Task List new Tasks are created in; "" until chosen. */
          taskListId: z.string().default(""),
          taskListTitle: z.string().default(""),
        })
        .default({ enabled: false, taskListId: "", taskListTitle: "" }),
      /**
       * Asana as a Task Destination (issue #189), connected with a
       * person-supplied personal access token. The token is stored here — the
       * config file is the credential boundary — and never returned by any
       * route: `GET /api/config` redacts it away with the rest, and the
       * destination routes answer with a hint only. The destination gids are
       * Asana's own; the Workspace stores and sends them, never interprets
       * them.
       */
      asana: z
        .strictObject({
          token: z.string().default(""),
          /** When a Check connection last succeeded against this token. */
          lastVerifiedAt: z.string().nullable().default(null),
          enabled: z.boolean().default(false),
          workspaceGid: z.string().default(""),
          workspaceName: z.string().default(""),
          projectGid: z.string().default(""),
          projectName: z.string().default(""),
          /** Null sends the Task to the project's default section. */
          sectionGid: z.string().nullable().default(null),
          sectionName: z.string().nullable().default(null),
        })
        .default({
          token: "",
          lastVerifiedAt: null,
          enabled: false,
          workspaceGid: "",
          workspaceName: "",
          projectGid: "",
          projectName: "",
          sectionGid: null,
          sectionName: null,
        }),
    })
    .default({
      actionItemPolicy: "stage-all",
      googleTasks: { enabled: false, taskListId: "", taskListTitle: "" },
      asana: {
        token: "",
        lastVerifiedAt: null,
        enabled: false,
        workspaceGid: "",
        workspaceName: "",
        projectGid: "",
        projectName: "",
        sectionGid: null,
        sectionName: null,
      },
    }),
  ollama: z.strictObject({
    baseUrl: z.string().default(DEFAULT_OLLAMA_BASE_URL),
  }),
  search: z
    .strictObject({
      /** Base URL of the self-hosted SearXNG instance, when one is composed (ADR-0049). */
      searxngUrl: z.string().optional(),
    })
    .default({}),
  /**
   * Each Module's own configuration, namespaced under the Module rather than
   * joining the Shell's settings as more top-level keys — so a Module's
   * configuration is visibly its own, and Module three has a pattern to copy
   * rather than to invent. The Shell stores these and reads inside them
   * nowhere; a Module writes its own through `setModuleConfig`, never through
   * `PUT /api/config`.
   */
  modules: z
    .strictObject({
      "youtube-trends": z
        .strictObject({
          channels: z.array(YoutubeChannelSchema).default([]),
          /** The spreadsheet the Module created for itself; "" until it has. */
          spreadsheetId: z.string().default(""),
          spreadsheetUrl: z.string().default(""),
        })
        .default({ channels: [], spreadsheetId: "", spreadsheetUrl: "" }),
      /* Idea Engine is retired (issue #142): no route, Run, poller or Sheet
         path reads this any more. The key itself stays until the one-time
         migration (#144) deletes it — `modules` is a strict object, so
         removing it here would make every pre-cutover config.json
         unparseable, and the migration's own inventory classifies these
         exact paths in order to delete them. */
      "idea-engine": z
        .strictObject({
          /** The existing All RA Content Ideas spreadsheet; "" until configured. */
          spreadsheetId: z.string().default(""),
          spreadsheetUrl: z.string().default(""),
          /** Per-type prompt overrides; absent types use shipped defaults. */
          prompts: z.record(z.string()).default({}),
          /** Remembered dedup hashes per Run (audit) - not user-edited. */
          // kept for config completeness, but hashes live in Run results primarily
        })
        .default({ spreadsheetId: "", spreadsheetUrl: "", prompts: {} }),
      "content-scout": z
        .strictObject({
          timeZone: z.string().default("UTC"),
          dailyTime: z.string().default("08:00"),
          weeklyDiscoveryDay: z.number().int().min(1).max(7).default(1),
          weeklyDiscoveryTime: z.string().default("09:00"),
          shortlistSize: z.number().int().min(3).max(10).default(5),
          /** Hours between automatic canary batches. The first batch is always explicit (issue #104). */
          canaryIntervalHours: z.number().int().min(1).max(168).default(12),
          /** Adapter ids whose canary targets this workspace declines to contact (issue #104). */
          canaryDisabledAdapters: z.array(z.string()).default([]),
        })
        .default({
          timeZone: "UTC",
          dailyTime: "08:00",
          weeklyDiscoveryDay: 1,
          weeklyDiscoveryTime: "09:00",
          shortlistSize: 5,
          canaryIntervalHours: 12,
          canaryDisabledAdapters: [],
        }),
      "content-research": z
        .strictObject({
          timeZone: z.string().default("UTC"),
          dailyTime: z.string().default("08:00"),
          weeklyDiscoveryDay: z.number().int().min(1).max(7).default(1),
          weeklyDiscoveryTime: z.string().default("09:00"),
        })
        .default({
          timeZone: "UTC",
          dailyTime: "08:00",
          weeklyDiscoveryDay: 1,
          weeklyDiscoveryTime: "09:00",
        }),
      "meeting-brief-generator": z
        .strictObject({
          internalDomains: z
            .array(z.string())
            .default([])
            .transform((arr) => normalizeInternalDomains(arr)),
          hubspot: z
            .strictObject({
              token: z.string().default(""),
              lastVerifiedAt: z.string().nullable().default(null),
            })
            .default({ token: "", lastVerifiedAt: null }),
          /** Explicit provider policy actions (#137): a provider is excluded from
           *  the required bundle set only through a person's recorded action —
           *  policy never relaxes silently. */
          providerPolicy: z
            .record(
              z.strictObject({
                disabled: z.boolean(),
                changedAt: z.string(),
                reason: z.string(),
              }),
            )
            .default({}),
        })
        .default({
          internalDomains: [],
          hubspot: { token: "", lastVerifiedAt: null },
          providerPolicy: {},
        }),
    })
    .default({
      "youtube-trends": { channels: [], spreadsheetId: "", spreadsheetUrl: "" },
      "idea-engine": { spreadsheetId: "", spreadsheetUrl: "", prompts: {} },
      "content-scout": {
        timeZone: "UTC",
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
        shortlistSize: 5,
        canaryIntervalHours: 12,
        canaryDisabledAdapters: [],
      },
      "content-research": {
        timeZone: "UTC",
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
      },
      "meeting-brief-generator": {
        internalDomains: [],
        hubspot: { token: "", lastVerifiedAt: null },
      },
    }),
});
export type AppConfig = z.infer<typeof ConfigSchema>;
export type ModuleConfigs = AppConfig["modules"];

/** PUT /api/config body. Absent secret fields keep their stored values. */
export const ConfigUpdateSchema = z.strictObject({
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  models: ModelsSchema.optional(),
  apiKey: z.string().optional(),
  tasklistName: z.string().optional(),
  google: z
    .strictObject({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
    })
    .optional(),
  drive: z
    .strictObject({
      enabled: z.boolean().optional(),
      folderId: z.string().optional(),
      folderName: z.string().optional(),
      pollIntervalMinutes: z.number().int().positive().optional(),
    })
    .optional(),
  ollama: z
    .strictObject({
      baseUrl: z.string().optional(),
    })
    .optional(),
  search: z
    .strictObject({
      searxngUrl: z.string().optional(),
    })
    .optional(),
});

export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;

export interface SecretHint {
  set: boolean;
  /** Last 4 characters of the stored secret, "" when unset. */
  hint: string;
}

/** GET /api/config response payload: every secret replaced by a hint. */
export interface RedactedConfig {
  provider: ProviderId;
  model: string;
  models?: z.infer<typeof ModelsSchema>;
  tasklistName: string;
  apiKey: SecretHint;
  google: {
    clientId: string;
    clientSecret: SecretHint;
  };
  notion: {
    token: SecretHint;
    lastVerifiedAt: string | null;
  };
  drive: {
    enabled: boolean;
    folderId: string;
    folderName: string;
    pollIntervalMinutes: number;
  };
  /** Not a secret: a local endpoint address, returned verbatim. */
  ollama: {
    baseUrl: string;
  };
  /** Not a secret: a local endpoint address, returned verbatim. */
  search: {
    searxngUrl: string | null;
  };
}

// ---------------------------------------------------------------------------
// Google connection
// ---------------------------------------------------------------------------

/**
 * Where the Google connection stands. Four states rather than one boolean,
 * because a stored refresh token that Google has stopped honouring is not an
 * error case here — it is the documented weekly end state of every OAuth client
 * whose consent screen is External and whose publishing status is Testing, and
 * a personal Google account leaves no other option. Reporting that as
 * "connected" sends the next Run to a failure the Shell could have named.
 */
export const GOOGLE_CONNECTION_STATES = [
  /** No OAuth client credentials stored yet: the setup steps have not been done. */
  "unconfigured",
  /** Credentials stored, nobody signed in yet. */
  "disconnected",
  /** Google answered a token refresh; Tasks and drafts will be written. */
  "connected",
  /** Credentials stored and a token held, but Google rejected it — sign in again. */
  "expired",
] as const;
export type GoogleConnectionState = (typeof GOOGLE_CONNECTION_STATES)[number];

/** GET /api/google/status response. */
export interface GoogleStatus {
  state: GoogleConnectionState;
  /** The signed-in account, when Google told us who it is. */
  email: string | null;
  /**
   * The exact redirect URI to register, derived from the port the server is
   * actually listening on. Served rather than written into the UI so the two
   * cannot drift when PORT changes.
   */
  redirectUri: string;
  /** The scopes to add to the consent screen, in the order they are requested. */
  scopes: string[];
  /**
   * When the last sign-in succeeded, or null if one never has. This is what
   * separates "set up, merely signed out" from "half-configured, never worked"
   * without a fifth state: the console steps stay on screen until it is set.
   */
  lastConnectedAt: string | null;
  /**
   * When Google will probably stop accepting the sign-in. An estimate, never a
   * promise — Google does not report a refresh token's lifetime, and a password
   * change or a revoke ends the grant immediately.
   *
   * Null until Google has actually refused this grant once. The seven-day limit
   * applies to a consent screen in Testing; an Internal app has none, and
   * predicting one there would warn every week about an event that never
   * arrives. The prediction is earned by observation, not assumed.
   */
  expiresAbout: string | null;
}

/**
 * How long Google leaves a refresh token alive while a consent screen's
 * publishing status is Testing. Google's documented behaviour, not a value it
 * returns, so everything derived from it is an estimate.
 */
export const GOOGLE_TESTING_TOKEN_DAYS = 7;

/**
 * POST /api/google/check response: what Google itself said about each surface
 * the app needs. Answers "did I finish the console steps?" by asking Google
 * rather than by describing the console — the console is the part that goes
 * stale, and a 403 from Google names the missing piece exactly.
 */
export interface SetupCheck {
  state: GoogleConnectionState;
  /**
   * One line per surface checked, in the order the setup steps introduce them.
   * Empty when the connection state made a call impossible at all.
   */
  items: { label: string; ok: boolean; detail: string }[];
}

/** GET /api/google/picker-token response: short-lived token for the Picker. */
export interface PickerTokenResponse {
  token: string;
  expiresAt: string | null;
}

/** GET /api/intake/drive response: what the Drive Intake remembers (D14).
 *  Served from config and the state file; it never asks Google anything. */
export interface DriveIntakeStatus {
  enabled: boolean;
  configured: boolean;
  folderName: string;
  pollIntervalMinutes: number;
  /** Null until the first poll of this process completes — after a restart
   *  there is no last-checked time to claim. */
  lastPollAt: string | null;
  lastPollOutcome: "ok" | "failed" | null;
  /** The Transcript Catalog's own state: standing consent, and the ledger. */
  catalog: TranscriptCatalogStatus;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const RUN_STATUSES = ["pending", "running", "blocked", "done", "skipped", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunWaitTimeout = { kind: "none" } | { kind: "at"; at: string };

/** Shell-owned durable wait standing against a blocked Run (ADR-0020). */
export interface RunWait {
  requestedAt: string;
  /** The Module-named Stage that requested the wait. */
  stage: string;
  /** Person-readable explanation shown on Runs surfaces. */
  reason: string;
  /** Indefinite is explicit; it is never inferred from an absent timestamp. */
  timeout: RunWaitTimeout;
}

/** runs/<runId>/meta.json */
export interface RunMeta {
  id: string;
  createdAt: string;
  /** Which Module owns this Run. Required: a Run with no Module cannot be
   *  listed under one. */
  module: string;
  /** The Module's own version when the Run was created, so a Module can
   *  recognise a Run its older self wrote. */
  moduleVersion: number;
  /** Which of that Module's Intakes produced the Run. The Module names its
   *  own; the Shell never holds a list of them. */
  intake: string;
  /** The file this Run started from, when it started from one at all. */
  fileName?: string;
  sourceUrl: string | null;
  /** The Module's own key for what this Run is about in the world outside: a
   *  Drive file id for the transcript Module, a calendar day for YouTube
   *  Trends. The Shell stores it and reads nothing into it. */
  externalId: string | null;
  status: RunStatus;
  /** Present only while status is `blocked`. Legacy Runs read as null. */
  wait?: RunWait | null;
  attempts: number;
  /** Workflow-named stage, e.g. "convert" | "extract" | "outputs" for the transcript workflow. */
  failedStage: string | null;
  skipReason: string | null;
  failureHint: string | null;
  /**
   * One line the Module wrote about what it did, recorded when the Run ended.
   * The Shell stores and renders it and interprets it nowhere. Null when the
   * Module wrote none, and on every Run that has not finished.
   */
  summary: string | null;
  /** The failure-site verdict when the Google connection caused the failure.
   *  Legacy metas and failures unrelated to the connection omit it. */
  connectionState?: GoogleConnectionState;
}

export interface RunFailureFlags {
  connectionState?: GoogleConnectionState;
  /** Module-supplied, shape-only facts to merge into generic failure events. */
  eventDetail?: Record<string, unknown>;
}

export const SHELL_EVENT_TYPES = [
  "created",
  "stage_started",
  "stage_failed",
  "run_done",
  "run_failed",
  "run_reopened",
  "run_blocked",
  "run_resumed",
  "run_recovered",
  "retry_refused",
  /* A transcript-Module word the Shell writes from `finished()`. It is in this
     list because the list states what the Shell writes today, not what it
     should write. See §5. */
  "classify_skipped",
] as const;
export type ShellEventType = (typeof SHELL_EVENT_TYPES)[number];

/** One JSON line in runs/<runId>/events.jsonl */
export interface RunEvent {
  at: string;
  /** A Shell event name or any name a Module chooses. */
  type: string;
  detail?: Record<string, unknown>;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  /** Which Module made the Run. The cross-Module list renders it as that
   *  Module's label, or as this raw identifier when no Module claims it. */
  module: string;
  intake: string;
  fileName?: string;
  sourceUrl: string | null;
  status: RunStatus;
  /** The durable wait when blocked; null for every other status and legacy Run. */
  wait?: RunWait | null;
  /** Why the Run was skipped; null unless status is "skipped". */
  skipReason: string | null;
  /** The line the Module wrote about what it did; null when it wrote none. */
  summary: string | null;
  /** The exact connection state recorded at the failure site, when known. */
  connectionState?: GoogleConnectionState;
}

export interface RunDetail extends RunSummary {
  attempts: number;
  /** Workflow-named stage, e.g. "convert" | "extract" | "outputs" for the transcript workflow. */
  failedStage: string | null;
  skipReason: string | null;
  failureHint: string | null;
  result: unknown;
  events: RunEvent[];
  /** The Run's own files, so the Shell can link them for a Module that
   *  contributes no result view. It never reads inside one. */
  files: string[];
}

/**
 * GET /api/runs. Newest first, filtered to one Module or across all of them.
 *
 * `nextCursor` is the id of the last Run on this page; asking again with it
 * continues below. Null means this page reached the end. Absent `limit` means
 * every Run: Home counts every failure, so it asks for the lot, while the Runs
 * list pages.
 */
export interface RunPage {
  runs: RunSummary[];
  nextCursor: string | null;
}

/** How many Runs the Runs list asks for at a time. */
export const RUNS_PAGE_SIZE = 25;
