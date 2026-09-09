import { createHash } from "node:crypto";
import type {
  BrandProfileRevision,
  RankedOpportunity,
  SourceAdapterState,
  SourceItem,
  SourceStoryGroup,
  SourceTarget,
} from "@chief-of-staff-demo/shared";

const ELIGIBILITY_WINDOW_MS = 7 * 86_400_000;

type EligibilityExclusionReason =
  | "exact_duplicate"
  | "stale"
  | "archived_target"
  | "prohibited_subject"
  | "inaccessible_evidence"
  | "unsupported_claim";

export interface EligibilityResult {
  items: SourceItem[];
  storyGroups: SourceStoryGroup[];
  exclusions: { sourceItemId: string; reason: EligibilityExclusionReason }[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function prohibitedPhrases(markdown: string): string[] {
  return ["Avoided subjects", "Prohibited claims"].flatMap((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i").exec(
      markdown,
    )?.[1];
    return (section?.match(/^\s*[-*]\s+(.+)$/gm) ?? [])
      .map((line) =>
        line
          .replace(/^\s*[-*]\s+/, "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  });
}

function evidenceText(item: SourceItem): string {
  return [item.title, item.body, item.description, item.transcript]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function accessible(item: SourceItem): boolean {
  try {
    const url = new URL(item.canonicalUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  } catch {
    return false;
  }
  const hasAvailableText = (["title", "body", "description", "transcript"] as const).some(
    (field) => item.completeness[field] === "available",
  );
  return hasAvailableText && evidenceText(item).length >= 20 && item.evidence.length > 0;
}

function storyTokens(item: SourceItem): string[] {
  const source = item.title ?? item.description ?? item.body ?? item.canonicalUrl;
  return [
    ...new Set(
      source
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2 && !/^\d+$/.test(token) && !STOP_WORDS.has(token)),
    ),
  ].sort();
}

const STOP_WORDS = new Set(["the", "and", "for", "from", "with", "that", "this", "what", "into"]);

const MIN_SHARED_STORY_TOKENS = 2;
const MIN_STORY_JACCARD = 0.18;

function storySeed(item: SourceItem): string {
  return item.storyKey?.trim().toLowerCase() || storyTokens(item).slice(0, 16).join("-");
}

function sameInferredStory(left: SourceItem, right: SourceItem): boolean {
  const leftKey = left.storyKey?.trim().toLowerCase();
  const rightKey = right.storyKey?.trim().toLowerCase();
  if (leftKey || rightKey) return Boolean(leftKey && rightKey && leftKey === rightKey);

  const leftTokens = new Set(storyTokens(left));
  const rightTokens = new Set(storyTokens(right));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (shared < MIN_SHARED_STORY_TOKENS) return false;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 && shared / union >= MIN_STORY_JACCARD;
}

function inferredGroupSeed(groupItems: SourceItem[]): string {
  return storySeed(groupItems[0]!);
}

function hasUnsupportedClaim(item: SourceItem): boolean {
  if (item.claims?.some((claim) => claim.state === "unsupported")) return true;
  return /\b(?:guarantees?|guaranteed|risk[- ]free|will definitely|always profitable|never fails?)\b/i.test(
    evidenceText(item),
  );
}

export function determineEligibility(input: {
  items: SourceItem[];
  targets: SourceTarget[];
  brandProfile: BrandProfileRevision;
  now: Date;
}): EligibilityResult {
  const activeTargets = new Set(
    input.targets.filter((target) => target.state === "active").map((target) => target.id),
  );
  const prohibited = prohibitedPhrases(input.brandProfile.markdown);
  const cutoff = input.now.getTime() - ELIGIBILITY_WINDOW_MS;
  const externalIds = new Set<string>();
  const canonicalUrls = new Set<string>();
  const items: SourceItem[] = [];
  const exclusions: EligibilityResult["exclusions"] = [];

  for (const item of input.items) {
    const exclude = (reason: EligibilityExclusionReason) =>
      exclusions.push({ sourceItemId: item.id, reason });
    const externalKey = `${item.adapterId}:${item.externalId}`;
    if (externalIds.has(externalKey) || canonicalUrls.has(item.canonicalUrl)) {
      exclude("exact_duplicate");
      continue;
    }
    externalIds.add(externalKey);
    canonicalUrls.add(item.canonicalUrl);
    const observedAt = Date.parse(item.publishedAt ?? item.discoveredAt);
    if (!Number.isFinite(observedAt) || observedAt < cutoff) {
      exclude("stale");
      continue;
    }
    if (!activeTargets.has(item.targetId)) {
      exclude("archived_target");
      continue;
    }
    const normalized = evidenceText(item).toLowerCase();
    if (prohibited.some((phrase) => normalized.includes(phrase))) {
      exclude("prohibited_subject");
      continue;
    }
    if (!accessible(item)) {
      exclude("inaccessible_evidence");
      continue;
    }
    if (hasUnsupportedClaim(item)) {
      exclude("unsupported_claim");
      continue;
    }
    items.push(item);
  }

  const groupedItems: SourceItem[][] = [];
  for (const item of items) {
    const matching = groupedItems.find((group) =>
      group.some((peer) => sameInferredStory(peer, item)),
    );
    if (matching) matching.push(item);
    else groupedItems.push([item]);
  }
  const storyGroups = groupedItems.map((group) => ({
    canonicalKey: `story-${hash(inferredGroupSeed(group))}`,
    sourceItemIds: group.map((item) => item.id),
  }));
  return { items, storyGroups, exclusions };
}

export function enforceOpportunityIdentity(input: {
  ranked: RankedOpportunity[];
  items: SourceItem[];
  storyGroups: SourceStoryGroup[];
  adapterStates: Map<string, SourceAdapterState>;
}): RankedOpportunity[] {
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const itemByUrl = new Map(input.items.map((item) => [item.canonicalUrl, item]));
  const groupByItem = new Map<string, SourceStoryGroup>();
  for (const group of input.storyGroups) {
    for (const id of group.sourceItemIds) groupByItem.set(id, group);
  }
  const retained = new Map<string, RankedOpportunity>();
  for (const candidate of input.ranked) {
    const referenced = new Set<string>();
    for (const id of candidate.sourceItemIds) if (itemById.has(id)) referenced.add(id);
    for (const url of candidate.sourceUrls) {
      const item = itemByUrl.get(url);
      if (item) referenced.add(item.id);
    }
    const groups = [
      ...new Set([...referenced].map((id) => groupByItem.get(id)).filter(Boolean)),
    ] as SourceStoryGroup[];
    if (groups.length === 0) continue;
    const canonicalKey =
      groups.length === 1
        ? groups[0]!.canonicalKey
        : `story-${hash(
            groups
              .map((group) => group.canonicalKey)
              .sort()
              .join("|"),
          )}`;
    const evidence = input.items.filter((item) =>
      groups.some((group) => group.sourceItemIds.includes(item.id)),
    );
    const normalized: RankedOpportunity = {
      ...candidate,
      id: `opportunity-${hash(`${canonicalKey}|${candidate.angle}`)}`,
      canonicalKey,
      sourceItemIds: evidence.map((item) => item.id),
      sourceUrls: [...new Set(evidence.map((item) => item.canonicalUrl))],
      experimentalEvidence: evidence.some(
        (item) => input.adapterStates.get(item.adapterId) === "experimental",
      ),
    };
    const mergeKey = `${canonicalKey}|${candidate.angle}`;
    const previous = retained.get(mergeKey);
    if (!previous || normalized.confidence > previous.confidence)
      retained.set(mergeKey, normalized);
  }
  return [...retained.values()];
}
