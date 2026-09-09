import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BenchmarkArmStatsSchema,
  BenchmarkReportSchema,
  BenchmarkStatsComparisonSchema,
  type BenchmarkArmStats,
  type BenchmarkPersonResult,
  type BenchmarkReport,
  type BenchmarkStatsComparison,
} from "@chief-of-staff-demo/shared";
import { armCI, mde, mean, pairedDifferences, sampleSD } from "./stats.js";

/**
 * Arm-level statistics read back out of a benchmark output directory: the
 * interval an arm actually measured, the bar a comparison had to clear, and
 * the plain-words verdict on whether a delta is a model difference or noise.
 * The sampling unit is the person, so every interval spans persons — repeats
 * only tighten each person's own estimate (arXiv:2411.00640 §2.4).
 */

/** A repeat report the driver wrote: `<mode>-<pipeline>-<runId>[-rN].json`. */
const REPORT_FILE =
  /^(live-discovery|fixed-documents)-(incumbent|expanded)-\S+?(?:-r([1-9]\d*))?\.json$/;

/** A person's recovery fraction for one repeat; absent when never measured. */
function personScore(person: BenchmarkPersonResult): number | null {
  if (person.completeness.referenceFacts === 0) return null;
  return person.completeness.recovered / person.completeness.referenceFacts;
}

/** One directory entry, kept only when it parses as an arm report. */
function readReport(path: string): { report: BenchmarkReport; repeat: number } | null {
  const match = REPORT_FILE.exec(path.split("/").pop() ?? path);
  if (!match) return null;
  try {
    return {
      report: BenchmarkReportSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
      repeat: match[3] ? Number(match[3]) : 1,
    };
  } catch {
    /* A file matching the report-name pattern that is not a valid report is
       not an arm report either — comparison and stats outputs carry the same
       prefix shape, and a half-written file must not fail the read-back. */
    return null;
  }
}

/**
 * Build the arm's statistics from the reports of ONE arm in the directory:
 * the newest run id present — a retried arm writes a fresh run beside the
 * interrupted one, and the newest finishedAt is the arm that counts.
 * Reports sharing that run id but differing in their `-rN` suffix are its
 * repeats; older arms, comparisons and artifacts are skipped. Null when no
 * arm report has at least two measured people — an interval needs an
 * across-person spread to describe.
 */
export function buildArmStats(directory: string): BenchmarkArmStats | null {
  const found = readdirSync(directory)
    .filter((name) => !name.startsWith("stats"))
    .map((name) => readReport(join(directory, name)))
    .filter((entry): entry is { report: BenchmarkReport; repeat: number } => entry !== null);
  if (found.length === 0) return null;
  const byRun = new Map<string, { report: BenchmarkReport; repeat: number }[]>();
  for (const entry of found) {
    const group = byRun.get(entry.report.runId) ?? [];
    group.push(entry);
    byRun.set(entry.report.runId, group);
  }
  /* A repeat is a pass that covered the whole selection: an interrupted pass
     is a partial sample and stays out. A pass that finished with person-level
     failures still measures those persons (failures score as misses), so it
     counts — but it is surfaced as partial, never silently pooled. */
  const passes = [...byRun.values()]
    .sort((a, b) =>
      b[0]!.report.provenance.finishedAt.localeCompare(a[0]!.report.provenance.finishedAt),
    )[0]!
    .sort((a, b) => a.repeat - b.repeat)
    .filter((entry) => entry.report.execution?.status === "completed");
  if (passes.length === 0) return null;
  const partialRepeats = passes.filter((entry) => entry.report.status !== "completed").length;

  const perSlug = new Map<string, { slug: string; scores: number[] }>();
  for (const { report } of passes)
    for (const person of report.people) {
      const score = personScore(person);
      if (score === null) continue;
      const entry = perSlug.get(person.slug) ?? { slug: person.slug, scores: [] };
      entry.scores.push(score);
      perSlug.set(person.slug, entry);
    }
  const people = [...perSlug.values()].map((entry) => ({
    ...entry,
    mean: mean(entry.scores),
  }));
  const ci = armCI(people.map((person) => person.mean));
  if (!ci) return null;

  /* Denominators are a property of the person, not the repeat; the first
     report carrying a slug donates its reference-fact count. */
  const denominators = new Map<string, number>();
  for (const { report } of passes)
    for (const person of report.people)
      if (!denominators.has(person.slug))
        denominators.set(person.slug, person.completeness.referenceFacts);
  const referenceFacts = [...denominators.values()].reduce((sum, count) => sum + count, 0);
  const recoveredMean = people.reduce(
    (sum, person) => sum + person.mean * (denominators.get(person.slug) ?? 0),
    0,
  );
  const first = passes[0]!.report;
  return BenchmarkArmStatsSchema.parse({
    schemaVersion: 1,
    runIds: passes.map(({ report }) => report.runId),
    mode: first.mode,
    pipeline: first.provenance.pipeline,
    repeats: passes.length,
    partialRepeats,
    people,
    ci,
    totals: {
      referenceFacts,
      recoveredMean,
      /* The pooled rate, beside the unweighted per-person mean in `ci`. */
      rate: referenceFacts > 0 ? recoveredMean / referenceFacts : 0,
    },
  });
}

/** The readable arm statistics. Deliberately plain, like the report itself. */
export function renderArmStats(stats: BenchmarkArmStats): string {
  const lines = [
    `## Arm statistics (${stats.mode}, ${stats.pipeline})`,
    "",
    `${String(stats.repeats)} repeat(s), ${String(stats.people.length)} people.` +
      (stats.partialRepeats > 0
        ? ` Warning: ${String(stats.partialRepeats)} of ${String(stats.repeats)} repeat report(s) recorded person-level failures.`
        : ""),
    `Recovery ${stats.ci.mean.toFixed(4)} (95% CI ${stats.ci.lo.toFixed(4)}–${stats.ci.hi.toFixed(4)}, se ${stats.ci.se.toFixed(4)}).`,
    `Pooled rate ${stats.totals.rate.toFixed(4)} (${String(Math.round(stats.totals.recoveredMean))} of ${String(stats.totals.referenceFacts)} facts).`,
    `A future arm must differ by about ${detectableEffectBar(stats)} to be detectable at n=${String(stats.people.length)} (80% power, 5% significance).`,
    "",
    "| person | repeats | mean |",
    "| --- | --- | --- |",
  ];
  for (const person of stats.people)
    lines.push(
      `| ${person.slug} | ${person.scores.map((score) => score.toFixed(2)).join(", ")} | ${person.mean.toFixed(3)} |`,
    );
  return lines.join("\n");
}

function detectableEffectBar(stats: BenchmarkArmStats): string {
  const sd = sampleSD(stats.people.map((person) => person.mean));
  const bar = mde(sd, stats.people.length);
  return bar === null ? "an unmeasurable amount (n < 2)" : `±${bar.toFixed(3)}`;
}

/**
 * Two arms compared on their paired per-person differences over the people
 * they share. |z| < 2 is the noise line (arXiv:2411.00640 §2.2): a delta
 * inside it is a coin flip, whatever its sign.
 */
export function compareArmStats(
  baseline: BenchmarkArmStats,
  candidate: BenchmarkArmStats,
): BenchmarkStatsComparison {
  const candidateMeans = new Map(candidate.people.map((person) => [person.slug, person.mean]));
  const shared = baseline.people.filter((person) => candidateMeans.has(person.slug));
  /* Δ = candidate − baseline: positive means the candidate recovered more. */
  const paired = pairedDifferences(
    shared.map((person) => candidateMeans.get(person.slug)!),
    shared.map((person) => person.mean),
  );
  if (!paired) throw new Error("Arm comparison needs at least two shared people.");
  const z = paired.se === 0 ? (paired.mean === 0 ? 0 : null) : paired.mean / paired.se;
  const bar = mde(paired.sd, paired.diffs.length);
  const verdict: BenchmarkStatsComparison["verdict"] =
    z === null
      ? paired.se === 0 && paired.mean !== 0
        ? "distinguishable"
        : "noise"
      : Math.abs(z) >= 2
        ? "distinguishable"
        : "noise";
  const detail =
    verdict === "noise"
      ? `Δ=${paired.mean.toFixed(4)} is not distinguishable from noise (|z|=${z === null ? "0" : Math.abs(z).toFixed(2)} < 2; the design detects only ≳${bar?.toFixed(3) ?? "?"}). Treat the arms as tied or change the design — more people, more repeats, or paired repeats.`
      : `Δ=${paired.mean.toFixed(4)} (|z|=${z === null ? "deterministic separation" : Math.abs(z).toFixed(2)}).`;
  return BenchmarkStatsComparisonSchema.parse({
    schemaVersion: 1,
    baseline: { runIds: baseline.runIds, ci: baseline.ci },
    candidate: { runIds: candidate.runIds, ci: candidate.ci },
    sharedPeople: shared.length,
    paired: {
      mean: paired.mean,
      sd: paired.sd,
      se: paired.se,
      z,
      corr: paired.corr,
    },
    mde: bar,
    verdict,
    verdictDetail: detail,
  });
}

/** The readable comparison, ending in the plain-words verdict. */
export function renderStatsComparison(comparison: BenchmarkStatsComparison): string {
  const z = comparison.paired.z;
  const lines = [
    "## Arm comparison (paired per-person differences)",
    "",
    `Baseline recovery ${comparison.baseline.ci.mean.toFixed(4)} (95% CI ${comparison.baseline.ci.lo.toFixed(4)}–${comparison.baseline.ci.hi.toFixed(4)}).`,
    `Candidate recovery ${comparison.candidate.ci.mean.toFixed(4)} (95% CI ${comparison.candidate.ci.lo.toFixed(4)}–${comparison.candidate.ci.hi.toFixed(4)}).`,
    `Paired over ${String(comparison.sharedPeople)} shared people: mean Δ ${comparison.paired.mean.toFixed(4)}, se ${comparison.paired.se.toFixed(4)}, |z| ${z === null ? "n/a" : Math.abs(z).toFixed(2)}, corr ${comparison.paired.corr === null ? "n/a" : comparison.paired.corr.toFixed(2)}.`,
    `Detectable bar for this pairing: ${comparison.mde === null ? "unmeasurable" : `±${comparison.mde.toFixed(3)}`}.`,
    "",
    comparison.verdictDetail,
  ];
  return lines.join("\n");
}
