import type {
  DailyBriefingState,
  WeeklyWorkspaceView,
  HubSpotSetupCheck,
  HubSpotStatus,
  Meeting,
  MeetingIndex,
  MeetingBriefIndex,
  MeetingBriefPersonProfileReadModel,
  MeetingDebriefDetail,
  MeetingDebriefField,
  MeetingDebriefIndex,
  MeetingDebriefRecipient,
} from "@chief-of-staff-demo/shared";
import { request } from "../client";

/**
 * The Meeting Wizard's client: the meetings index and its merge repair, and
 * the two sibling workflows it presents — the prospective Brief (including the
 * HubSpot output adapter's status and the bundle provider policy) and the
 * retrospective Debrief. Every Meeting surface reads the server through this
 * one typed vocabulary; client.ts holds transport only.
 */

/** The Meeting Brief bundle vocabulary and the owner's recorded policy over it. */
export interface ProviderPolicyState {
  providers: string[];
  policy: Record<string, { disabled: boolean; changedAt: string; reason: string }>;
}

export const meetingsApi = {
  hubspotStatus: () => request<HubSpotStatus>("/api/meeting-brief/hubspot/status"),
  hubspotConnect: (token: string) =>
    request<HubSpotStatus>("/api/meeting-brief/hubspot/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  hubspotDisconnect: () =>
    request<HubSpotStatus>("/api/meeting-brief/hubspot/disconnect", { method: "POST" }),
  hubspotCheck: () =>
    request<HubSpotSetupCheck>("/api/meeting-brief/hubspot/check", { method: "POST" }),
  meetings: () => request<MeetingIndex>("/api/meetings/list"),
  meeting: (meetingId: string) =>
    request<Meeting>(`/api/meetings/${encodeURIComponent(meetingId)}`),
  meetingTranscripts: (meetingId: string) =>
    request<{ transcripts: { id: string; title: string }[] }>(
      `/api/meetings/${encodeURIComponent(meetingId)}/transcripts`,
    ),
  meetingNearMatches: (meetingId: string) =>
    request<{ nearMatches: Meeting[] }>(
      `/api/meetings/${encodeURIComponent(meetingId)}/near-matches`,
    ),
  mergeMeeting: (meetingId: string, input: { targetOccurrenceKey: string }) =>
    request<Meeting>(`/api/meetings/${encodeURIComponent(meetingId)}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  meetingBriefConfig: () => request<{ internalDomains: string[] }>("/api/meeting-brief/config"),
  saveMeetingBriefConfig: (input: string[] | { internalDomains?: string[] }) =>
    request<{ internalDomains: string[] }>("/api/meeting-brief/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Array.isArray(input) ? { internalDomains: input } : input),
    }),
  meetingBriefProviderPolicy: () =>
    request<ProviderPolicyState>("/api/meeting-brief/provider-policy"),
  saveMeetingBriefProviderPolicy: (disabled: string[]) =>
    request<ProviderPolicyState>("/api/meeting-brief/provider-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled }),
    }),
  meetingBriefIndex: () => request<MeetingBriefIndex>("/api/meeting-brief/index"),
  dailyBriefing: () => request<DailyBriefingState>("/api/meeting-brief/daily"),
  retryDailyBriefing: () =>
    request<DailyBriefingState>("/api/meeting-brief/daily/retry", { method: "POST" }),
  /**
   * Meeting Wizard — This week (issues #194, #195, #196). The deterministic
   * read is the whole week without a Weekly Summary, so a figure on the Today
   * tab never spends a model call; the full read generates when it must.
   */
  weeklyWorkspaceDeterministic: () =>
    request<WeeklyWorkspaceView>("/api/meetings/weekly/deterministic"),
  weeklyWorkspace: () => request<WeeklyWorkspaceView>("/api/meetings/weekly"),
  regenerateWeeklySummary: () =>
    request<WeeklyWorkspaceView>("/api/meetings/weekly/regenerate", { method: "POST" }),
  /** Confirm the exact provider and model before private projections are sent. */
  consentWeeklySummary: (provider: string, model: string) =>
    request<{ consented: boolean }>("/api/meetings/weekly/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model }),
    }),
  meetingBriefProfileConsumers: (runId: string) =>
    request<MeetingBriefPersonProfileReadModel>(
      `/api/meeting-brief/runs/${encodeURIComponent(runId)}/profile-consumers`,
    ),
  regenerateMeetingBrief: (runId: string) =>
    request<{ runId: string }>(`/api/meeting-brief/runs/${encodeURIComponent(runId)}/regenerate`, {
      method: "POST",
    }),
  meetingDebriefIndex: () => request<MeetingDebriefIndex>("/api/meeting-debrief/index"),
  meetingDebriefDetail: (runId: string) =>
    request<MeetingDebriefDetail>(`/api/meeting-debrief/${encodeURIComponent(runId)}`),
  meetingDebriefRegenerate: (runId: string, field: MeetingDebriefField) =>
    request<{ resumed: boolean }>(`/api/meeting-debrief/${encodeURIComponent(runId)}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field }),
    }),
  meetingDebriefConfirmRoster: (
    runId: string,
    entries: Array<{ email: string; displayName?: string | null }>,
  ) =>
    request<{ roster: { status: string } }>(
      `/api/meeting-debrief/${encodeURIComponent(runId)}/roster`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      },
    ),
  meetingDebriefAddRecipient: (runId: string, input: { profileId: string; email: string }) =>
    request<{ recipients: MeetingDebriefRecipient[] }>(
      `/api/meeting-debrief/${encodeURIComponent(runId)}/recipients`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  meetingDebriefRemoveRecipient: (runId: string, profileId: string) =>
    request<{ recipients: MeetingDebriefRecipient[] }>(
      `/api/meeting-debrief/${encodeURIComponent(runId)}/recipients/${encodeURIComponent(profileId)}`,
      { method: "DELETE" },
    ),
  meetingDebriefApprove: (runId: string) =>
    request<{ resumed: boolean }>(`/api/meeting-debrief/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
    }),
  meetingDebriefRedo: (runId: string) =>
    request<{ runId: string }>(`/api/meeting-debrief/${encodeURIComponent(runId)}/redo`, {
      method: "POST",
    }),
  reconcileMeetingBrief: (forceFullSync = false) =>
    request<{
      scheduled: number;
      removed: number;
      invalidSyncRecovered: boolean;
      upcoming: unknown[];
    }>("/api/meeting-brief/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forceFullSync }),
    }),
  prepareMeetingBriefNow: (occurrenceKey: string) =>
    request<{ runId: string | null; upcoming: unknown[] }>("/api/meeting-brief/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ occurrenceKey }),
    }),
  meetingBriefCalendarStatus: () =>
    request<{
      channel: {
        channelId: string;
        resourceId: string | null;
        expiration: string | null;
        calendarId: string;
      } | null;
      syncToken: string | null;
      hasToken: boolean;
      lastSyncAt: string | null;
    }>("/api/meeting-brief/calendar/status"),
};

/** The typed surface a Meeting Wizard page (or its test double) binds to. */
export type MeetingsClient = typeof meetingsApi;
