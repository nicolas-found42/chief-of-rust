import type {
  TaskCutoverPreview,
  TaskCutoverReceipt,
  RedactedConfig,
  GoogleStatus,
  SetupCheck,
  DriveIntakeStatus,
  TranscriptCatalogStatus,
  OwnerOnboardingProposal,
  ConfirmedOwnerReference,
  RunPage,
  RunDetail,
} from "@chief-of-staff-demo/shared";
import { request, requestText } from "../client";

/**
 * The Shell's own client namespaces — the surfaces no product area owns: Runs,
 * config, the Google connection, Relay, Transcript Catalog intake, owner
 * onboarding, the workspace migration, and the generated-data clear. The
 * product areas have their own clients beside this file (clients/meetings,
 * clients/content, clients/people); client.ts holds transport only.
 */

export interface ConfigPayload {
  config: RedactedConfig;
  defaults: Record<string, string>;
  /** Whether the mock provider exists in this process: tests and explicit
   *  demo mode only (issue #198). The UI offers mock exactly when this holds. */
  mockAvailable: boolean;
}

/** What the Runs list asks for: one Module's Runs or every Module's, a page at a time. */
export interface RunListQuery {
  module?: string;
  limit?: number;
  cursor?: string | null;
}

function runsPath(query: RunListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.module) {
    params.set("module", query.module);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.cursor) {
    params.set("cursor", query.cursor);
  }
  const search = params.toString();
  return search ? `/api/runs?${search}` : "/api/runs";
}

export const runsApi = {
  listRuns: (query?: RunListQuery) => request<RunPage>(runsPath(query)),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  retry: (id: string) =>
    request<{ status: string }>(`/api/runs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  getArtifact: (runId: string, name: string) =>
    requestText(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`),
};

export const configApi = {
  getConfig: () => request<ConfigPayload>("/api/config"),
  saveConfig: (update: Record<string, unknown>) =>
    request<ConfigPayload>("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
};

export const googleApi = {
  status: () => request<GoogleStatus>("/api/google/status"),
  check: () => request<SetupCheck>("/api/google/check", { method: "POST" }),
  connect: () => request<{ authUrl: string }>("/api/google/connect"),
  disconnect: () => request<GoogleStatus>("/api/google/disconnect", { method: "POST" }),
  pickerToken: () =>
    request<{ token: string; expiresAt: string | null }>("/api/google/picker-token"),
};

export const relayApi = {
  // Relay status — issue://80 Settings (relay/channel status + last wake-up, no secrets) + ADR-0031
  status: () =>
    request<{
      installationId: string | null;
      relayBaseUrl: string | null;
      relayHealth: "ok" | "unreachable" | "not_configured";
      channels: Array<{ channelId: string; expiration: string | null; resourceId: string | null }>;
      lastWakeUpAt: string | null;
      hasSecret: boolean;
    }>("/api/relay/status"),
  install: (relayBaseUrl?: string) =>
    request<{
      installationId: string | null;
      relayBaseUrl: string | null;
      channels: Array<{ channelId: string; expiration: string | null }>;
      lastWakeUpAt: string | null;
    }>("/api/relay/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(relayBaseUrl ? { relayBaseUrl } : {}),
    }),
  poll: () =>
    request<{ messages: unknown[]; lastWakeUpAt: string | null }>("/api/relay/poll", {
      method: "POST",
    }),
};

/* ---------------------------------------------------------------------------
 * Transcript Catalog intake (Settings): the on-demand processing pass, the
 * remembered facts, the pre-consent disclosure, and the standing consent.
 * ------------------------------------------------------------------------- */

/** What granting folder consent would cover (`/api/transcripts/intake/inventory`). */
export interface TranscriptIntakeInventory {
  folder: { sourceSystem: string; folderId: string; folderName: string };
  fileCount: number;
  dateRange: { earliest: string | null; latest: string | null } | null;
  estimatedScope: { totalBytes: number };
  localRetention: string;
  providerExposure: {
    sendsTranscriptTextToConfiguredModel: boolean;
    provider: string;
    model: string;
  };
  externalQueryBehavior: string;
  files: Array<{
    externalFileId: string;
    fileName: string;
    sizeBytes: number;
    modifiedAt: string;
    meetingDate: string | null;
  }>;
}

export const intakeApi = {
  /* Transcript Catalog intake (issue #142): one processing pass on demand,
     replacing Transcript → Tasks' retired /api/drive/sync. */
  driveSync: () =>
    request<{ processed: number; failed: number; skipped: number; unchanged: number }>(
      "/api/transcripts/intake/sync",
      { method: "POST" },
    ),
  /* Remembered intake facts only (D14): the endpoint makes zero Google calls. */
  driveIntakeStatus: () => request<DriveIntakeStatus>("/api/transcripts/intake"),
  /* The pre-consent disclosure: what consent would cover, read from the folder
     listing alone — file names and sizes, never a file's contents. */
  transcriptIntakeInventory: () =>
    request<TranscriptIntakeInventory>("/api/transcripts/intake/inventory"),
  /* Standing folder consent. Grants and starts the historical backfill. */
  grantTranscriptIntakeConsent: () =>
    request<TranscriptCatalogStatus>("/api/transcripts/intake/consent", { method: "POST" }),
};

/* ---------------------------------------------------------------------------
 * Owner onboarding (issue #123): the proposal/confirmation namespace under
 * /api/onboarding.
 * ------------------------------------------------------------------------- */

export interface OwnerOnboardingStatus {
  proposal: OwnerOnboardingProposal | null;
  confirmed: ConfirmedOwnerReference | null;
}

export const onboardingApi = {
  owner: () => request<OwnerOnboardingStatus>("/api/onboarding/owner"),
  confirm: (profileId: string) =>
    request<ConfirmedOwnerReference>("/api/onboarding/owner/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId }),
    }),
};

/* ---------------------------------------------------------------------------
 * Workspace migration (ticket #144): the one-time auth-preserving reset under
 * /api/migration. Shapes match the ticket contract and the read-only preview
 * classifier in apps/server/src/migration/workspace.ts — the preview payload
 * is content-free by construction: names of categories, counts, never stored
 * values.
 * ------------------------------------------------------------------------- */

type MigrationState = "fresh" | "required" | "completed";

interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
  href: string;
}

export interface OnboardingStatus {
  complete: boolean;
  steps: OnboardingStep[];
}

export interface MigrationStatus {
  state: MigrationState;
  onboarding: OnboardingStatus;
}

export const migrationApi = {
  /** Always mounted, never gated — the boot gate itself reads it. */
  status: () => request<MigrationStatus>("/api/migration/status"),
  inventory: () => request<TaskCutoverPreview>("/api/migration/inventory"),
  confirm: (typedConfirmation: string, preview: TaskCutoverPreview) =>
    request<{ receipt: TaskCutoverReceipt }>("/api/migration/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typedConfirmation,
        workspace: preview.workspace,
        fingerprint: preview.fingerprint,
      }),
    }),
  receipt: () => request<TaskCutoverReceipt>("/api/migration/receipt"),
};

/* ---------------------------------------------------------------------------
 * Generated-data clear (issue #144): the Settings danger zone's read-only
 * inventory and the one confirmed action that empties the Workspace.
 * ------------------------------------------------------------------------- */

/** One inventoried Workspace entry the clear deletes, names and counts only. */
interface GeneratedDataInventoryEntry {
  name: string;
  kind: "directory" | "file";
  fileCount: number | null;
}

export interface GeneratedDataInventory {
  entries: GeneratedDataInventoryEntry[];
}

interface ClearedSheetOutcome {
  destination: "youtube-trends" | "content-research-ledger";
  outcome: "cleared" | "skipped" | "missing" | "failed";
  tabs?: number;
  rows?: number;
  reason?: string;
}

/** The content-free record of one clear: names and counts, never stored values. */
export interface ClearDataReceipt {
  schemaVersion: number;
  clearedAt: string;
  durationMs: number;
  local: { directories: { name: string; files: number }[]; files: string[] };
  sheets: ClearedSheetOutcome[];
}

export const clearDataApi = {
  inventory: () => request<GeneratedDataInventory>("/api/clear-data/inventory"),
  confirm: (typedConfirmation: string) =>
    request<ClearDataReceipt>("/api/clear-data/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typedConfirmation }),
    }),
};
