import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BenchmarkArmStatsSchema,
  BenchmarkReportSchema,
  BenchmarkPersonArtifactSchema,
  type BenchmarkPersonResult,
  type BenchmarkReport,
  type BenchmarkCollectionResult,
  type PersonResearchOperationOutcome,
} from "../packages/shared/src/index.js";
import { ConfigStore } from "../apps/server/src/config.js";
import {
  DEFAULT_REASONING_EFFORT,
  makeCompleteJson,
  MAX_RESTING_ROUTES,
  observeModelUsage,
  ROUTE_COOLDOWN_MS,
  ROUTE_REST_POLICY,
  type CompletionRequest,
} from "../apps/server/src/llm/providers.js";
import { probeSourceEligibility } from "../apps/server/src/source-adapters/eligibility.js";
import { readPersonSource } from "../apps/server/src/person-profile/research-readers.js";
import { playwrightBrowserRenderer } from "../apps/server/src/source-adapters/browser.js";
import { loadCorpus, requirementCoverage } from "../apps/server/src/person-benchmark/corpus.js";
import {
  evaluatePerson,
  evaluateLivePopulation,
  runId,
  type EvaluationPorts,
  type PersonEvaluation,
} from "../apps/server/src/person-benchmark/evaluate.js";
import { evaluateCollection } from "../apps/server/src/person-benchmark/collection.js";
import { composePersonProfiles } from "../apps/server/src/person-profile/composition.js";
import { EXTRACTION_PREFERRED_MIN_THROUGHPUT } from "../apps/server/src/person-profile/research.js";
import {
  JUDGE_REASONING_EFFORT,
  JUDGE_VERSION,
} from "../apps/server/src/person-benchmark/judge.js";
import { retainEvidence } from "../apps/server/src/person-benchmark/evidence.js";
import {
  buildArmStats,
  compareArmStats,
  renderArmStats,
  renderStatsComparison,
} from "../apps/server/src/person-benchmark/arm-stats.js";
import { cachedCompleteJson } from "../apps/server/src/person-benchmark/judge-cache.js";
import { loadReusable, type ResumeConditions } from "../apps/server/src/person-benchmark/resume.js";
import { reassessReport } from "../apps/server/src/person-benchmark/reassess.js";
import { configurePipeline } from "../apps/server/src/person-benchmark/pipelines.js";
import {
  compareReports,
  coverageGapTotals,
  leadDispositionTotals,
  remainingMisses,
  renderComparison,
  renderReport,
  summarizeGroups,
} from "../apps/server/src/person-benchmark/report.js";

/**
 * The Person Research Benchmark CLI (issue #228).
 *
 * Developer tooling over the production research capability: it composes the
 * real Person Profiles product in a throwaway Workspace, asks it to research
 * each Benchmark Person, and reports what came back. It never reads or writes
 * the live Workspace, never sends anything externally, and never creates a
 * Task.
 *
 * A failed or interrupted run is written as a failed run. Previously
 * successful output is never left standing in its place — the same rule the
 * Debrief evaluation CLI already follows.
 */

const HELP = `Person Research Benchmark

  pnpm exec tsx scripts/person-research-benchmark.mts [options]

Options
  --mode <live-discovery|fixed-documents>  Evaluation mode (default: fixed-documents).
  --pipeline <incumbent|expanded>          Which pipeline to run (default: expanded).
  --people <slug,slug>                     Evaluate a subset. Default: the whole collection.
  --limit <n>                              Evaluate only the first n selected people.
  --corpus <dir>                           Corpus directory (default: benchmark/person-research/people).
  --config <path>                          Workspace config for provider credentials
                                           (default: workspace/config.json). Never printed.
  --out <dir>                              Report directory (default: artifacts/person-benchmark).
  --profile-calls <n>                      Model-call bound per operation.
  --profile-ms <n>                         Wall-clock bound per operation.
  --read-concurrency <n>                   Sources read at once.
  --concurrency <1-4>                      People researched concurrently (default: 1).
  --retain-evidence                       Preserve a public evidence snapshot under --out for reassessment.
  --render                                 Allow the bounded anonymous browser route (live mode).
  --compare <baseline.json> <candidate.json>  Compare two saved reports and exit.
  --repeats <n>                            Fixed-documents only: run the whole selection n times
                                           and write per-person interval statistics (stats.json/md).
  --retry <dir>                            Resume an interrupted arm: carry every eligible person
                                           from dir's artifacts, re-run the rest, write a fresh report.
  --reuse-extraction <dir>                 Carry eligible people from dir without retry semantics.
  --seed <n>                               Best-effort sampling seed (OpenAI family), recorded.
  --max-cost <dollars>                     Abort once the provider-reported cost passes this.
  --no-cache                               Bypass the judge-response cache.
  --stats <dir>                            Rebuild stats.json/md from the reports in dir and exit.
  --compare-stats <a.json> <b.json>        Compare two stats files on paired per-person diffs and exit.
  --reassess <report.json>                  Reassess retained evidence without researching again.
  --evidence-workspace <dir>                Isolated public snapshot with snapshot-manifest.json.
  --timeline-minutes <list>                With --reassess, assess publication snapshots (e.g. 1,2,3,5,15).
  --reassess-only-failed                   Freeze completed assessments; retry failed assessments only.
  --lineage-root <dir>                     Bounded report directory for first reassessment ancestry.
  --probe-sources                          Probe every source route's anonymous access and exit.
  --corpus-coverage                        Print the corpus's requirement coverage and exit.
  --help                                   This text.

Live mode contacts real public sources and the configured model provider. Fixed-document
mode contacts the model provider only. Neither mode touches a live Workspace.
Comparison requires complete explicit assessment of the same nonempty selected population,
not successful research. Failed research statuses remain failed and operational outcomes are
reported separately. Incomplete, legacy-unassessed, or regressed comparisons exit nonzero.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
  return value;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/* Machine-read benchmark artifacts persist minified: one JSON document per line keeps a
   30-person run's committed diff compact for review tooling, while the .md report stays
   the human-readable record. (#237) */
function persistPersonArtifact(value: unknown, stem: string, out: string): void {
  const artifact = BenchmarkPersonArtifactSchema.parse(value);
  mkdirSync(out, { recursive: true });
  const person = artifact.result;
  const path = join(out, `${stem}-${person.slug}.person.json`);
  writeFileSync(path, `${JSON.stringify(artifact)}\n`, { flag: "wx" });
  const phases = person.assessment?.phases;
  const phaseDetail = phases
    ? `reference ${phases.reference.status}, support/usefulness ${phases.support.status}`
    : "phase details unavailable";
  process.stderr.write(
    `    ${person.slug}: research ${person.operational.conclusion} · judge ${person.assessment?.judge ?? "unassessed"} (${phaseDetail}) · credited recovery ${String(person.completeness.recovered)}/${String(person.completeness.referenceFacts)} · ${path}\n`,
  );
}

function positiveInteger(name: string, fallback: number): number {
  const value = arg(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

if (flag("help")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

if (flag("probe-sources")) {
  const results = await probeSourceEligibility();
  for (const result of results)
    process.stdout.write(
      `${result.route.padEnd(24)} ${result.status.padEnd(14)} ${String(result.httpStatus ?? "-").padEnd(5)} ${result.detail}\n`,
    );
  const failed = results.filter(
    (result) => result.status === "in-production" && (result.httpStatus !== 200 || !result.shapeOk),
  );
  process.stdout.write(
    `\n${String(results.length - failed.length)}/${String(results.length)} routes answered as documented.\n`,
  );
  process.exit(failed.length ? 1 : 0);
}

const corpusDir = arg("corpus") ?? "benchmark/person-research/people";

if (flag("corpus-coverage")) {
  const corpus = loadCorpus(corpusDir);
  process.stdout.write(`corpus ${corpus.version}: ${String(corpus.people.length)} people\n`);
  for (const rejection of corpus.rejected)
    process.stdout.write(`REJECTED ${rejection.file}: ${rejection.reason}\n`);
  for (const row of requirementCoverage(corpus.people))
    process.stdout.write(
      `${row.requirement.padEnd(4)} ${String(row.people).padStart(3)} people ${String(row.facts).padStart(4)} facts  ${row.label}\n`,
    );
  process.stdout.write(
    `Collection scenarios: ${String(corpus.scenarios.length)} (r18; separate from individual facts).\n`,
  );
  process.exit(corpus.rejected.length ? 1 : 0);
}

const comparisonIndex = process.argv.indexOf("--compare");
if (comparisonIndex !== -1) {
  const baselinePath = process.argv[comparisonIndex + 1];
  const candidatePath = process.argv[comparisonIndex + 2];
  if (!baselinePath || !candidatePath)
    throw new Error("--compare needs a baseline report path and a candidate report path.");
  const baseline = BenchmarkReportSchema.parse(JSON.parse(readFileSync(baselinePath, "utf8")));
  const candidate = BenchmarkReportSchema.parse(JSON.parse(readFileSync(candidatePath, "utf8")));
  const comparison = compareReports(baseline, candidate);
  const out = arg("out") ?? "artifacts/person-benchmark";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "comparison.json"), `${JSON.stringify(comparison)}\n`);
  writeFileSync(join(out, "comparison.md"), `${renderComparison(comparison)}\n`);
  process.stdout.write(`${renderComparison(comparison)}\n`);
  process.exit(!comparison.comparable || comparison.verdict === "regressed" ? 1 : 0);
}

const compareStatsIndex = process.argv.indexOf("--compare-stats");
if (compareStatsIndex !== -1) {
  const baselinePath = process.argv[compareStatsIndex + 1];
  const candidatePath = process.argv[compareStatsIndex + 2];
  if (!baselinePath || !candidatePath)
    throw new Error("--compare-stats needs a baseline and a candidate stats.json path.");
  const baseline = BenchmarkArmStatsSchema.parse(JSON.parse(readFileSync(baselinePath, "utf8")));
  const candidate = BenchmarkArmStatsSchema.parse(JSON.parse(readFileSync(candidatePath, "utf8")));
  const comparison = compareArmStats(baseline, candidate);
  const out = arg("out") ?? "artifacts/person-benchmark";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "stats-comparison.json"), `${JSON.stringify(comparison)}\n`);
  writeFileSync(join(out, "stats-comparison.md"), `${renderStatsComparison(comparison)}\n`);
  process.stdout.write(`${renderStatsComparison(comparison)}\n`);
  /* The noise verdict is advice, not a gate: a coin-flip delta is a finding
     about the design, not a failure of the run. */
  process.exit(0);
}

const statsDir = arg("stats");
if (statsDir !== undefined) {
  const stats = buildArmStats(statsDir);
  if (!stats) throw new Error(`No arm reports with measured people in ${statsDir}.`);
  writeFileSync(join(statsDir, "stats.json"), `${JSON.stringify(stats)}\n`);
  writeFileSync(join(statsDir, "stats.md"), `${renderArmStats(stats)}\n`);
  process.stdout.write(`${renderArmStats(stats)}\n`);
  process.exit(0);
}

const mode = arg("mode") ?? "fixed-documents";
if (mode !== "live-discovery" && mode !== "fixed-documents")
  throw new Error("--mode must be live-discovery or fixed-documents.");
const pipeline = arg("pipeline") ?? "expanded";
if (pipeline !== "incumbent" && pipeline !== "expanded")
  throw new Error("--pipeline must be incumbent or expanded.");

const concurrency = positiveInteger("concurrency", 1);
if (concurrency > 4) throw new Error("--concurrency must be an integer from 1 to 4.");

const seedArg = arg("seed");
const seed = seedArg === undefined ? undefined : Number(seedArg);
if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0))
  throw new Error("--seed must be a non-negative integer.");

const maxCostArg = arg("max-cost");
const maxCost = maxCostArg === undefined ? undefined : Number(maxCostArg);
if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost <= 0))
  throw new Error("--max-cost must be a positive number of dollars.");

const repeats = positiveInteger("repeats", 1);
if (repeats > 20) throw new Error("--repeats must be 1 to 20, the arm-statistics ceiling.");
if (repeats > 1 && mode === "live-discovery")
  throw new Error("--repeats above 1 is supported for fixed-documents only.");
const noCache = flag("no-cache");

const retryDir = arg("retry");
const reuseOnlyDir = arg("reuse-extraction");
if (retryDir !== undefined && reuseOnlyDir !== undefined)
  throw new Error("--retry and --reuse-extraction are alternatives; pass one.");

/* After the reuse classification: nothing to run anywhere means the caller
   asked for a rebuild without research, which the plain flags already do. */
const requireWork = (toRun: { slug: string }[]) => {
  if (toRun.length === 0)
    throw new Error(
      "Nothing to run: every selected person is already carried. Re-run without --retry/--reuse-extraction to rebuild the report.",
    );
};

const configPath = arg("config") ?? "workspace/config.json";
const settings = new ConfigStore(resolve(configPath), false);
settings.load();
const research = settings.getForPurpose("personResearch");
const planning = settings.getForPurpose("researchPlanning");
const judging = settings.getForPurpose("evaluationJudge");

const corpus = loadCorpus(corpusDir);
for (const rejection of corpus.rejected)
  process.stderr.write(`REJECTED ${rejection.file}: ${rejection.reason}\n`);
if (corpus.rejected.length) throw new Error("Benchmark corpus contains rejected entries.");

const reassessmentPath = arg("reassess");
if (reassessmentPath) {
  const evidenceWorkspace = arg("evidence-workspace");
  if (!evidenceWorkspace) throw new Error("--reassess requires --evidence-workspace.");
  if (
    [
      "people",
      "limit",
      "mode",
      "pipeline",
      "profile-calls",
      "profile-ms",
      "read-concurrency",
      "concurrency",
      "retain-evidence",
      "render",
    ].some(flag)
  )
    throw new Error(
      "Reassessment preserves the original research selection and configuration; research overrides are not allowed.",
    );
  const report = await reassessReport({
    reportPath: reassessmentPath,
    evidenceWorkspace,
    onlyFailed: flag("reassess-only-failed"),
    ...(arg("timeline-minutes")
      ? { timelineMinutes: arg("timeline-minutes")!.split(",").map(Number) }
      : {}),
    onTimeline: (slug, points, provenance) => {
      const out = arg("out") ?? "artifacts/person-benchmark";
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, `timeline-${Date.now()}-${slug}.json`),
        JSON.stringify({
          kind: "publication-timeline",
          ...provenance,
          originalReport: reassessmentPath,
          judgeProvider: judging.provider,
          judgeModel: judging.model,
          points,
        }) + "\n",
        { flag: "wx" },
      );
    },
    ...(arg("lineage-root") ? { lineageRoot: arg("lineage-root")! } : {}),
    outputDirectory: resolve(arg("out") ?? "artifacts/person-benchmark"),
    corpus,
    judgeProvider: judging.provider,
    judgeModel: judging.model,
    onPerson: (artifact, operation) => {
      const stem = `${artifact.result.mode}-${artifact.pipeline}-reassessed-${artifact.runId}`;
      const out = arg("out") ?? "artifacts/person-benchmark";
      persistPersonArtifact(artifact, stem, out);
      writeFileSync(
        join(out, `${stem}-${artifact.result.slug}.operation.json`),
        `${JSON.stringify(operation)}\n`,
        { flag: "wx" },
      );
    },
    judge: makeCompleteJson(
      {
        provider: judging.provider,
        model: judging.model,
        apiKey: judging.apiKey,
        baseUrl: judging.ollama.baseUrl,
      },
      join(tmpdir(), "person-benchmark-mock.json"),
    ),
  });
  const out = arg("out") ?? "artifacts/person-benchmark";
  mkdirSync(out, { recursive: true });
  const stem = `${report.mode}-${report.provenance.pipeline}-reassessed-${report.runId}`;
  writeFileSync(join(out, `${stem}.json`), `${JSON.stringify(report)}\n`, { flag: "wx" });
  writeFileSync(join(out, `${stem}.md`), `${renderReport(report, corpus.people)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${renderReport(report, corpus.people)}\n\nWrote ${join(out, `${stem}.json`)}\n`,
  );
  process.exit(report.status === "completed" ? 0 : 1);
}
if (flag("reassess-only-failed") || flag("lineage-root"))
  throw new Error("--reassess-only-failed and --lineage-root require --reassess.");
if (flag("timeline-minutes")) throw new Error("--timeline-minutes requires --reassess.");
if (flag("evidence-workspace")) throw new Error("--evidence-workspace requires --reassess.");

const requested = (arg("people") ?? "")
  .split(",")
  .map((slug) => slug.trim())
  .filter(Boolean);
if (flag("people") && requested.length === 0)
  throw new Error("--people must select at least one person.");
const limit = positiveInteger("limit", corpus.people.length);
let selected = requested.length
  ? corpus.people.filter((person) => requested.includes(person.slug))
  : corpus.people;
for (const slug of requested) {
  if (!corpus.people.some((person) => person.slug === slug))
    throw new Error(`Unknown Benchmark Person: ${slug}`);
}
selected = selected.slice(0, limit);
if (selected.length === 0) throw new Error("Benchmark selection is empty.");
const requestedPopulation = requested.length
  ? requested
  : corpus.people.map((person) => person.slug);
const skipped = requestedPopulation
  .filter((slug) => !selected.some((person) => person.slug === slug))
  .map((slug) => ({ slug, reason: "Excluded by --limit." }));

/* The run recipe a carried artifact must prove. promptVersion and the
   requested reasoning effort are constants of this driver version; the seed
   rides along only when the caller names one. */
const runConditions: ResumeConditions = {
  mode,
  researchProvider: research.provider,
  researchModel: research.model,
  promptVersion: "2026-09-06.4",
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  judgeReasoningEffort: JUDGE_REASONING_EFFORT,
  ...(seed !== undefined ? { seed } : {}),
  corpusVersion: corpus.version,
  pipeline,
  judgeProvider: judging.provider,
  judgeModel: judging.model,
  judgeVersion: JUDGE_VERSION,
  referenceVersions: Object.fromEntries(
    corpus.people.map((person) => [person.slug, person.referenceVersion]),
  ),
};

/* Resume: a completed, fully assessed person under a provably identical run
   recipe is money already spent — carry the result, re-run only the rest. */
let carried: BenchmarkPersonResult[] = [];
let toRun: typeof selected = selected;
if (retryDir !== undefined || reuseOnlyDir !== undefined) {
  const reuse = loadReusable(resolve(retryDir ?? reuseOnlyDir!), runConditions);
  if (reuse.mismatched.length > 0) {
    const first = reuse.mismatched[0]!;
    throw new Error(
      `The reuse directory refuses ${reuse.mismatched.length} artifact(s) on conditions: ${first.slug} ran with ${first.field}=${JSON.stringify(first.prior)}; this run has ${first.field}=${JSON.stringify(first.current)}. Arms under different conditions are not one arm.`,
    );
  }
  if (reuse.unstamped.length > 0)
    process.stderr.write(
      `Skipping ${String(reuse.unstamped.length)} artifact(s) without a conditions stamp (pre-dating stamping): ${reuse.unstamped.slice(0, 5).join(", ")}\n`,
    );
  const eligibleSlugs = new Set(reuse.eligible.keys());
  const nothingLeftAnywhere = (narrowed: { slug: string }[]) =>
    narrowed.length === 0 && repeats === 1;
  carried = selected
    .filter((person) => eligibleSlugs.has(person.slug))
    .map((person) => reuse.eligible.get(person.slug)!.result);
  /* The report describes the whole requested selection — carried people are
     real measurements — so only the evaluation loop narrows to the rest. A
     fully carried repeat is legal (a resumed K=2 arm's first repeat): the
     campaign throws only when no repeat has anything left to run. */
  toRun = selected.filter((person) => !eligibleSlugs.has(person.slug));
  if (nothingLeftAnywhere(toRun)) requireWork(toRun);
}

const configured = configurePipeline(pipeline, readPersonSource);
const modelFor = (config: ReturnType<ConfigStore["getForPurpose"]>) =>
  makeCompleteJson(
    {
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.ollama.baseUrl,
    },
    join(tmpdir(), "person-benchmark-mock.json"),
  );

let inputCharacters = 0;
let outputCharacters = 0;
/* Provider-reported spend, accumulated at the seam. Arms that once died to an
   outage and were re-run from scratch now pay only for what is missing. */
const usage = {
  /* Each token half is null until a provider observation reports it: an
     unobserved half serializes as null (unavailable), never as a fake 0. */
  inputTokens: null as number | null,
  outputTokens: null as number | null,
  sawTokens: false,
  costUsd: 0,
  sawCost: false,
};
observeModelUsage((observation) => {
  if (observation.inputTokens !== null) {
    usage.inputTokens = (usage.inputTokens ?? 0) + observation.inputTokens;
    usage.sawTokens = true;
  }
  if (observation.outputTokens !== null) {
    usage.outputTokens = (usage.outputTokens ?? 0) + observation.outputTokens;
    usage.sawTokens = true;
  }
  if (observation.costUsd !== null) {
    usage.costUsd += observation.costUsd;
    usage.sawCost = true;
  }
});

const measured =
  (config: ReturnType<ConfigStore["getForPurpose"]>) => async (request: CompletionRequest) => {
    const full: CompletionRequest = seed !== undefined ? { ...request, seed } : request;
    inputCharacters += full.system.length + full.user.length;
    const answer = await modelFor(config)(full);
    outputCharacters += JSON.stringify(answer).length;
    return answer;
  };

const gitSha = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    /* Outside a git checkout (a downloaded script, a container): record the
       absence rather than inventing a sha. */
    return undefined;
  }
})();

const startedAt = new Date().toISOString();
const id = runId(corpus.version, mode, startedAt);
const outDir = arg("out") ?? "artifacts/person-benchmark";
mkdirSync(outDir, { recursive: true });
const stem = `${mode}-${pipeline}-${id}`;

const results: BenchmarkPersonResult[] = [];
const researchOutcomes: PersonResearchOperationOutcome[] = [];
const population: { slug: string; profileId: string }[] = [];

const overrides: { profileCalls: number; profileMilliseconds: number; readConcurrency: number } = {
  profileCalls: positiveInteger("profile-calls", configured.settings.profileCalls),
  profileMilliseconds: positiveInteger("profile-ms", configured.settings.profileMilliseconds),
  readConcurrency: positiveInteger("read-concurrency", configured.settings.readConcurrency),
};

/* The judge cache is keyed by judge version and repeat, so a judge fix or a
   K-repeat pass re-samples instead of replaying a stored answer; only the
   resume of identical questions is free. Local disk, never committed. */
const judgePort = (repeat: number) =>
  cachedCompleteJson(measured(judging), {
    cacheDir: join(".cache", "person-benchmark", "judge"),
    namespace: `judge-${JUDGE_VERSION}-r${String(repeat)}`,
    provider: judging.provider,
    model: judging.model,
    disabled: noCache,
  });

const checkCost = () => {
  if (maxCost !== undefined && usage.sawCost && usage.costUsd > maxCost)
    throw new Error(
      `Model cost ceiling exceeded: $${usage.costUsd.toFixed(2)} > $${maxCost.toFixed(2)}. The arm is reported as interrupted; --retry completes it from here.`,
    );
};

let allCompleted = true;
for (let repeat = 1; repeat <= repeats; repeat++) {
  /* Each repeat is a whole pass over the selection with fresh sampling, in
     per-iteration state; the cost ledger is process-wide and never resets —
     it is real money. */
  results.length = 0;
  researchOutcomes.length = 0;
  population.length = 0;
  let collection: BenchmarkCollectionResult[] = [];
  let status: BenchmarkReport["status"] = "completed";
  let statusDetail = "Every selected Benchmark Person was evaluated.";
  let executionStatus: "completed" | "interrupted" = "interrupted";
  let evidenceBundleHash: string | undefined;
  const stemRepeat = repeats > 1 ? `${stem}-r${String(repeat)}` : stem;

  /* One builder for the final report and for the after-each-person partial:
     a hard kill mid-repeat still leaves a readable, honest top-level report
     saying exactly how far the arm got. */
  const buildReport = (
    reportStatus: BenchmarkReport["status"],
    reportStatusDetail: string,
    reportExecution: "completed" | "interrupted",
  ): BenchmarkReport => {
    /* Computed per call: the partial reads it mid-run, when results grow.
       Carried persons belong to repeat 1's report; later repeats re-sampled
       the full selection, and prepending carried again would double-count. */
    const merged = (repeat === 1 ? [...carried, ...results] : results).sort(
      (a, b) => requestedPopulation.indexOf(a.slug) - requestedPopulation.indexOf(b.slug),
    );
    const measuredSlugs = new Set(merged.map((person) => person.slug));
    const groupBasis = corpus.people.filter((person) => measuredSlugs.has(person.slug));
    return {
      schemaVersion: 1,
      runId: id,
      ...(evidenceBundleHash ? { evidenceBundleHash } : {}),
      status: reportStatus,
      statusDetail: reportStatusDetail,
      execution: {
        status: reportExecution,
        selected: selected.map((person) => person.slug),
        evaluated: merged.length,
        assessed: merged.filter(
          (result) =>
            result.assessment?.operationId &&
            result.assessment.integrity === "completed" &&
            result.assessment.judge === "completed",
        ).length,
        scenarioIds: corpus.scenarios.map((scenario) => scenario.id),
      },
      mode,
      selection: {
        requested: requestedPopulation,
        evaluated: merged.map((result) => result.slug),
        skipped,
      },
      /* The resume split describes the repeat that carried people — later
         repeats sampled fresh and record nothing carried. */
      ...(repeat === 1 && (retryDir !== undefined || reuseOnlyDir !== undefined)
        ? {
            resume: {
              carriedPeople: carried.map((person) => person.slug),
              retriedPeople: results.map((person) => person.slug),
            },
          }
        : {}),
      provenance: {
        corpusVersion: corpus.version,
        referenceVersions: Object.fromEntries(
          selected.map((person) => [person.slug, person.referenceVersion]),
        ),
        pipeline,
        researchProvider: research.provider,
        researchModel: research.model,
        ...(mode === "live-discovery" && pipeline === "expanded"
          ? { planningProvider: planning.provider, planningModel: planning.model }
          : {}),
        judgeProvider: judging.provider,
        judgeModel: judging.model,
        judgeVersion: JUDGE_VERSION,
        promptVersion: "2026-09-06.4",
        collectorVersions: { "person-research": "2026-09-06" },
        researchSettings: {
          ...configured.conditions,
          ...overrides,
          operationConcurrency: concurrency,
          modelRetryPolicy:
            "One same-binding idle/transport retry inside the original deadline; extraction, planning and benchmark judges",
          usageAccounting:
            "Logical request text and returned answer characters; excludes retried wire payloads",
          judgeBindingPreference: "forced_tool_call when model-declared; default otherwise",
          extractionBindingPreference: "forced_tool_call when model-declared; default otherwise",
          extractionRouteSort: "throughput",
          extractionRouteThroughputFloorTps: EXTRACTION_PREFERRED_MIN_THROUGHPUT,
          /* Requested thinking depth; the seam omits it for models that advertise
           no effort list, so provider defaults apply there. */
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          judgeReasoningEffort: JUDGE_REASONING_EFFORT,
          reasoningExclude: true,
          routeRestPolicy: ROUTE_REST_POLICY,
          routeRestCooldownSeconds: ROUTE_COOLDOWN_MS / 1000,
          routeRestMaxRoutes: MAX_RESTING_ROUTES,
          planner: mode === "live-discovery" && pipeline === "expanded",
          ...(gitSha !== undefined ? { gitSha } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(repeats > 1 ? { repeats } : {}),
        },
        network: mode === "live-discovery" ? "live" : "fixed-documents",
        usage: {
          inputCharacters,
          outputCharacters,
          tokens: usage.sawTokens
            ? { input: usage.inputTokens, output: usage.outputTokens }
            : "unavailable",
          cost: usage.sawCost ? Math.round(usage.costUsd * 1_000_000) / 1_000_000 : "unavailable",
        },
        startedAt,
        finishedAt: new Date().toISOString(),
        host: hostname(),
      },
      people: merged,
      collection,
      groups: summarizeGroups(groupBasis, merged),
      remainingMisses: remainingMisses(groupBasis, merged),
      leadDispositions: leadDispositionTotals(researchOutcomes),
      coverageGaps: coverageGapTotals(researchOutcomes),
    };
  };

  /* Carried persons ride the first repeat only: later repeats exist to take
     fresh samples, and carrying them there would double-count one sample. */
  const repeatRun = repeats > 1 && repeat > 1 ? selected : toRun;
  if (toRun.length === 0 && repeat === 1 && repeats > 1) {
    /* A resumed K=2 arm whose first repeat is fully carried: record it and
       spend the fresh sampling where it belongs, on the later repeats. */
    process.stdout.write(
      `Repeat ${String(repeat)}: all ${String(selected.length)} people carried from the prior run.\n`,
    );
    executionStatus = "completed";
    const validated = BenchmarkReportSchema.parse(
      buildReport(status, statusDetail, executionStatus),
    );
    writeFileSync(join(outDir, `${stemRepeat}.json`), `${JSON.stringify(validated)}\n`);
    writeFileSync(join(outDir, `${stemRepeat}.md`), `${renderReport(validated, selected)}\n`);
    continue;
  }
  requireWork(repeatRun);

  const workspaceDir = mkdtempSync(join(tmpdir(), "person-benchmark-collection-"));
  try {
    const ports: EvaluationPorts = {
      workspaceDir,
      search: configured.search,
      complete: () => measured(research),
      ...(pipeline === "expanded" ? { plan: () => measured(planning) } : {}),
      judge: judgePort(repeat),
      ...(configured.seeds ? { seeds: configured.seeds } : {}),
      ...(configured.readSource ? { readSource: configured.readSource } : {}),
      ...(flag("render") && mode === "live-discovery"
        ? { render: playwrightBrowserRenderer() }
        : {}),
      settings: overrides,
    };
    const onStarted = (person: (typeof repeatRun)[number], index: number) =>
      process.stderr.write(
        `[${String(index + 1)}/${String(repeatRun.length)}] ${person.slug} (${mode}, ${pipeline}, repeat ${String(repeat)})\n`,
      );
    const onEvaluated = (evaluation: PersonEvaluation) => {
      const person = evaluation.result;
      results.push(evaluation.result);
      results.sort(
        (a, b) =>
          selected.findIndex((person) => person.slug === a.slug) -
          selected.findIndex((person) => person.slug === b.slug),
      );
      population.push({ slug: person.slug, profileId: evaluation.profileId });
      if (evaluation.operation) researchOutcomes.push(evaluation.operation);
      writeFileSync(
        join(outDir, `${stemRepeat}-${person.slug}.operation.json`),
        `${JSON.stringify(evaluation.operation)}\n`,
      );
      persistPersonArtifact(
        {
          schemaVersion: 1,
          runId: id,
          corpusVersion: corpus.version,
          pipeline,
          judgeProvider: judging.provider,
          judgeModel: judging.model,
          judgeVersion: JUDGE_VERSION,
          assessedAt: new Date().toISOString(),
          conditions: runConditions,
          result: person,
        },
        stemRepeat,
        outDir,
      );
      checkCost();
      /* The partial is overwritten by the next person and finally by the
         repeat's real report; its interrupted status is the honest record of
         a run that was still moving when it stopped. */
      writeFileSync(
        join(outDir, `${stemRepeat}.json`),
        `${JSON.stringify(
          BenchmarkReportSchema.parse(
            buildReport(
              "interrupted",
              `In progress: ${String(results.length + carried.length)} of ${String(selected.length)} people evaluated.`,
              executionStatus,
            ),
          ),
        )}\n`,
      );
    };
    let people;
    if (mode === "live-discovery") {
      ({ people } = await evaluateLivePopulation(repeatRun, {
        ...ports,
        concurrency,
        onStarted,
        onEvaluated,
      }));
    } else {
      /* Fixed-document mode used to research people serially. Each person runs
         through its own composition over the shared collection workspace, and
         every store under it is keyed per profile or per source, so parallel
         people touch disjoint files; collection scoring reads the workspace
         only after every worker settles. The one shared file (the research
         queue snapshot) is loaded per composition and only its throwaway
         persistence can interleave — nothing mid-run reads it back. Route
         rests are process-wide by design, so parallel people share what each
         learns about bad routes, the way the long-running app does (#233). */
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, repeatRun.length) }, async () => {
        while (next < repeatRun.length) {
          const index = next++;
          const person = repeatRun[index]!;
          onStarted(person, index);
          onEvaluated(await evaluatePerson(person, mode, ports));
        }
      });
      /* An output/assessment failure must not strand a sibling's accepted
         operation mid-write: every worker settles before the first failure
         surfaces, mirroring the live population path. */
      const settled = await Promise.allSettled(workers);
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      people = composePersonProfiles({
        workspaceDir,
        search: configured.search,
        complete: () => measured(research),
        confirmedTranscripts: () => [],
        transcriptStillConfirmed: () => false,
        researchEnabled: () => false,
      });
    }
    collection = await evaluateCollection(people, population, corpus.scenarios, {
      references: corpus.people,
      judge: judgePort(repeat),
    });
    checkCost();
    executionStatus = "completed";
  } catch (error) {
    /* An interrupted run is reported as interrupted with whatever it completed.
       It never leaves an earlier successful report standing as this run's. */
    status = "interrupted";
    statusDetail = `The run stopped after ${String(results.length)} of ${String(selected.length)} people: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    try {
      if (flag("retain-evidence")) {
        const evidenceDirectory = join(outDir, `${stemRepeat}.evidence`);
        evidenceBundleHash = retainEvidence(
          workspaceDir,
          evidenceDirectory,
          results.flatMap((result) =>
            result.assessment?.operationId ? [result.assessment.operationId] : [],
          ),
        );
        process.stderr.write(`Retained evidence: ${evidenceDirectory}\n`);
      }
    } catch (error) {
      status = "interrupted";
      statusDetail = `Evidence snapshot failed: ${error instanceof Error ? error.message : "unknown error"}`;
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
  if (
    status === "completed" &&
    (results.some((result) => result.failure !== null) ||
      collection.some((result) => result.assessmentStatus !== "completed"))
  ) {
    status = "failed";
    statusDetail = `${String(results.filter((result) => result.failure).length)} of ${String(results.length)} people had research or assessment failures; ${String(collection.filter((result) => result.assessmentStatus !== "completed").length)} collection scenarios had assessment failures. These failures remain recorded even when evaluation execution finished.`;
  }
  if (status !== "completed") allCompleted = false;
  /* A ceiling trip or an outage ends the campaign here — pushing on into the
     next repeat spends money on a run whose execution already stopped. A
     merely failed arm (semantic failures, execution completed) still
     sampled its people, so later repeats remain meaningful. */
  if (status === "interrupted") break;

  const report = buildReport(status, statusDetail, executionStatus);
  const validated = BenchmarkReportSchema.parse(report);
  writeFileSync(join(outDir, `${stemRepeat}.json`), `${JSON.stringify(validated)}\n`);
  writeFileSync(join(outDir, `${stemRepeat}.md`), `${renderReport(validated, selected)}\n`);
  process.stdout.write(`${renderReport(validated, selected)}\n`);
  process.stdout.write(
    `\nWrote ${join(outDir, `${stemRepeat}.json`)} and ${join(outDir, `${stemRepeat}.md`)}\n`,
  );
}

if (repeats > 1) {
  /* The arm's own statistics, read back from the repeat reports just written:
     the interval, the detectable bar, and the noise verdict live here instead
     of in a hand-run Python pass. */
  const stats = buildArmStats(outDir);
  if (stats) {
    writeFileSync(join(outDir, "stats.json"), `${JSON.stringify(stats)}\n`);
    writeFileSync(join(outDir, "stats.md"), `${renderArmStats(stats)}\n`);
    process.stdout.write(`\n${renderArmStats(stats)}\n`);
  }
}

process.exit(allCompleted ? 0 : 1);
