/**
 * Lint the hand-written golden expectations.
 *
 * usage:
 *   tsx scripts/lint-golden.mts [<golden.json> ...]     (default: every golden)
 *
 * These are the authoring mistakes that make a golden score the wrong thing
 * without ever looking broken: a floor no item can reach, a guard that fires on
 * the file's own expectation, a keyword group that cannot tell two items apart,
 * an action item whose missing `dueDate` silently disables the date rule. Every
 * check here corresponds to a rule in GOLDEN_FORMAT.md.
 *
 * Errors exit non-zero; warnings are printed and do not.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import {
  BUCKETS,
  FIXTURES_DIR,
  SCHEMA_VERSION,
  TRANSCRIPT_DIR,
  acceptedOwners,
  matches,
  type Bucket,
  type Golden,
  type Group,
  type Unchecked,
} from "./golden.mts";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Finding {
  level: "error" | "warn";
  message: string;
}

/** Keyword hazards that apply to expectations and guards alike. */
function keywordFindings(group: Partial<Group>, where: string): Finding[] {
  const findings: Finding[] = [];
  // A keyword in two groups of one item collapses the item to a single keyword
  // match: any produced text with that word satisfies both groups.
  const counts = new Map<string, number>();
  for (const alternatives of group.any ?? []) {
    for (const word of new Set(alternatives)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  for (const [word, count] of counts) {
    if (count > 1) {
      findings.push({
        level: "error",
        message: `${where}: "${word}" appears in ${count} groups of the same item`,
      });
    }
  }
  for (const word of (group.any ?? []).flat().concat(group.none ?? [])) {
    // \b does not separate digits inside an ISO date, so "10" matches
    // "2026-10-06" and satisfies its group for free.
    if (/^\d{1,2}$/.test(word)) {
      findings.push({
        level: "error",
        message: `${where}: bare number "${word}" matches any ISO date`,
      });
    }
  }
  return findings;
}

function lintGolden(path: string): Finding[] {
  const findings: Finding[] = [];
  const error = (message: string): number => findings.push({ level: "error", message });
  const warn = (message: string): number => findings.push({ level: "warn", message });
  const keywordChecks = (group: Partial<Group>, where: string): number =>
    findings.push(...keywordFindings(group, where));

  let golden: Unchecked<Golden>;
  try {
    golden = JSON.parse(readFileSync(path, "utf8")) as Unchecked<Golden>;
  } catch (cause) {
    return [{ level: "error", message: `unreadable: ${String(cause)}` }];
  }

  // ── file-level shape ─────────────────────────────────────────────────────
  if (golden.schemaVersion !== SCHEMA_VERSION) {
    error(`schemaVersion ${golden.schemaVersion ?? "missing"}, the scorer reads ${SCHEMA_VERSION}`);
  }
  if (!golden.transcript) error('no "transcript" field — the golden cannot be paired with a run');
  else if (!existsSync(join(TRANSCRIPT_DIR, golden.transcript))) {
    error(`transcript not found: ${golden.transcript}`);
  }
  if (golden.meetingDate === undefined) {
    error('no "meetingDate" — use null when the transcript states no meeting day');
  } else if (golden.meetingDate !== null) {
    if (!ISO_DATE.test(golden.meetingDate)) error(`meetingDate "${golden.meetingDate}" is not ISO`);
    else {
      // A hand-edited weekday typo would shift every weekday check silently.
      const actual = WEEKDAYS[new Date(`${golden.meetingDate}T12:00:00Z`).getUTCDay()];
      if (!golden.meetingWeekday) warn("no meetingWeekday");
      else if (golden.meetingWeekday !== actual) {
        error(`meetingWeekday "${golden.meetingWeekday}" but ${golden.meetingDate} is a ${actual}`);
      }
    }
  }
  for (const key of Object.keys(golden.maxUnmatched ?? {})) {
    if (!BUCKETS.includes(key as Bucket)) error(`maxUnmatched has unknown bucket "${key}"`);
  }

  const buckets: Record<Bucket, Partial<Group>[]> = {
    decisions: golden.decisions ?? [],
    actionItems: golden.actionItems ?? [],
    openQuestions: golden.openQuestions ?? [],
  };
  const floors: Record<Bucket, number | undefined> = {
    decisions: golden.decisionsMin,
    actionItems: golden.actionItemsMin,
    openQuestions: golden.openQuestionsMin,
  };
  const seen = new Map<string, string>();
  for (const [bucket, groups] of [
    ...Object.entries(buckets),
    ["mustNotAppear", golden.mustNotAppear ?? []] as const,
  ] as [string, Partial<Group>[]][]) {
    for (const group of groups) {
      const id = group.id ?? "";
      if (!id) {
        error(`${bucket}: an item has no id`);
        continue;
      }
      const previous = seen.get(id);
      if (previous) error(`duplicate id "${id}" (${previous} and ${bucket})`);
      else seen.set(id, bucket);
    }
  }

  // ── per-bucket ───────────────────────────────────────────────────────────
  for (const bucket of BUCKETS) {
    const groups = buckets[bucket];
    const required = groups.filter((group) => group.optional !== true).length;
    const floor = floors[bucket];
    if (floor === undefined) error(`no ${bucket}Min floor`);
    else if (floor > required) {
      error(`${bucket}Min ${floor} exceeds ${required} non-optional ${bucket}`);
    } else if (floor < required) {
      // Floor slack is anonymous: mark the item you conceded `optional` instead.
      warn(
        `${bucket}Min ${floor} is below the ${required} non-optional ${bucket} — mark the item you are conceding "optional" instead`,
      );
    }

    groups.forEach((group, index) => {
      const where = `${bucket}[${group.id}]`;
      if (!group.gist) error(`${where}: no gist`);
      if (!group.any?.length) error(`${where}: no keyword groups`);
      if (group.alsoAcceptIn === bucket) {
        error(`${where}: alsoAcceptIn "${bucket}" is its own bucket`);
      }
      if (group.bucket) warn(`${where}: "bucket" only applies to mustNotAppear guards`);

      keywordChecks(group, where);

      // B3: one group must carry the item's identity. Without a group whose
      // keywords are unique in the bucket, two items compete for the same
      // produced text and the assignment is arbitrary.
      const others = groups.filter((_, i) => i !== index).flatMap((g) => (g.any ?? []).flat());
      const discriminates = (group.any ?? []).some((alternatives) =>
        alternatives.every((word) => !others.includes(word)),
      );
      if (groups.length > 1 && !discriminates) {
        warn(`${where}: no group is unique in this bucket — nothing carries the item's identity`);
      }

      if (bucket !== "actionItems") return;
      // An expectation with no dueDate leaves any in-window date unchallenged,
      // and one with no owner accepts null and anyone. Say null explicitly.
      if (!group.dueDate) error(`${where}: no dueDate — use [null] to require no date`);
      else if (group.dueDate.filter((d) => d !== null).length > 2) {
        warn(`${where}: ${group.dueDate.length} accepted dates has stopped discriminating`);
      }
      if (acceptedOwners(group.owner) === null) {
        error(`${where}: no owner — use null, or a list with null, to accept an unowned item`);
      }
    });
  }

  // ── guards ───────────────────────────────────────────────────────────────
  // The expensive authoring mistake: a guard that fires on the file's own
  // expectation, failing correct output. The gist is the closest thing to a
  // correct title the golden holds, so test the guard against it.
  for (const guard of golden.mustNotAppear ?? []) {
    keywordChecks(guard, `mustNotAppear[${guard.id}]`);
    const scope: Bucket[] = guard.bucket ? [guard.bucket].flat() : [...BUCKETS];
    for (const bucket of scope) {
      for (const group of buckets[bucket]) {
        if (matches(group.gist ?? "", guard)) {
          error(
            `mustNotAppear[${guard.id}] fires on the gist of ${bucket}[${group.id}] — scope it with "bucket", or add a "none"`,
          );
        }
      }
    }
  }

  return findings;
}

// ── entry point ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const paths =
  argv.length > 0
    ? argv
    : readdirSync(FIXTURES_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => join(FIXTURES_DIR, f));

let errors = 0;
let warnings = 0;
for (const path of paths) {
  const findings = lintGolden(path);
  errors += findings.filter((f) => f.level === "error").length;
  warnings += findings.filter((f) => f.level === "warn").length;
  if (findings.length === 0) continue;
  console.log(`\n──── ${basename(path)}`);
  for (const finding of findings) {
    console.log(`  ${finding.level === "error" ? "❌" : "⚠️ "} ${finding.message}`);
  }
}
console.log(
  `\n════════ ${paths.length} goldens, ${errors} error(s), ${warnings} warning(s) ════════`,
);
process.exit(errors === 0 ? 0 : 1);
