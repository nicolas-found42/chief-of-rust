/**
 * The Source Adapter and Source Item contracts of the Workspace's shared
 * public-evidence seam. They belong to the Workspace rather than to any one
 * Module, so Content Scout, Content Research and Person Profiles all read the
 * same normalized evidence and the same diagnostic vocabulary.
 */
export const SOURCE_ADAPTER_STATES = ["available", "experimental", "coming_later"] as const;
export type SourceAdapterState = (typeof SOURCE_ADAPTER_STATES)[number];

export const SOURCE_FIELD_STATES = ["available", "unavailable", "unsupported", "failed"] as const;
export type SourceFieldState = (typeof SOURCE_FIELD_STATES)[number];

export const SOURCE_DIAGNOSTIC_CLASSIFICATIONS = [
  "items_found",
  "legitimate_empty",
  "no_new_material",
  "unsupported_capability",
  "not_found",
  "blocked_access",
  "response_shape_change",
  "rate_limit",
  "timeout",
  "parser_failure",
  "internal_failure",
] as const;
export type SourceDiagnosticClassification = (typeof SOURCE_DIAGNOSTIC_CLASSIFICATIONS)[number];

/** One classification boundary shared by server health and receipt rendering. */
export function isSuccessfulSourceDiagnostic(
  classification: SourceDiagnosticClassification,
): boolean {
  return (
    classification === "items_found" ||
    classification === "legitimate_empty" ||
    classification === "no_new_material"
  );
}

export const SOURCE_PARSER_STAGES = [
  "adapter_boundary",
  "conditional_request",
  "embedded_public_data",
  "fetch",
  "public_embedded_data",
  "readability",
  "reddit_html_parse",
  "reddit_json_parse",
  "rss",
  "rss_parse",
  "browser_render",
  "youtube",
  "youtube_data_api",
  "yt_dlp",
  "instaloader",
  "unknown_stage",
] as const;
export type SourceParserStage = (typeof SOURCE_PARSER_STAGES)[number];

export const SOURCE_CAPABILITIES = [
  "body",
  "channel",
  "comments",
  "description",
  "items",
  "source_target",
  "title",
  "transcript",
  "youtube",
  "unknown_capability",
] as const;
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];

export interface SourceEvidenceReceipt {
  route: string;
  retrievedAt: string;
}

export interface SourceComment {
  author: string | null;
  publishedAt: string | null;
  url: string | null;
  text: string;
  engagement: number | null;
}

/** Counts a platform publishes about an item. Every field is optional: an
    adapter reports what its platform exposes and nothing more. */
export interface SourceEngagement {
  views?: number;
  likes?: number;
  votes?: number;
  hnPoints?: number;
  redditScore?: number;
  reposts?: number;
  commentCount?: number;
}

/** Normalized public evidence retrieved by a Source Adapter. Untrusted third-party material — never an instruction to the Module. */
export interface SourceItem {
  id: string;
  externalId: string;
  targetId: string;
  adapterId: string;
  canonicalUrl: string;
  author: string | null;
  title: string | null;
  body: string | null;
  description: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  media: { type: "image" | "audio" | "video"; url: string }[];
  transcript: string | null;
  comments: SourceComment[];
  evidence: SourceEvidenceReceipt[];
  completeness: {
    title: SourceFieldState;
    body: SourceFieldState;
    description: SourceFieldState;
    transcript: SourceFieldState;
    comments: SourceFieldState;
    media: SourceFieldState;
  };
  /**
   * Engagement the platform itself reported for this item, when it reports any.
   * Observed counts only — never a model's estimate — and absent rather than
   * zero when the platform exposes none, so "no engagement surface" stays
   * distinguishable from "nobody engaged".
   */
  engagement?: SourceEngagement;
  /** Adapter-supplied stable story identity when the platform exposes one. */
  storyKey?: string;
  /** Deterministic claim support produced by extraction/enrichment, when known. */
  claims?: {
    text: string;
    state: "supported" | "unsupported";
    sourceUrls: string[];
  }[];
}

export interface SourceStoryGroup {
  canonicalKey: string;
  sourceItemIds: string[];
}

export interface AdapterDiagnostic {
  classification: SourceDiagnosticClassification;
  route: string;
  status: number | null;
  contentType: string | null;
  parserStage: SourceParserStage;
  responseHash: string;
  adapterVersion: string;
  startedAt: string;
  finishedAt: string;
  retries: number;
  affectedCapabilities: SourceCapability[];
  causeChain: string[];
  /** Parsed Retry-After delay supplied by the remote host, when present. */
  retryAfterMs?: number;
}

export interface SourceCollectionAttemptReceipt {
  targetId: string;
  adapterId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  outcome: SourceDiagnosticClassification;
  checkpointBefore: string | null;
  checkpointAfter: string | null;
  conditionalRequest: { etag: string | null; lastModified: string | null } | null;
  conditionalResponse: { etag: string | null; lastModified: string | null } | null;
  backoffMs: number;
  /** Present on receipts written since Module version 1 diagnostics were completed. */
  diagnostic?: AdapterDiagnostic;
  itemsFound?: number;
}

/** The only user-requested backfill windows a Source Adapter may declare support for. */
export const SOURCE_BACKFILL_WINDOWS_DAYS = [7, 30, 90] as const;
export type SourceBackfillWindowDays = (typeof SOURCE_BACKFILL_WINDOWS_DAYS)[number];

export interface SourceTarget {
  id: string;
  adapterId: string;
  label: string;
  url: string;
  state: "active" | "archived";
  createdAt: string;
  archivedAt: string | null;
  checkpoint: string | null;
  lastSuccessfulAt: string | null;
  conditional: { etag: string | null; lastModified: string | null } | null;
}

export interface SourceAdapterCanaryTarget {
  adapterId: string;
  label: string;
  url: string;
}
