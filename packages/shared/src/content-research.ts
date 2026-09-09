import { z } from "zod/v3";
import type {
  SourceAdapterState,
  SourceDiagnosticClassification,
  SourceFieldState,
} from "./source-items.js";
import type { PersonProfilePublicSafeProjection } from "./person-profile.js";

export const CONTENT_RESEARCH_MODULE_ID = "content-research" as const;
export const CONTENT_RESEARCH_MODULE_VERSION = 1 as const;

export const NAMED_PERSON_HANDLE_HINTS_SCHEMA = z.strictObject({
  blueskyDid: z.string().optional(),
  mastodon: z.string().optional(),
  youtubeChannelId: z.string().optional(),
  hnUsername: z.string().optional(),
  blogRssHints: z.array(z.string()).default([]),
});
export type NamedPersonHandleHints = z.infer<typeof NAMED_PERSON_HANDLE_HINTS_SCHEMA>;

export interface NamedPerson {
  id: string;
  name: string;
  /** The confirmed Person Profile this watch is backed by (spec #134). */
  profileId: string;
  /** Lifecycle state: a paused watch collects nothing but keeps its configuration. */
  pausedAt: string | null;
  handleHints: NamedPersonHandleHints;
  discoveredSourceTargets: { adapterId: string; url: string; label: string }[];
  createdAt: string;
  archivedAt: string | null;
}

export type PersonSuggestionState = "pending" | "approved" | "dismissed";

export interface PersonSuggestion {
  id: string;
  name: string;
  reason: string;
  supportingUrls: string[];
  relationshipToBrand: string;
  source: string;
  state: PersonSuggestionState;
  discoveredAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface ContentResearchBaseline {
  personId: string;
  /** Weighted counts for last up to 90 days, newest last. */
  history: number[];
  mean: number;
  stdDev: number;
  updatedAt: string;
}

export interface ContentResearchScheduleState {
  lastSuccessfulDailyPeriod: string | null;
  lastSuccessfulDiscoveryPeriod: string | null;
  lastDailyCheckpoint: string | null;
}

/** Platform weights for resonance rollup: views 1, votes 2, HN points 3, reposts 4 */
export const CONTENT_RESEARCH_PLATFORM_WEIGHTS = {
  views: 1,
  votes: 2,
  hnPoints: 3,
  reposts: 4,
} as const;

/** The surfaces a Named Person is watched on (spec #116 V1 portfolio). */
export const CONTENT_RESEARCH_PLATFORMS = ["rss", "youtube", "reddit", "hn", "news"] as const;
export type ContentResearchPlatform = (typeof CONTENT_RESEARCH_PLATFORMS)[number];

/**
 * What a `resonanceScore` actually is. A z-score needs a baseline with spread;
 * until a Person has one, the number is a raw level or a bare delta and must
 * not be read as a z-score.
 */
export const RESONANCE_SCORE_BASES = ["z_score", "delta_from_mean", "raw_level"] as const;
export type ResonanceScoreBasis = (typeof RESONANCE_SCORE_BASES)[number];

export interface ResonanceCounts {
  views?: number;
  votes?: number;
  hnPoints?: number;
  redditScore?: number;
  reposts?: number;
  likes?: number;
}

export interface ResonanceScoredItem {
  canonicalUrl: string;
  platform: ContentResearchPlatform;
  title: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  counts: ResonanceCounts;
  weightedCount: number;
  resonanceScore: number;
  /** How to read `resonanceScore` — never assume it is a z-score. */
  resonanceBasis: ResonanceScoreBasis;
  hook: string | null;
  evidenceQuote?: string | null;
  evidenceUrl: string | null;
  completeness: {
    title: SourceFieldState;
    body: SourceFieldState;
    description: SourceFieldState;
    transcript: SourceFieldState;
    comments: SourceFieldState;
    media: SourceFieldState;
  };
  sourceItemId: string;
}

export interface ResonanceReport {
  personId: string;
  personName: string;
  generatedAt: string;
  items: ResonanceScoredItem[];
  topEvidence: { canonicalUrl: string; title: string | null }[];
}

export interface ContentResearchProfilePin {
  personId: string;
  profileId: string;
  profileRevision: number;
  /** The exact public-safe projection this Run collected against. */
  projection: PersonProfilePublicSafeProjection;
}

export interface ContentResearchRunResult {
  reports: ResonanceReport[];
  adapters: {
    adapterId: string;
    state: SourceAdapterState;
    outcome: SourceDiagnosticClassification;
    itemsFound: number;
    errorClassifications: SourceDiagnosticClassification[];
  }[];
  ledgerRows: ContentResearchLedgerRow[];
  /** One pin per watched person: the exact Profile revision and public-safe
      projection this Run used (spec #134). */
  profilePins: ContentResearchProfilePin[];
}

export interface ContentResearchLedgerRow {
  person: string;
  personId: string;
  canonicalUrl: string;
  publishedAt: string | null;
  platform: ContentResearchPlatform;
  title: string | null;
  url: string;
  views: number | null;
  likes: number | null;
  hnPoints: number | null;
  redditScore: number | null;
  resonanceScore: number;
  evidenceUrl: string | null;
}

/** Result Shape for hook extraction (Module owns, never Shell per ADR-0029). */
export const ResonanceHookShapeSchema = z.strictObject({
  hook: z.string(),
  evidenceQuote: z.string().optional(),
});
export type ResonanceHookShape = z.infer<typeof ResonanceHookShapeSchema>;

/** Result Shape for People Discovery (LLM proposes candidates). */
export const PeopleSuggestionShapeSchema = z.strictObject({
  candidates: z.array(
    z.strictObject({
      name: z.string(),
      reason: z.string(),
      supportingUrls: z.array(z.string()),
      relationshipToBrand: z.string().optional(),
    }),
  ),
});
export type PeopleSuggestionShape = z.infer<typeof PeopleSuggestionShapeSchema>;

/** Cross-Run index derived on read per ADR-0005. */
export interface ContentResearchIndex {
  byPerson: {
    personId: string;
    personName: string;
    reports: {
      runId: string;
      generatedAt: string;
      resonanceScoreMax: number;
      items: ResonanceScoredItem[];
    }[];
  }[];
  runs: {
    runId: string;
    intake: string;
    status: string;
    createdAt: string;
    summary: string;
  }[];
}
