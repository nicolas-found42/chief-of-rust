/**
 * Score debrief eval runs against hand-written golden expectations.
 *
 * usage:
 *   tsx scripts/score-debrief-eval.mts <golden.json> <run.debrief.json> [...]
 *   tsx scripts/score-debrief-eval.mts --all [<runDir>]
 *
 * `--all` scores every golden in tests/fixtures/debrief-golden/ against
 * <runDir>/<transcript>.debrief.json (default runDir: /tmp/debrief-gate/solar)
 * in filename order and prints a pass/fail summary. The runner's
 * <transcript>.error.json (every attempt failed) fails the golden with the
 * recorded error, and takes precedence over a .debrief.json sitting beside it:
 * a run removes the file its outcome did not write, so a debrief next to an
 * error is a leftover from an earlier run. It spends no API budget;
 * produce runs with scripts/run-debrief-eval.mts. Either form accepts `--json`,
 * which prints one machine-readable report per run instead of the human log.
 *
 * Matching is by intent, not wording: a golden item lists `any` keyword groups
 * and matches a produced item when every group has one keyword present, on a
 * word boundary ("fee" does not hide in "coffee"; `*` stands for a run of word
 * characters, so "availab*" matches "availability"). Word boundaries do not
 * separate digits from an ISO date, so a bare "10" still hides in "2026-10-06"
 * — never write a bare one- or two-digit number as a keyword. One produced item
 * satisfies at most one golden item, in one bucket, so a vague title cannot
 * cover two expectations, and the per-item date and owner rules run against
 * that one assigned item. Which item that is is not left to the draw: where
 * two expectations match the same titles and differ only by owner, the
 * assignment is repaired toward the owners the golden names, never changing
 * how much the run covers.
 *
 * Hard rules are absolute — a wrong date, a wrong owner, a must-not-appear item,
 * more unexplained produced items than the bucket's ceiling, a decision that
 * restates an action item, or any suggested recipient fails regardless of
 * coverage. Two signals are reported but never fail a run: produced items whose
 * names and numbers are absent from the transcript (`ungrounded`), and
 * expectations that more than one produced item matches (`ambiguous`).
 *
 * The golden file format is tests/fixtures/debrief-golden/GOLDEN_FORMAT.md.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  BUCKETS,
  FIXTURES_DIR,
  SCHEMA_VERSION,
  TRANSCRIPT_DIR,
  acceptedOwners,
  byBucket,
  expectationsOf,
  floorsOf,
  matches,
  nameTokens,
  type Bucket,
  type Golden,
  type Group,
} from "./golden.mts";

const DEFAULT_RUN_DIR = "/tmp/debrief-gate/solar";
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const BUCKET_LABEL: Record<Bucket, string> = {
  decisions: "decisions   ",
  actionItems: "action items",
  openQuestions: "questions   ",
};

interface ProducedAction {
  title?: string;
  owner?: string | null;
  dueDate?: string | null;
}
interface RunFile {
  model?: string;
  valid?: boolean;
  raw?: {
    decisions?: { statement?: string }[];
    actionItems?: ProducedAction[];
    openQuestions?: { question?: string }[];
    suggestedRecipients?: { name?: string; email?: string | null }[];
  } | null;
}
/** What run-debrief-eval-all.mts records when every attempt for a run failed. */
interface ErrorFile {
  model?: string;
  attempts?: number;
  error?: string;
}

/** Where a golden item found its evidence: a bucket and an index into it. */
type Match = { bucket: Bucket; index: number } | null;

interface Report {
  golden: string;
  run: string;
  model: string | null;
  found: Record<Bucket, number>;
  expected: Record<Bucket, number>;
  requiredFound: Record<Bucket, number>;
  required: Record<Bucket, number>;
  matched: Record<Bucket, { id: string; by: string; bucket: Bucket }[]>;
  missing: Record<Bucket, { id: string; gist: string; optional: boolean }[]>;
  unmatched: Record<Bucket, string[]>;
  /** Soft: expectations more than one produced item matches — usually a loose golden. */
  ambiguous: { id: string; count: number }[];
  /** Soft: names and numbers in produced items that the transcript never says. */
  ungrounded: string[];
  failures: string[];
}

// ── matching ───────────────────────────────────────────────────────────────

/**
 * Maximum one-to-one coverage: each produced item is consumed by at most one
 * golden item, so a vague title cannot satisfy two expectations. `taken` is
 * shared across buckets so an `alsoAcceptIn` fallback cannot re-claim a
 * produced item its own bucket already used. Returns the produced index
 * assigned to each golden item, or null where none was found.
 */
function assign(groups: Group[], produced: string[], taken: Set<number>): (number | null)[] {
  const holder = new Map<number, number>(); // produced index -> group index
  const augment = (groupIndex: number, seen: Set<number>): boolean => {
    const group = groups[groupIndex];
    if (!group) return false;
    for (let pi = 0; pi < produced.length; pi++) {
      const text = produced[pi];
      if (text === undefined || taken.has(pi) || seen.has(pi) || !matches(text, group)) continue;
      seen.add(pi);
      const previous = holder.get(pi);
      if (previous === undefined || augment(previous, seen)) {
        holder.set(pi, groupIndex);
        return true;
      }
    }
    return false;
  };
  for (let gi = 0; gi < groups.length; gi++) augment(gi, new Set<number>());
  const assigned = new Array<number | null>(groups.length).fill(null);
  for (const [pi, gi] of holder) assigned[gi] = pi;
  return assigned;
}

// ── rule helpers ───────────────────────────────────────────────────────────

/** The meeting day plus the next seven, matching the prompt's date reference. */
function defaultWindow(meetingDate: string): [string, string] | null {
  const start = Date.parse(`${meetingDate}T12:00:00Z`);
  if (!ISO_DATE.test(meetingDate) || Number.isNaN(start)) return null;
  return [meetingDate, new Date(start + 7 * DAY_MS).toISOString().slice(0, 10)];
}

/**
 * Fuzzy but bounded: a name token of an accepted owner appears in the produced
 * owner as a whole word, so "Rich" no longer matches "Richard" and "Ria" no
 * longer matches "Maria". Nicknames the transcript actually uses belong in the
 * golden's owner list — the scorer cannot guess that "Nick" is "Nicolas".
 */
function ownerMatches(accepted: (string | null)[], actual: string | null | undefined): boolean {
  if (!actual) return accepted.includes(null);
  const low = actual.toLowerCase();
  return accepted.some(
    (name) =>
      name !== null && nameTokens(name).some((token) => new RegExp(`\\b${token}\\b`).test(low)),
  );
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const quote = (text: string): string => (text.length > 72 ? `${text.slice(0, 71)}…` : text);

/**
 * Confabulation signal: a capitalised word or a number in a produced item that
 * the transcript never says. Never fails a run — models paraphrase, and a
 * legitimate word can be capitalised — but a run inventing names, amounts or
 * dates lights this up. The first word of an item is skipped: titles start with
 * a capitalised verb.
 */
function ungroundedTokens(texts: string[], transcript: string): string[] {
  const low = transcript.toLowerCase();
  const strays = new Set<string>();
  for (const text of texts) {
    const words = text.split(/\s+/);
    words.forEach((word, i) => {
      const bare = word.replace(/^[^\w$]+|[^\w%]+$/g, "");
      if (!bare) return;
      const isName = i > 0 && /^[A-Z][a-zA-Z]{2,}$/.test(bare);
      const isNumber = /^\$?\d[\d,.:/-]*%?$/.test(bare);
      if (!isName && !isNumber) return;
      if (!low.includes(bare.toLowerCase())) strays.add(bare);
    });
  }
  return [...strays].sort();
}

// ── scoring ────────────────────────────────────────────────────────────────

function emptyReport(goldenPath: string, runPath: string): Report {
  return {
    golden: basename(goldenPath),
    run: basename(runPath),
    model: null,
    found: byBucket(() => 0),
    expected: byBucket(() => 0),
    requiredFound: byBucket(() => 0),
    required: byBucket(() => 0),
    matched: byBucket<Report["matched"][Bucket]>(() => []),
    missing: byBucket<Report["missing"][Bucket]>(() => []),
    unmatched: byBucket<string[]>(() => []),
    ambiguous: [],
    ungrounded: [],
    failures: [],
  };
}

function scoreRun(goldenPath: string, golden: Golden, runPath: string): Report {
  const run = JSON.parse(readFileSync(runPath, "utf8")) as RunFile;
  const report = emptyReport(goldenPath, runPath);
  report.model = run.model ?? null;
  const raw = run.raw ?? null;
  if (!raw) {
    report.failures.push("run file has no raw model output");
    return report;
  }
  if (run.valid === false) {
    report.failures.push('run failed schema validation ("valid": false)');
    return report;
  }

  const actions = raw.actionItems ?? [];
  const produced: Record<Bucket, string[]> = {
    decisions: (raw.decisions ?? []).map((d) => d.statement ?? ""),
    actionItems: actions.map((a) => a.title ?? ""),
    openQuestions: (raw.openQuestions ?? []).map((q) => q.question ?? ""),
  };
  const expected = expectationsOf(golden);
  const floors = floorsOf(golden);

  // Pass one: assign within each bucket. Pass two: let still-unmatched
  // `alsoAcceptIn` items claim a produced item no bucket has consumed yet, so
  // one produced item is never credited twice.
  const consumed = byBucket(() => new Set<number>());
  const found = byBucket<Match[]>(() => []);
  for (const bucket of BUCKETS) {
    const own = assign(expected[bucket], produced[bucket], consumed[bucket]);
    found[bucket] = own.map((index) => {
      if (index === null) return null;
      consumed[bucket].add(index);
      return { bucket, index };
    });
  }
  for (const bucket of BUCKETS) {
    expected[bucket].forEach((group, i) => {
      if (found[bucket][i] || !group.alsoAcceptIn) return;
      const other = group.alsoAcceptIn;
      if (other === bucket) return;
      const j = produced[other].findIndex(
        (text, index) => !consumed[other].has(index) && matches(text, group),
      );
      if (j >= 0) {
        consumed[other].add(j);
        found[bucket][i] = { bucket: other, index: j };
      }
    });
  }

  // An action item's owner is half its identity, and `assign` above sees only
  // keywords: where two expectations share their keyword groups and differ by
  // owner — eval:lint calls these out, "no group is unique in this bucket" —
  // which produced item each one gets is arbitrary, and a run that named both
  // owners correctly can still be scored on the wrong pairing. Repair the
  // assignment toward the named owners using moves that cover exactly as much:
  // re-home onto a produced item no bucket claimed, or swap two assignments
  // both expectations still match.
  const roster = new Set(
    golden.actionItems.flatMap((group) =>
      (acceptedOwners(group.owner) ?? []).flatMap((name) => (name ? nameTokens(name) : [])),
    ),
  );
  const ownerFits = (group: Group | undefined, index: number | null): boolean => {
    const accepted = group ? acceptedOwners(group.owner) : null;
    const action = index === null ? undefined : actions[index];
    if (!accepted || !action) return true;
    if (!ownerMatches(accepted, action.owner)) return false;
    const mine = new Set(accepted.flatMap((name) => (name ? nameTokens(name) : [])));
    const low = (action.owner ?? "").toLowerCase();
    return ![...roster].some((token) => !mine.has(token) && new RegExp(`\\b${token}\\b`).test(low));
  };
  {
    const own = golden.actionItems.map((_, i) => {
      const match = found.actionItems[i];
      return match && match.bucket === "actionItems" ? match.index : null;
    });
    const canTake = (i: number, index: number): boolean =>
      matches(produced.actionItems[index] ?? "", golden.actionItems[i]!);
    for (let pass = 0; pass <= golden.actionItems.length; pass++) {
      let improved = false;
      for (let i = 0; i < own.length && !improved; i++) {
        const here = own[i] ?? null;
        if (here === null || ownerFits(golden.actionItems[i], here)) continue;
        const free = produced.actionItems.findIndex(
          (_, pi) =>
            !consumed.actionItems.has(pi) && canTake(i, pi) && ownerFits(golden.actionItems[i], pi),
        );
        if (free === -1) continue;
        consumed.actionItems.delete(here);
        consumed.actionItems.add(free);
        own[i] = free;
        improved = true;
      }
      for (let i = 0; i < own.length && !improved; i++) {
        for (let j = i + 1; j < own.length; j++) {
          const mine = own[i] ?? null;
          const theirs = own[j] ?? null;
          if (mine === null || theirs === null) continue;
          if (!canTake(i, theirs) || !canTake(j, mine)) continue;
          const before =
            Number(ownerFits(golden.actionItems[i], mine)) +
            Number(ownerFits(golden.actionItems[j], theirs));
          const after =
            Number(ownerFits(golden.actionItems[i], theirs)) +
            Number(ownerFits(golden.actionItems[j], mine));
          if (after <= before) continue;
          own[i] = theirs;
          own[j] = mine;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    own.forEach((index, i) => {
      if (index !== null) found.actionItems[i] = { bucket: "actionItems", index };
    });
  }

  const failures = report.failures;

  for (const bucket of BUCKETS) {
    report.expected[bucket] = expected[bucket].length;
    report.unmatched[bucket] = produced[bucket].filter((_, i) => !consumed[bucket].has(i));
    expected[bucket].forEach((group, i) => {
      const match = found[bucket][i] ?? null;
      if (match) {
        report.found[bucket] += 1;
        report.matched[bucket].push({
          id: group.id,
          bucket: match.bucket,
          by: produced[match.bucket][match.index] ?? "",
        });
        // Soft: a second produced item matching the same expectation means the
        // keyword groups do not discriminate, and the loser escapes the
        // per-item date and owner rules.
        const rivals = produced[match.bucket].filter(
          (text, j) => j !== match.index && matches(text, group),
        ).length;
        if (rivals > 0) report.ambiguous.push({ id: group.id, count: rivals + 1 });
      } else {
        report.missing[bucket].push({
          id: group.id,
          gist: group.gist,
          optional: group.optional === true,
        });
      }
    });
    // Floor: coverage of the items a careful reader could not miss. Optional
    // items are reported but never counted, and padding the bucket with junk
    // no longer helps — only matched expectations count.
    report.required[bucket] = expected[bucket].filter((group) => group.optional !== true).length;
    report.requiredFound[bucket] = expected[bucket].filter(
      (group, i) => group.optional !== true && found[bucket][i],
    ).length;
    if (report.requiredFound[bucket] < floors[bucket]) {
      failures.push(
        `only ${report.requiredFound[bucket]} of ${report.required[bucket]} expected ${bucket} found, floor is ${floors[bucket]}`,
      );
    }
    // Hard rule: over-extraction. Produced items no expectation explains are
    // capped, so a run cannot bury the golden under invented volume.
    const cap = golden.maxUnmatched?.[bucket] ?? expected[bucket].length;
    if (report.unmatched[bucket].length > cap) {
      failures.push(
        `${report.unmatched[bucket].length} unmatched ${bucket} exceeds ceiling ${cap}`,
      );
    }
  }

  // Hard rule: due dates are ISO and inside the supplied window. A golden with
  // no meeting date has no window, and then any date at all is invented.
  const window =
    golden.dueDateWindow === null
      ? null
      : (golden.dueDateWindow ?? (golden.meetingDate ? defaultWindow(golden.meetingDate) : null));
  const malformed = new Set<number>();
  actions.forEach((action, i) => {
    const due = action.dueDate;
    if (!due) return;
    if (!ISO_DATE.test(due) || Number.isNaN(Date.parse(`${due}T12:00:00Z`))) {
      malformed.add(i);
      failures.push(`dueDate "${due}" is not a YYYY-MM-DD date — "${action.title}"`);
      return;
    }
    if (!window) {
      failures.push(`dueDate ${due} but the transcript states no meeting day — "${action.title}"`);
      return;
    }
    if (due < window[0] || due > window[1]) {
      failures.push(`dueDate ${due} outside ${window[0]}..${window[1]} — "${action.title}"`);
    }
  });

  // Hard rule: a date the title cues with a weekday ("send it by Monday") must
  // land on a weekday the title names. Only "by", "before" and "due" cue a
  // deadline; "on Thursday's stand-up" and "until Friday" are context, and a
  // golden item can opt out entirely with "weekdayRule": false.
  const groupOfAction = new Map<number, Group>();
  golden.actionItems.forEach((group, i) => {
    const match = found.actionItems[i];
    if (match && match.bucket === "actionItems") groupOfAction.set(match.index, group);
  });
  actions.forEach((action, i) => {
    const due = action.dueDate;
    if (!due || malformed.has(i)) return;
    if (groupOfAction.get(i)?.weekdayRule === false) return;
    const title = (action.title ?? "").toLowerCase();
    const deadline = (day: string): RegExp =>
      new RegExp(`\\b(?:by|before|due)\\s+(?:the\\s+|end\\s+of\\s+|eod\\s+)?${day}\\b(?!')`);
    if (!WEEKDAYS.some((day) => deadline(day).test(title))) return;
    const named = WEEKDAYS.filter((day) => new RegExp(`\\b${day}\\b(?!')`).test(title));
    const actual = WEEKDAYS[new Date(`${due}T12:00:00Z`).getUTCDay()];
    if (actual && !named.includes(actual)) {
      failures.push(
        `dueDate ${due} is ${actual}, title says ${named.join("/")} — "${action.title}"`,
      );
    }
  });

  // Hard rules on the one produced item each expectation was assigned: its date
  // must be one a careful reader would accept, and its owner must be the person
  // the transcript put on the hook — and nobody else.
  golden.actionItems.forEach((group, i) => {
    const match = found.actionItems[i] ?? null;
    if (!match || match.bucket !== "actionItems") return;
    const action = actions[match.index];
    if (!action) return;
    if (group.dueDate && !group.dueDate.includes(action.dueDate ?? null)) {
      const accepted = group.dueDate.map((d) => d ?? "null").join(" | ");
      failures.push(
        `${group.id}: dueDate ${action.dueDate ?? "null"} not in [${accepted}] — "${action.title}"`,
      );
    }
    const accepted = acceptedOwners(group.owner);
    if (!accepted) return;
    if (!ownerMatches(accepted, action.owner)) {
      const wanted = accepted.map((name) => name ?? "null").join(" | ");
      failures.push(
        `${group.id}: owner ${action.owner ? `"${action.owner}"` : "null"} is not ${wanted} — "${action.title}"`,
      );
      return;
    }
    // Hedging the owner ("Richard and Abhinav") is misattribution too: the
    // right name is there, but so is someone else the golden did not accept.
    const mine = new Set(accepted.flatMap((name) => (name ? nameTokens(name) : [])));
    const low = (action.owner ?? "").toLowerCase();
    const stray = [...roster].find(
      (token) => !mine.has(token) && new RegExp(`\\b${token}\\b`).test(low),
    );
    if (stray) {
      failures.push(`${group.id}: owner "${action.owner}" also names ${stray} — "${action.title}"`);
    }
  });

  // Hard rule: nothing on the must-not list, on the surfaces it guards. A guard
  // scoped to one bucket can forbid a fact as a decision while the same fact is
  // a legitimate open question.
  for (const group of golden.mustNotAppear) {
    const scope = group.bucket ? [group.bucket].flat() : BUCKETS;
    for (const bucket of scope) {
      const hit = produced[bucket].find((text) => matches(text, group));
      if (hit) {
        failures.push(
          `must not appear (${group.id}) in ${bucket}: "${quote(hit)}" — ${group.gist}`,
        );
        break;
      }
    }
  }

  // Hard rule: a decision is a decision, not an action item said twice.
  // Containment, not equality: "We decided to hold off on YouTube ads" restates
  // the action item "Hold off on YouTube ads" as surely as a verbatim copy.
  for (const statement of produced.decisions) {
    const decision = normalize(statement);
    const echo = produced.actionItems.find((title) => {
      const action = normalize(title);
      const shorter = decision.length <= action.length ? decision : action;
      if (shorter.split(" ").length < 5) return false;
      return decision.includes(action) || action.includes(decision);
    });
    if (echo !== undefined) {
      failures.push(`decision restates the action item "${quote(echo)}": "${quote(statement)}"`);
    }
  }

  // Hard rule: no invented recipients. No transcript in the corpus asks for the
  // summary to be sent to anyone, so any recipient at all is a confabulation.
  for (const recipient of raw.suggestedRecipients ?? []) {
    failures.push(
      `suggestedRecipient "${recipient.name}" <${recipient.email ?? "null"}> — expected none`,
    );
  }

  // Soft: what the run says that the transcript never does.
  if (golden.transcript) {
    const transcriptPath = join(TRANSCRIPT_DIR, golden.transcript);
    if (existsSync(transcriptPath)) {
      report.ungrounded = ungroundedTokens(
        BUCKETS.flatMap((bucket) => produced[bucket]).concat(actions.map((a) => a.owner ?? "")),
        readFileSync(transcriptPath, "utf8"),
      );
    }
  }

  return report;
}

function printReport(report: Report): void {
  console.log(`\n══ ${report.model ?? "?"}  ${report.run.slice(0, 44)}`);
  for (const bucket of BUCKETS) {
    const extra = report.unmatched[bucket].length;
    console.log(
      `  ${BUCKET_LABEL[bucket]}: ${report.found[bucket]}/${report.expected[bucket]} expected found` +
        ` (${report.requiredFound[bucket]}/${report.required[bucket]} required), ${extra} produced unmatched`,
    );
    for (const hit of report.matched[bucket]) {
      const where = hit.bucket === bucket ? "" : ` (as ${hit.bucket})`;
      console.log(`      ✓ ${hit.id}${where} ← "${quote(hit.by)}"`);
    }
    for (const miss of report.missing[bucket]) {
      const tag = miss.optional ? "MISSING (optional)" : "MISSING";
      console.log(`      ${tag}  ${miss.id} — ${miss.gist}`);
    }
  }
  if (report.ambiguous.length > 0) {
    const list = report.ambiguous.map((a) => `${a.id}×${a.count}`).join(", ");
    console.log(`  ~ ambiguous (more than one produced item matches): ${list}`);
  }
  if (report.ungrounded.length > 0) {
    console.log(`  ~ not in transcript: ${report.ungrounded.join(", ")}`);
  }
  if (report.failures.length === 0) console.log("  ✅ no hard-rule failures");
  else {
    console.log(`  ❌ ${report.failures.length} hard-rule failure(s)`);
    for (const failure of report.failures) console.log(`      ${failure}`);
  }
}

/** Refuse a golden written for another format: the keyword rules changed. */
function loadGolden(path: string): Golden {
  const golden = JSON.parse(readFileSync(path, "utf8")) as Golden;
  if (golden.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${basename(path)}: schemaVersion ${golden.schemaVersion ?? "missing"}, this scorer reads ${SCHEMA_VERSION}`,
    );
  }
  return golden;
}

// ── entry point ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const [first, second, ...rest] = argv.filter((arg) => arg !== "--json");
const reports: Report[] = [];

if (first === "--all") {
  const runDir = second ?? DEFAULT_RUN_DIR;
  const goldenFiles = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const failed: string[] = [];
  for (const file of goldenFiles) {
    const goldenPath = join(FIXTURES_DIR, file);
    // One unreadable golden must not cost the other nineteen their results.
    const skip = (message: string, runPath = "—"): Report => {
      const report = emptyReport(goldenPath, runPath);
      report.failures.push(message);
      reports.push(report);
      if (!asJson) console.log(`  ❌ ${message}`);
      failed.push(file);
      return report;
    };
    try {
      const golden = loadGolden(goldenPath);
      if (!asJson) console.log(`\n──── ${file}  (${golden.meetingDate ?? "no meeting date"})`);
      if (!golden.transcript) {
        skip('golden has no "transcript" field — cannot pair with a run');
        continue;
      }
      const runPath = join(runDir, `${golden.transcript}.debrief.json`);
      const errPath = join(runDir, `${golden.transcript}.error.json`);
      /* The error file wins over a debrief file beside it. Each run removes the
         file its outcome did not write, so the pair can only mean the debrief
         is an earlier run's output — scoring it would report results the last
         run never produced. */
      if (existsSync(errPath)) {
        const err = JSON.parse(readFileSync(errPath, "utf8")) as ErrorFile;
        const report = skip(
          `run errored after ${err.attempts ?? "?"} attempt(s): ${err.error ?? "unknown error"}`,
          errPath,
        );
        report.model = err.model ?? null;
        continue;
      }
      if (!existsSync(runPath)) {
        skip(`no run file: ${runPath}`, runPath);
        continue;
      }
      const report = scoreRun(goldenPath, golden, runPath);
      reports.push(report);
      if (!asJson) printReport(report);
      if (report.failures.length > 0) failed.push(file);
    } catch (error) {
      if (!asJson) console.log(`\n──── ${file}`);
      skip(error instanceof Error ? error.message : String(error));
    }
  }
  if (asJson) console.log(JSON.stringify(reports, null, 2));
  else {
    console.log(
      `\n════════ ${goldenFiles.length - failed.length}/${goldenFiles.length} goldens pass ════════`,
    );
    for (const file of failed) console.log(`  FAIL  ${file}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

const runPaths = [second, ...rest].filter((p): p is string => Boolean(p));
if (!first || runPaths.length === 0) {
  console.error(
    "usage: tsx scripts/score-debrief-eval.mts [--json] <golden.json> <run.json>... | --all [<runDir>]",
  );
  process.exit(1);
}
const golden = loadGolden(first);
let worstFailures = 0;
for (const runPath of runPaths) {
  const report = scoreRun(first, golden, runPath);
  reports.push(report);
  if (!asJson) printReport(report);
  worstFailures = Math.max(worstFailures, report.failures.length);
}
if (asJson) console.log(JSON.stringify(reports, null, 2));
process.exit(worstFailures === 0 ? 0 : 1);
