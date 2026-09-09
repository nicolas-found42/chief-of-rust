import type {
  PersonProfile,
  PersonIdentitySignals,
  PersonProfileCorrectionInput,
  PersonProfileCreateInput,
  PersonProfileDeletionReceipt,
  PersonProfileDetachInput,
  PersonProfileLifecycleState,
  PersonProfileMergeInput,
  PersonProfileProjection,
  PersonProfileProjectionPurpose,
  TranscriptRelevanceQuery,
  TranscriptRelevanceReviewItem,
  TranscriptSummary,
  TranscriptConsumerDisclosure,
  TranscriptDeletionReceipt,
  TranscriptDeletionTombstone,
} from "@chief-of-staff-demo/shared";
import { request } from "../client";

/**
 * The Person Profiles area's client: the Workspace's canonical people resource
 * — lookup, projection, identity repair, lifecycle — and the transcript
 * surfaces the area presents: the semantic relevance Review lane and the
 * corpus deletion/tombstones, which the Shell routes at /people/review and
 * Person Profiles links as its review queue. client.ts holds transport only.
 */

/** A typed-identifier lookup: the proposed Profile, never yet saved by `preview`. */
export interface PersonProfileLookup {
  profile: PersonProfile;
  signals: PersonIdentitySignals;
  existing: boolean;
}

export const peopleApi = {
  people: (query?: string, includeArchived?: boolean) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (includeArchived) params.set("includeArchived", "true");
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return request<PersonProfile[]>(`/api/people${suffix}`);
  },
  createPersonProfile: (input: PersonProfileCreateInput) =>
    request<PersonProfile>("/api/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  lookupPersonProfile: (identifier: string) =>
    request<PersonProfileLookup>("/api/people/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier }),
    }),
  acceptPersonProfileLookup: (identifier: string) =>
    request<PersonProfileLookup>("/api/people/lookup/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier }),
    }),
  /** Re-run the public-web search from the identity the Profile already holds. */
  enrichPersonProfile: async (profileId: string) =>
    (
      await request<PersonProfileLookup>(`/api/people/${encodeURIComponent(profileId)}/enrich`, {
        method: "POST",
      })
    ).profile,
  personProfile: (profileId: string) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}`),
  personProfileRevisions: (profileId: string) =>
    request<PersonProfile[]>(`/api/people/${encodeURIComponent(profileId)}/revisions`),
  personProfileRevision: (profileId: string, revision: number) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/revisions/${revision}`),
  personProfileProjection: (
    profileId: string,
    purpose: PersonProfileProjectionPurpose,
    revision?: number,
  ) => {
    const params = new URLSearchParams({ purpose });
    if (revision !== undefined) params.set("revision", String(revision));
    return request<PersonProfileProjection>(
      `/api/people/${encodeURIComponent(profileId)}/projection?${params.toString()}`,
    );
  },
  // --- Identity repair (ticket #121): correction, merge, detach, invalidations.
  correctPersonProfile: (profileId: string, input: PersonProfileCorrectionInput) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  mergePersonProfile: (profileId: string, input: PersonProfileMergeInput) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/merges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  detachPersonEvidence: (profileId: string, input: PersonProfileDetachInput) =>
    request<{ from: PersonProfile; to: PersonProfile | null }>(
      `/api/people/${encodeURIComponent(profileId)}/detachments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  // --- Profile lifecycle (ticket #122): archive, restore, privacy deletion.
  personProfileLifecycle: (profileId: string) =>
    request<PersonProfileLifecycleState>(`/api/people/${encodeURIComponent(profileId)}/lifecycle`),
  archivePersonProfile: (profileId: string) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/archive`, {
      method: "POST",
    }),
  restorePersonProfile: (profileId: string) =>
    request<PersonProfile>(`/api/people/${encodeURIComponent(profileId)}/restore`, {
      method: "POST",
    }),
  privacyDeletePersonProfile: (profileId: string, confirmation: string) =>
    request<PersonProfileDeletionReceipt>(
      `/api/people/${encodeURIComponent(profileId)}/privacy-delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation }),
      },
    ),
  // --- The transcript surfaces this area presents (see the module comment).
  transcriptRelevanceQueue: () =>
    request<{ items: TranscriptRelevanceReviewItem[] }>("/api/transcripts/review/relevance"),
  searchTranscriptRelevance: (query: TranscriptRelevanceQuery) =>
    request<{ items: TranscriptRelevanceReviewItem[] }>(
      "/api/transcripts/review/relevance/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
      },
    ),
  decideTranscriptRelevance: (
    candidateId: string,
    action: "confirm" | "reject" | "unresolved",
    note?: string,
  ) =>
    request<{ item: TranscriptRelevanceReviewItem }>(
      `/api/transcripts/review/relevance/${encodeURIComponent(candidateId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      },
    ),
  transcripts: () => request<{ transcripts: TranscriptSummary[] }>("/api/transcripts"),
  transcriptDeletionPreview: (transcriptId: string) =>
    request<{ transcript: TranscriptSummary; consumerRecords: TranscriptConsumerDisclosure[] }>(
      `/api/transcripts/${encodeURIComponent(transcriptId)}/deletion-preview`,
    ),
  deleteTranscript: (transcriptId: string, confirmation: string) =>
    request<TranscriptDeletionReceipt>(
      `/api/transcripts/${encodeURIComponent(transcriptId)}/delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation }),
      },
    ),
  transcriptTombstones: () =>
    request<{ tombstones: TranscriptDeletionTombstone[] }>("/api/transcripts/tombstones"),
  restoreTranscriptProcessing: (externalFileId: string) =>
    request<{ tombstone: TranscriptDeletionTombstone }>(
      `/api/transcripts/tombstones/${encodeURIComponent(externalFileId)}/restore`,
      { method: "POST" },
    ),
};

/** The typed surface a Person Profiles page (or its test double) binds to. */
export type PeopleClient = typeof peopleApi;
