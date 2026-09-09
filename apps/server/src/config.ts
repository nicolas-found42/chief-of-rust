import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AppConfig,
  type ConfigUpdate,
  type ModuleConfigs,
  type RedactedConfig,
  type SecretHint,
  type ModelPurpose,
  ConfigSchema,
  DEFAULT_MODELS,
  DEFAULT_OLLAMA_BASE_URL,
} from "@chief-of-staff-demo/shared";

/** Recursively merge `patch` over `base`; missing keys keep the base value. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined || patch === null) {
    return base;
  }
  if (
    typeof base === "object" &&
    base !== null &&
    !Array.isArray(base) &&
    typeof patch === "object" &&
    !Array.isArray(patch)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      out[key] = deepMerge(out[key], value);
    }
    return out;
  }
  return patch;
}

function defaultConfig(): AppConfig {
  return {
    /* Fresh customer configuration (issue #198): OpenRouter is the
       recommendation — one key reaches models from many providers — and the
       model prefills below from DEFAULT_MODELS. A key is still required
       before the provider is usable, so a fresh Workspace runs nothing until
       the owner consents to the exact provider and model in Settings. */
    provider: "openrouter",
    model: "",
    apiKey: "",
    tasklistName: "Meeting Followups",
    google: {
      clientId: "",
      clientSecret: "",
      refreshToken: null,
      lastConnectedAt: null,
      hasExpiredBefore: false,
    },
    notion: { token: "", lastVerifiedAt: null },
    drive: { enabled: false, folderId: "", folderName: "", pollIntervalMinutes: 2 },
    tasks: {
      /* Stage all Action Items (issue #181): a fresh Workspace never promotes
         a model proposal on its own. */
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
    },
    ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL },
    search: {},
    modules: {
      "youtube-trends": { channels: [], spreadsheetId: "", spreadsheetUrl: "" },
      "idea-engine": { spreadsheetId: "", spreadsheetUrl: "", prompts: {} },
      "content-scout": {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
        shortlistSize: 5,
        canaryIntervalHours: 12,
        canaryDisabledAdapters: [],
      },
      "content-research": {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dailyTime: "08:00",
        weeklyDiscoveryDay: 1,
        weeklyDiscoveryTime: "09:00",
      },
      "meeting-brief-generator": {
        internalDomains: [],
        hubspot: { token: "", lastVerifiedAt: null },
        providerPolicy: {},
      },
    },
  };
}

/** Fill in the provider's default model when the stored model is empty. */

function normalize(config: AppConfig): AppConfig {
  return {
    ...config,
    model: config.model === "" ? DEFAULT_MODELS[config.provider] : config.model,
  };
}

export class ConfigStore {
  private config: AppConfig | null = null;

  /**
   * `persistOnLoad` defaults to the historical behavior: every load normalizes
   * the stored file and writes it back. The migration gate passes false while
   * it holds the Workspace pre-cutover — boot must write nothing — and adopts
   * the reset's rewrite with `load({ persist: false })`.
   */
  constructor(
    private readonly configFile: string,
    private readonly persistOnLoad = true,
  ) {}

  load(options: { persist?: boolean } = {}): AppConfig {
    let stored: unknown = {};
    if (existsSync(this.configFile)) {
      try {
        stored = JSON.parse(readFileSync(this.configFile, "utf8"));
      } catch (err) {
        throw new Error(
          `Cannot parse ${this.configFile}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    const merged = deepMerge(defaultConfig(), stored) as Record<string, unknown>;
    // Old configs had fireflies/watch — strictObject would reject them; drop before parse.
    // The consolidation (#133) retired the content-scout Notion calendar block the same way.
    delete merged.fireflies;
    delete merged.watch;
    // Legacy Guest Profile adapter configuration (removed by issue #136's
    // cutover): stored keys are dropped so strict parsing accepts old files.
    const modules = (merged.modules ?? {}) as Record<string, unknown>;
    if (
      modules["meeting-brief-generator"] &&
      typeof modules["meeting-brief-generator"] === "object"
    ) {
      delete (modules["meeting-brief-generator"] as Record<string, unknown>).guestProfile;
    }
    // The consolidation (#133) retired the content-scout Notion calendar
    // block the same way.
    if (modules["content-scout"] && typeof modules["content-scout"] === "object") {
      delete (modules["content-scout"] as Record<string, unknown>).notion;
    }
    const parsed = ConfigSchema.parse(merged);
    this.config = normalize(parsed);
    if (options.persist ?? this.persistOnLoad) {
      this.persist();
    }
    return this.config;
  }

  get(): AppConfig {
    if (!this.config) {
      throw new Error("ConfigStore.load() must run before get()");
    }
    return this.config;
  }

  getModuleConfig<K extends keyof ModuleConfigs>(key: K): ModuleConfigs[K] {
    return this.get().modules[key];
  }

  /** Purpose overrides belong to their provider and share its credential. */
  getForPurpose(purpose: ModelPurpose): AppConfig {
    const current = this.get();
    return {
      ...current,
      model: current.models?.[current.provider]?.[purpose]?.trim() || current.model,
    };
  }

  /** Merge a partial update. Absent secret fields keep their stored values. */
  update(patch: ConfigUpdate): AppConfig {
    const merged = deepMerge(this.get(), patch);
    this.config = normalize(ConfigSchema.parse(merged));
    this.persist();
    return this.config;
  }

  /**
   * A Module's own configuration, replaced wholesale. Namespaced under the
   * Module, and deliberately not reachable through `PUT /api/config`: a
   * Module's configuration changes through that Module's own endpoints, where
   * the Module can check it first.
   */
  setModuleConfig<K extends keyof ModuleConfigs>(key: K, next: ModuleConfigs[K]): void {
    const current = this.get();
    this.config = { ...current, modules: { ...current.modules, [key]: next } };
    this.persist();
  }

  /**
   * Stamps `lastConnectedAt` on the way in, because this is the one place a
   * sign-in is recorded. Clearing the token deliberately — switching accounts —
   * leaves the stamp alone: the console work is still done, and it is that fact,
   * not the token, which decides whether the setup steps are still needed.
   */
  setGoogleRefreshToken(token: string | null): void {
    const current = this.get();
    this.config = {
      ...current,
      google: {
        ...current.google,
        refreshToken: token,
        lastConnectedAt: token ? new Date().toISOString() : current.google.lastConnectedAt,
      },
    };
    this.persist();
  }

  /**
   * The Tasks product area's Google Tasks destination (issue #184). Its own
   * method rather than a `PUT /api/config` field: enabling it changes which
   * scopes a sign-in asks for, and that is a decision the Tasks product makes
   * after validating a destination, not a settings field anyone can post.
   */
  setGoogleTasksDestination(next: AppConfig["tasks"]["googleTasks"]): void {
    const current = this.get();
    this.config = { ...current, tasks: { ...current.tasks, googleTasks: next } };
    this.persist();
  }

  /**
   * The Action Item Policy (issue #181). Its own method rather than a
   * `PUT /api/config` field, like the two destinations below: turning
   * automatic promotion on is a decision the Tasks product takes after it has
   * told the owner what an externally backed default would send outward.
   */
  setActionItemPolicy(next: AppConfig["tasks"]["actionItemPolicy"]): void {
    const current = this.get();
    this.config = { ...current, tasks: { ...current.tasks, actionItemPolicy: next } };
    this.persist();
  }

  /**
   * Asana as a Task Destination (issue #189). Its own method rather than a
   * `PUT /api/config` field, like the Google Tasks destination above: the
   * token is verified against Asana before it is stored, and the destination
   * is validated against the account before it is enabled — decisions the
   * Tasks product makes on its own routes, not settings anyone can post.
   */
  setAsanaDestination(next: AppConfig["tasks"]["asana"]): void {
    const current = this.get();
    this.config = { ...current, tasks: { ...current.tasks, asana: next } };
    this.persist();
  }

  /**
   * Record that Google has refused this grant at least once. Latching rather
   * than toggling: the fact stored is "this consent screen does expire", which
   * a later successful sign-in does not undo.
   */
  markGoogleExpired(): void {
    const current = this.get();
    if (current.google.hasExpiredBefore) {
      return;
    }
    this.config = { ...current, google: { ...current.google, hasExpiredBefore: true } };
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.configFile), { recursive: true });
    writeFileSync(this.configFile, JSON.stringify(this.get(), null, 2) + "\n", "utf8");
  }
}

function secretHint(value: string): SecretHint {
  return { set: value.length > 0, hint: value ? `…${value.slice(-4)}` : "" };
}

export function redactConfig(config: AppConfig): RedactedConfig {
  return {
    provider: config.provider,
    model: config.model,
    models: config.models ?? {},
    tasklistName: config.tasklistName,
    apiKey: secretHint(config.apiKey),
    google: {
      clientId: config.google.clientId,
      clientSecret: secretHint(config.google.clientSecret),
    },
    notion: {
      token: secretHint(config.notion.token),
      lastVerifiedAt: config.notion.lastVerifiedAt,
    },
    drive: {
      enabled: config.drive.enabled,
      folderId: config.drive.folderId,
      folderName: config.drive.folderName,
      pollIntervalMinutes: config.drive.pollIntervalMinutes,
    },
    ollama: {
      baseUrl: config.ollama.baseUrl,
    },
    search: {
      searxngUrl: config.search.searxngUrl ?? null,
    },
  };
}
