import type {
  ContentEngineDraft,
  ContentProject,
  ContentProjectIntentPatch,
  ContentProjectReadiness,
  ContentProjectRevision,
  ContentProjectSummary,
  OutlineCharterApproval,
  OutlineSetOutcome,
  PlatformOutline,
  PlatformOutlineApproval,
  BrandProfileRevision,
  BrandProfileRevisionSummary,
  BrandProfileProposal,
  ContentProjectResearchMode,
  ContentProjectTarget,
  ContentResearchIndex,
  ContentShortlist,
  SourceAdapterCanaryTarget,
  SourceAdapterState,
  SourceBackfillWindowDays,
  SourceCanaryHealth,
  SourceCanaryReceipt,
  SourceCapability,
  SourceDiagnosticClassification,
  ContentScoutScheduleState,
  ContentScoutStorageUse,
  ContentScoutCleanupPreview,
  ContentScoutCleanupReceipt,
  ContentScoutRuntimeCapability,
  SourceSuggestion,
  SourceTarget,
  YoutubeChannel,
  YoutubeTrends,
  NamedPerson,
  PersonSuggestion,
} from "@chief-of-staff-demo/shared";
import { request } from "../client";

/**
 * The Content side's client: the Content Project lifecycle (intent revisions,
 * outline charters, outlines, drafts), the Content Scout frontier that seeds
 * projects (brand profile, sources, shortlists, suggestions, canaries,
 * storage), the Content Research watch lane, and YouTube Trends. Every
 * content surface reads the server through this one typed vocabulary;
 * client.ts holds transport only.
 */

export interface ContentScoutState {
  brandProfile: BrandProfileRevision | null;
  brandProfileProposal: BrandProfileProposal | null;
  brandProfileRevisions: BrandProfileRevisionSummary[];
  sourceTargets: SourceTarget[];
  shortlist: ContentShortlist | null;
  adapters: {
    id: string;
    state: SourceAdapterState;
    version: string;
    backfillWindowsDays: SourceBackfillWindowDays[];
    canaryTargets: SourceAdapterCanaryTarget[];
    promotionEligible: boolean;
  }[];
  runtimeCapabilities: ContentScoutRuntimeCapability[];
  storage: ContentScoutStorageUse;
  settings: {
    timeZone: string;
    dailyTime: string;
    weeklyDiscoveryDay: number;
    weeklyDiscoveryTime: string;
    shortlistSize: number;
    canaryIntervalHours: number;
    canaryDisabledAdapters: string[];
  } | null;
  sourceSuggestions: SourceSuggestion[];
  schedule: ContentScoutScheduleState;
  health: {
    runId: string | null;
    warnings: {
      adapterId: string;
      targetId: string | null;
      outcome: SourceDiagnosticClassification;
      affectedCapabilities: SourceCapability[];
    }[];
    runtimeWarnings: string[];
    canary: SourceCanaryHealth[];
  };
  canary: {
    receipts: SourceCanaryReceipt[];
    health: SourceCanaryHealth[];
  };
  linkedinEvidenceGate: {
    passed: boolean;
    reason?: string;
    adapterVersion: string | null;
    checkedAt: string;
    requiredTargets: number;
    repeatsPerTarget: number;
    representativeTargets: readonly string[];
    evidence: readonly {
      targetUrl: string;
      adapterVersion: string;
      outcome: SourceDiagnosticClassification;
      itemsFound: number;
      hasUsefulItem: boolean;
      observedAt: string;
    }[];
  };
}

export const contentApi = {
  contentScout: () => request<ContentScoutState>("/api/content-scout"),
  saveBrandProfile: (input: {
    markdown: string;
    websiteUrl: string;
    includedUrls: string[];
    excludedUrls: string[];
    note?: string;
  }) =>
    request<{ revision: BrandProfileRevision }>("/api/content-scout/brand-profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  scanBrandProfile: (websiteUrl: string) =>
    request<{ runId: string }>("/api/content-scout/brand-profile/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ websiteUrl }),
    }),
  acceptBrandProfileProposal: (
    id: string,
    input: {
      acceptedSections: string[];
      includedUrls: string[];
      excludedUrls: string[];
      note?: string;
    },
  ) =>
    request<{ revision: BrandProfileRevision }>(
      `/api/content-scout/brand-profile/proposals/${encodeURIComponent(id)}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  brandProfileRevision: (id: string) =>
    request<{ revision: BrandProfileRevision }>(
      `/api/content-scout/brand-profile/revisions/${encodeURIComponent(id)}`,
    ),
  restoreBrandProfileRevision: (id: string) =>
    request<{ revision: BrandProfileRevision }>(
      `/api/content-scout/brand-profile/revisions/${encodeURIComponent(id)}/restore`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ),
  addContentSource: (input: { adapterId: string; label: string; url: string }) =>
    request<{ target: SourceTarget }>("/api/content-scout/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  setContentSourceState: (id: string, state: "active" | "archived") =>
    request<{ target: SourceTarget }>(`/api/content-scout/sources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    }),
  backfillContentSource: (id: string, windowDays: SourceBackfillWindowDays) =>
    request<{ runId: string }>(`/api/content-scout/sources/${encodeURIComponent(id)}/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowDays }),
    }),
  runContentScout: () => request<{ runId: string }>("/api/content-scout/run", { method: "POST" }),
  selectContentScout: (
    runId: string,
    opportunityIds: string[],
    project: {
      objective: string;
      audience: string;
      constraints?: string[];
      targets: ContentProjectTarget[];
      researchMode: ContentProjectResearchMode | null;
      seedMaterial?: string[];
    },
  ) =>
    request<{
      status: string;
      projects: { opportunityId: string; projectId: string; created: boolean }[];
    }>(`/api/content-scout/shortlists/${encodeURIComponent(runId)}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunityIds, project }),
    }),
  skipContentScout: (runId: string) =>
    request<{ status: string }>(`/api/content-scout/shortlists/${encodeURIComponent(runId)}/skip`, {
      method: "POST",
    }),
  decideContentOpportunity: (
    runId: string,
    opportunityId: string,
    decision: "dismiss_angle" | "not_relevant" | "already_covered",
  ) =>
    request<{ shortlist: ContentShortlist }>(
      `/api/content-scout/shortlists/${encodeURIComponent(runId)}/opportunities/${encodeURIComponent(opportunityId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    ),
  runSourceDiscovery: () =>
    request<{ runId: string }>("/api/content-scout/discovery/run", { method: "POST" }),
  decideSourceSuggestion: (
    id: string,
    decision: "approved" | "dismissed" | "proposed",
    reason: string | null = null,
  ) =>
    request<{ suggestion: SourceSuggestion }>(
      `/api/content-scout/suggestions/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      },
    ),
  saveContentScoutSchedule: (input: {
    timeZone: string;
    dailyTime: string;
    weeklyDiscoveryDay: number;
    weeklyDiscoveryTime: string;
    shortlistSize: number;
    canaryIntervalHours: number;
    canaryDisabledAdapters: string[];
  }) =>
    request<ContentScoutState>("/api/content-scout/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  previewContentScoutCleanup: () =>
    request<ContentScoutCleanupPreview>("/api/content-scout/storage/cleanup/preview", {
      method: "POST",
    }),
  cleanupContentScoutTemporaryData: () =>
    request<ContentScoutCleanupReceipt>("/api/content-scout/storage/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "expired_temporary_data", confirm: true }),
    }),
  runCanaries: () =>
    request<{ receipts: SourceCanaryReceipt[] }>("/api/content-scout/canary/run", {
      method: "POST",
    }),
  getCanaries: () =>
    request<{ receipts: SourceCanaryReceipt[]; health: SourceCanaryHealth[] }>(
      "/api/content-scout/canary",
    ),
  contentProjects: () =>
    request<{ projects: ContentProjectSummary[] }>("/api/content-engine/projects"),
  contentProject: (projectId: string) =>
    request<{ project: ContentProject; readiness: ContentProjectReadiness }>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}`,
    ),
  contentProjectRevise: (projectId: string, patch: ContentProjectIntentPatch) =>
    request<ContentProjectRevision>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/revisions`,
      { method: "POST", body: JSON.stringify(patch) },
    ),
  contentProjectApproveOutlineCharter: (projectId: string, outlineCharterId: string) =>
    request<OutlineCharterApproval>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/outline-charters/${encodeURIComponent(outlineCharterId)}/approve`,
      { method: "POST" },
    ),
  contentProjectGenerateOutline: (projectId: string, target: string, instruction?: string) =>
    request<PlatformOutline>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/outlines/${encodeURIComponent(target)}`,
      { method: "POST", body: JSON.stringify(instruction === undefined ? {} : { instruction }) },
    ),
  contentProjectGenerateOutlineSet: (projectId: string) =>
    request<OutlineSetOutcome>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/outlines`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  contentProjectApproveOutline: (projectId: string, target: string) =>
    request<PlatformOutlineApproval>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/outlines/${encodeURIComponent(target)}/approve`,
      { method: "POST" },
    ),
  contentProjectGenerateDraft: (projectId: string, target: string, instruction?: string) =>
    request<ContentEngineDraft>(
      `/api/content-engine/projects/${encodeURIComponent(projectId)}/drafts/${encodeURIComponent(target)}`,
      { method: "POST", body: JSON.stringify(instruction === undefined ? {} : { instruction }) },
    ),
  contentResearchIndex: () => request<ContentResearchIndex>("/api/content-research/index"),
  contentResearchPeople: () => request<NamedPerson[]>("/api/content-research/people"),
  contentResearchAllPeople: () => request<NamedPerson[]>("/api/content-research/people/all"),
  /* A watch is created only against a confirmed Person Profile (spec #134). */
  addContentResearchPerson: (profileId: string, handleHints?: NamedPerson["handleHints"]) =>
    request<NamedPerson>("/api/content-research/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, ...(handleHints ? { handleHints } : {}) }),
    }),
  pauseContentResearchPerson: (id: string) =>
    request<NamedPerson>(`/api/content-research/people/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    }),
  resumeContentResearchPerson: (id: string) =>
    request<NamedPerson>(`/api/content-research/people/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    }),
  stopWatchingContentResearchPerson: (id: string) =>
    request<NamedPerson>(`/api/content-research/people/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  contentResearchSuggestions: () =>
    request<PersonSuggestion[]>("/api/content-research/discovery/suggestions"),
  /* Approving requires the confirmed Profile the watch will be backed by. */
  decideContentResearchSuggestion: (
    id: string,
    action: "approved" | "dismissed" | "restore",
    profileId?: string,
  ) => {
    const path =
      action === "restore"
        ? `/api/content-research/discovery/${encodeURIComponent(id)}/restore`
        : `/api/content-research/discovery/${encodeURIComponent(id)}/${action}`;
    return request<{ suggestion: PersonSuggestion } | PersonSuggestion>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "approved" && profileId ? { profileId } : {}),
    });
  },
  runContentResearch: () =>
    request<{ runId: string }>("/api/content-research/run", { method: "POST" }),
  backfillContentResearch: (windowDays: 7 | 30 | 90) =>
    request<{ runId: string }>("/api/content-research/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowDays }),
    }),
  discoverContentResearchPeople: () =>
    request<{ runId: string }>("/api/content-research/discover", { method: "POST" }),
  youtubeTrends: () => request<YoutubeTrends>("/api/youtube/trends"),
  addYoutubeChannel: (url: string) =>
    request<{ channel: YoutubeChannel }>("/api/youtube/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  removeYoutubeChannel: (id: string) =>
    request<{ removed: string }>(`/api/youtube/channels/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  runYoutubeNow: () => request<{ runId: string }>("/api/youtube/run", { method: "POST" }),
  createYoutubeSpreadsheet: () =>
    request<{ spreadsheet: { id: string; url: string } }>("/api/youtube/spreadsheet", {
      method: "POST",
    }),
};

/** The typed surface a Content page (or its test double) binds to. */
export type ContentClient = typeof contentApi;
