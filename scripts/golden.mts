/**
 * The golden expectation format, shared by the scorer and the golden linter.
 *
 * Authoring guide and field reference: tests/fixtures/debrief-golden/GOLDEN_FORMAT.md.
 */
export const SCHEMA_VERSION = 3;
export const FIXTURES_DIR = "tests/fixtures/debrief-golden";
export const TRANSCRIPT_DIR = `${FIXTURES_DIR}/transcripts`;

export type Bucket = "decisions" | "actionItems" | "openQuestions";
export const BUCKETS = ["decisions", "actionItems", "openQuestions"] as const;

export interface Group {
  id: string;
  gist: string;
  any: string[][];
  /** Disqualifies a produced item that would otherwise match — the wrong conclusion. */
  none?: string[];
  /** Expectations: the acceptable owners; `null` means the transcript names nobody. */
  owner?: string | (string | null)[] | null;
  dueDate?: (string | null)[];
  /** Opt out of the "a date cued by a weekday must land on it" rule. */
  weekdayRule?: boolean;
  /** Reported when missing, but not counted toward the floor. */
  optional?: boolean;
  /** Credit this item when the fact surfaces in another bucket instead. */
  alsoAcceptIn?: Bucket;
  /** mustNotAppear only: the buckets this guard fires in. Default: all three. */
  bucket?: Bucket | Bucket[];
  /** Free prose for the reader; the scorer ignores it. */
  note?: string;
}

export interface Golden {
  schemaVersion?: number;
  transcript?: string;
  /** `null` when the transcript states no meeting day; then every date must be null. */
  meetingDate: string | null;
  meetingWeekday?: string;
  /** Inclusive [start, end]; defaults to the eight dates the prompt supplies. */
  dueDateWindow?: [string, string] | null;
  decisions: Group[];
  actionItems: Group[];
  openQuestions: Group[];
  mustNotAppear: Group[];
  decisionsMin: number;
  actionItemsMin: number;
  openQuestionsMin: number;
  /** Ceiling on produced items no expectation consumed. Default: the bucket's expectation count. */
  maxUnmatched?: Partial<Record<Bucket, number>>;
}

/**
 * A golden as it comes off disk: the linter's job is to prove the fields are
 * there, so it may not assume them.
 */
export type Unchecked<T> = {
  [K in keyof T]?: T[K] extends (infer Element)[] ? Partial<Element>[] : T[K];
};

/** One value per bucket, built the same way everywhere. */
export const byBucket = <T,>(make: () => T): Record<Bucket, T> => ({
  decisions: make(),
  actionItems: make(),
  openQuestions: make(),
});

/** The three expectation buckets of a golden, keyed like everything else. */
export const expectationsOf = (golden: Golden): Record<Bucket, Group[]> => ({
  decisions: golden.decisions,
  actionItems: golden.actionItems,
  openQuestions: golden.openQuestions,
});

/** The three coverage floors. */
export const floorsOf = (golden: Golden): Record<Bucket, number> => ({
  decisions: golden.decisionsMin,
  actionItems: golden.actionItemsMin,
  openQuestions: golden.openQuestionsMin,
});

const regexCache = new Map<string, RegExp>();

/**
 * A keyword matches on word boundaries, so "fee" does not hide in "coffee".
 * `*` stands for a run of word characters: "availab*" matches "availability",
 * "small* group" matches "small group" and "smaller group". A space in a
 * keyword matches any run of separators, so "check in" also matches "check-in".
 *
 * Word boundaries do not separate digits inside an ISO date, so a bare "10"
 * still matches "2026-10-06" — never write a bare one- or two-digit number.
 */
function toRegex(word: string): RegExp {
  const cached = regexCache.get(word);
  if (cached) return cached;
  const body = word
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\W_]+"))
    .join("\\w*");
  const left = /^\w/.test(word) ? "\\b" : "";
  const right = /\w$/.test(word) ? "\\b" : "";
  const compiled = new RegExp(`${left}${body}${right}`, "i");
  regexCache.set(word, compiled);
  return compiled;
}

/**
 * Every group needs one keyword present, and no `none` keyword may appear. An
 * item with no keyword groups matches nothing; `eval:lint` rejects one.
 */
export function matches(item: string, group: Partial<Pick<Group, "any" | "none">>): boolean {
  if (group.none?.some((word) => toRegex(word).test(item))) return false;
  const groups = group.any ?? [];
  return (
    groups.length > 0 &&
    groups.every((alternatives) => alternatives.some((word) => toRegex(word).test(item)))
  );
}

/** The acceptable owners as a list, or null when the expectation states none. */
export function acceptedOwners(owner: Group["owner"]): (string | null)[] | null {
  if (owner === undefined) return null;
  if (owner === null) return [null];
  return Array.isArray(owner) ? owner : [owner];
}

/** Name tokens long enough to identify a person. */
export const nameTokens = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 3);
