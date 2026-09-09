import type { SourceItem } from "@chief-of-staff-demo/shared";
import {
  CONTENT_RESEARCH_PLATFORM_WEIGHTS,
  type ContentResearchPlatform,
  type ResonanceCounts,
  type ResonanceScoreBasis,
  type ResonanceScoredItem,
} from "@chief-of-staff-demo/shared";

/**
 * The counts a platform reported for this item. Only what the adapter observed
 * is carried through — an absent count means the platform exposes none, and is
 * never read as a zero the way a missing field silently would be.
 */
function extractCounts(item: SourceItem): ResonanceCounts {
  const counts: ResonanceCounts = {};
  const engagement = item.engagement;
  if (engagement) {
    if (engagement.views !== undefined) counts.views = engagement.views;
    if (engagement.likes !== undefined) counts.likes = engagement.likes;
    if (engagement.votes !== undefined) counts.votes = engagement.votes;
    if (engagement.hnPoints !== undefined) counts.hnPoints = engagement.hnPoints;
    if (engagement.redditScore !== undefined) counts.redditScore = engagement.redditScore;
    if (engagement.reposts !== undefined) counts.reposts = engagement.reposts;
  }
  return counts;
}

function weightedCount(counts: ResonanceCounts): number {
  const views = counts.views ?? 0;
  const votes = counts.votes ?? counts.redditScore ?? counts.likes ?? 0;
  const hnPoints = counts.hnPoints ?? 0;
  const reposts = counts.reposts ?? 0;
  return (
    views * CONTENT_RESEARCH_PLATFORM_WEIGHTS.views +
    votes * CONTENT_RESEARCH_PLATFORM_WEIGHTS.votes +
    hnPoints * CONTENT_RESEARCH_PLATFORM_WEIGHTS.hnPoints +
    reposts * CONTENT_RESEARCH_PLATFORM_WEIGHTS.reposts
  );
}

/**
 * Adapter ids are known constants, so the platform is a lookup rather than a
 * guess: substring matching mislabels any future id that merely contains "hn".
 * An id with no entry reads as `rss`, the plain-feed surface.
 */
const PLATFORM_BY_ADAPTER: Record<string, ContentResearchPlatform> = {
  rss: "rss",
  website: "rss",
  substack: "rss",
  youtube: "youtube",
  reddit: "reddit",
  hn: "hn",
  news: "news",
};

function platformForAdapter(adapterId: string): ContentResearchPlatform {
  return PLATFORM_BY_ADAPTER[adapterId.toLowerCase()] ?? "rss";
}

export function toScoredItem(input: {
  item: SourceItem;
  adapterId: string;
  hook: string | null;
  evidenceQuote?: string | null;
  baseline: { mean: number; stdDev: number; historyLength: number } | null;
}): ResonanceScoredItem {
  const counts = extractCounts(input.item);
  const w = weightedCount(counts);
  /* A z-score needs a baseline with spread. Until the Person has one, say so
     rather than passing a raw level off as a z-score. */
  const { score, basis } = ((): { score: number; basis: ResonanceScoreBasis } => {
    if (!input.baseline || input.baseline.historyLength === 0)
      return { score: w, basis: "raw_level" };
    if (input.baseline.stdDev === 0)
      return { score: w - input.baseline.mean, basis: "delta_from_mean" };
    return { score: (w - input.baseline.mean) / input.baseline.stdDev, basis: "z_score" };
  })();
  return {
    canonicalUrl: input.item.canonicalUrl,
    platform: platformForAdapter(input.adapterId),
    title: input.item.title,
    publishedAt: input.item.publishedAt,
    discoveredAt: input.item.discoveredAt,
    counts,
    weightedCount: w,
    resonanceScore: score,
    resonanceBasis: basis,
    hook: input.hook,
    evidenceQuote: input.evidenceQuote ?? null,
    evidenceUrl: input.item.evidence[0]?.route ?? input.item.canonicalUrl,
    /* The adapter already reported each field's state; carrying it through as
       the domain type keeps `unsupported` distinguishable from `failed`. */
    completeness: { ...input.item.completeness },
    sourceItemId: input.item.id,
  };
}
