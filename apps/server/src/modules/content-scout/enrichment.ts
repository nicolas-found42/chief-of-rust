import type { SourceComment, SourceItem } from "@chief-of-staff-demo/shared";
import { determineEligibility } from "./eligibility.js";

/** Maximum comments retained per Source Item after enrichment. */
export const CONTENT_SCOUT_MAX_COMMENTS = 50;

export interface PromisingItemSelector {
  (input: { item: SourceItem; brandProfileMarkdown: string }): boolean;
}

const PROMO_PHRASES: Record<string, true> = {
  "click here": true,
  "buy now": true,
  "limited time": true,
  "sign up today": true,
  "free trial": true,
};

function evidenceText(item: SourceItem): string {
  return [item.title, item.body, item.description].filter(Boolean).join("\n").trim();
}

function looksLikePurePromotion(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    Object.keys(PROMO_PHRASES).some((phrase) => lower.includes(phrase)) && lower.includes("% off")
  );
}

/** Default selector: an item is promising if it has enough concrete evidence to benefit from
 *  transcript/comment work. Deterministic eligibility already removed duplicates, stale items,
 *  archived targets, prohibited subjects, inaccessible evidence, and unsupported claims.
 */
function defaultPromisingSelector(input: {
  item: SourceItem;
  brandProfileMarkdown: string;
}): boolean {
  const text = evidenceText(input.item);
  const words = text.split(/\s+/).filter(Boolean);
  return (
    text.length >= 40 &&
    input.item.evidence.length > 0 &&
    words.length >= 30 &&
    !looksLikePurePromotion(text)
  );
}

function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text.trim()) || text.includes("?");
}

function isDisagreement(text: string): boolean {
  return /\b(disagree|wrong|not true|misleading|false|actually|correction)\b/i.test(text);
}

/** Choose up to `max` comments that preserve material questions, disagreement, and popular agreement.
 *  Primary sort is engagement (likes/upvotes), then recency. Diversity rule: ensure at least one
 *  question-shaped comment and at least one disagreement-shaped comment when present.
 */
export function selectDiverseComments(
  comments: SourceComment[],
  max = CONTENT_SCOUT_MAX_COMMENTS,
): SourceComment[] {
  if (comments.length <= max) return comments;

  const scored = comments.map((comment, index) => ({
    comment,
    index,
    engagement: comment.engagement ?? 0,
    publishedAt: comment.publishedAt ? Date.parse(comment.publishedAt) : Number.NEGATIVE_INFINITY,
  }));

  scored.sort((left, right) => {
    if (right.engagement !== left.engagement) return right.engagement - left.engagement;
    if (right.publishedAt !== left.publishedAt) return right.publishedAt - left.publishedAt;
    return left.index - right.index;
  });

  const questions = scored.filter(({ comment }) => isQuestion(comment.text));
  const disagreements = scored.filter(({ comment }) => isDisagreement(comment.text));
  const rest = scored.filter(
    ({ comment }) => !isQuestion(comment.text) && !isDisagreement(comment.text),
  );

  const selected: SourceComment[] = [];
  const used: Record<number, true> = {};
  const take = (pool: typeof scored, limit: number) => {
    for (const entry of pool) {
      if (selected.length >= max) break;
      if (used[entry.index]) continue;
      if (limit <= 0) break;
      selected.push(entry.comment);
      used[entry.index] = true;
      limit -= 1;
    }
  };

  take(questions, 1);
  take(disagreements, 1);
  take(rest, max - selected.length);

  return selected.slice(0, max);
}

/** Run deterministic eligibility as a first gate, then the promising-item selector. */
export function filterPromisingItems(input: {
  items: SourceItem[];
  targets: Parameters<typeof determineEligibility>[0]["targets"];
  brandProfile: Parameters<typeof determineEligibility>[0]["brandProfile"];
  now: Date;
  selector?: PromisingItemSelector;
}): { promising: SourceItem[]; discarded: SourceItem[] } {
  const eligibility = determineEligibility({
    items: input.items,
    targets: input.targets,
    brandProfile: input.brandProfile,
    now: input.now,
  });
  const eligibleById = new Set(eligibility.items.map((item) => item.id));
  const selector =
    input.selector ??
    (({ item }) =>
      defaultPromisingSelector({ item, brandProfileMarkdown: input.brandProfile.markdown }));

  const promising: SourceItem[] = [];
  const discarded: SourceItem[] = [];
  for (const item of input.items) {
    const passesEligibility = eligibleById.has(item.id);
    const passesSelector = selector({ item, brandProfileMarkdown: input.brandProfile.markdown });
    if (passesEligibility && passesSelector) promising.push(item);
    else discarded.push(item);
  }
  return { promising, discarded };
}
