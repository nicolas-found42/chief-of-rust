/**
 * Debrief eval fan-out — runs every transcript through every given OpenRouter
 * model, with a bounded pool of in-flight LLM calls, and reports where the
 * results landed. Scoring stays separate: per model dir, run
 *   tsx scripts/score-debrief-eval.mts --all <outdir>/<model-slug>
 * or pass --score to chain it here. See docs/research/debrief-eval-cli.md.
 * Usage: tsx scripts/run-debrief-eval-all.mts [--models m1,m2] [--outdir /tmp/debrief-gate] [--glob <pattern>] [--concurrency N] [--score] [--help]
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  actionItemEvidence,
  buildDebriefMessages,
  clampDueDates,
  dropActionItemEvidence,
  stripFulfilledActionItems,
  stripRestatedDecisions,
} from "../apps/server/src/modules/meeting-debrief/extraction.js";
import { makeCompleteJson, type CompleteJson } from "../apps/server/src/llm/providers.js";
import { modelBoundaryDiagnostic } from "../apps/server/src/llm/failure.js";
import { MeetingDebriefExtractionSchema } from "../packages/shared/src/meeting-debrief.js";
import type { TranscriptRecord } from "../packages/shared/src/transcript.js";

const DEFAULT_MODELS = ["upstage/solar-pro4"];
const DEFAULT_OUTDIR = "/tmp/debrief-gate";
const DEFAULT_GLOB = "tests/fixtures/debrief-golden/transcripts/*.md";
/** One transcript×model run is tried this many times before it is called failed. */
const MAX_ATTEMPTS = 10;
/** A run stops retrying once its attempts have cumulatively cost this long. */
const RETRY_BUDGET_MS = 60_000;
const DEFAULT_CONCURRENCY = 20;

type Options = {
  models: string[];
  outdir: string;
  glob: string;
  concurrency: number;
  score: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): { options: Options; unknown: string[] } {
  const options: Options = {
    models: DEFAULT_MODELS,
    outdir: DEFAULT_OUTDIR,
    glob: DEFAULT_GLOB,
    concurrency: DEFAULT_CONCURRENCY,
    score: false,
    help: false,
  };
  const unknown: string[] = [];
  const models = (value: string): string[] =>
    value
      .split(",")
      .map((slug) => slug.trim())
      .filter((slug) => slug.length > 0);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--score") options.score = true;
    else if (arg === "--models") options.models = models(argv[++i] ?? "");
    else if (arg.startsWith("--models=")) options.models = models(arg.split("=")[1] ?? "");
    else if (arg === "--outdir") options.outdir = argv[++i] ?? options.outdir;
    else if (arg.startsWith("--outdir=")) options.outdir = arg.split("=")[1] ?? options.outdir;
    else if (arg === "--glob") options.glob = argv[++i] ?? options.glob;
    else if (arg.startsWith("--glob=")) options.glob = arg.split("=")[1] ?? options.glob;
    else if (arg === "--concurrency") options.concurrency = Number(argv[++i]);
    else if (arg.startsWith("--concurrency=")) options.concurrency = Number(arg.split("=")[1]);
    else unknown.push(arg);
  }
  return { options, unknown };
}

function helpText(): string {
  return `run-debrief-eval-all — debrief eval fan-out: every transcript × every model, parallel

Usage: tsx scripts/run-debrief-eval-all.mts [options]

Options:
  --models <m1,m2>     Comma-separated OpenRouter models, "author/model" slugs
                       (default: ${DEFAULT_MODELS.join(",")})
  --outdir <path>      Run root; each model writes <outdir>/<model-slug>/
                       (default: ${DEFAULT_OUTDIR})
  --glob <pattern>     Transcript glob; always re-runs every match, quote it so
                       the shell does not expand it (default: ${DEFAULT_GLOB})
  --concurrency <n>    Max in-flight LLM calls (default: ${DEFAULT_CONCURRENCY})
  --score              After the runs, score each model dir with
                       scripts/score-debrief-eval.mts --all
  --help, -h           Show this help

Requires OPENROUTER_API_KEY. Every run lands a file in <outdir>/<model-slug>/:
  <transcript>.debrief.json  model output (scoreable, even when schema-invalid)
  <transcript>.error.json    every attempt failed; records attempts, timing, error
Exactly one of the two survives a run: the outcome it did not produce is
removed, so no transcript is ever scored against an earlier run's leftovers.
`;
}

/** Minimal flat glob: dir + wildcard filename, enough for transcript globs. */
function expandGlob(pattern: string): string[] {
  const slash = pattern.lastIndexOf("/");
  const dir = slash === -1 ? "." : pattern.slice(0, slash);
  const filePart = slash === -1 ? pattern : pattern.slice(slash + 1);
  if (!filePart.includes("*") && !filePart.includes("?")) return [pattern];
  const regex = new RegExp(
    `${filePart
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", "[^/]*")
      .replaceAll("?", "[^/]")}$`,
  );
  return readdirSync(dir)
    .filter((entry) => regex.test(entry))
    .sort()
    .map((entry) => join(dir, entry));
}

function slugify(model: string): string {
  return model.replaceAll("/", "-");
}

/** Bounded worker pool: at most `limit` workers drain the task list. */
async function forEachOfLimit<T>(
  tasks: T[],
  limit: number,
  worker: (task: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const task = tasks[next++]!;
        await worker(task);
      }
    }),
  );
}

async function runOne(
  complete: CompleteJson,
  file: string,
  outFile: string,
  errFile: string,
  model: string,
  tag: string,
): Promise<"ok" | "invalid" | "error"> {
  const name = file.split("/").pop()!;
  const text = await readFile(file, "utf8");
  const record = {
    id: `eval-${name}`,
    source: { fileName: name },
    ingestedAt: new Date().toISOString(),
    normalizedText: text,
    meetingDate: name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
    occurrence: null,
    speakers: [],
    roster: [],
  } as unknown as TranscriptRecord;
  const messages = buildDebriefMessages(record, {
    mentions: [],
    decisions: [],
    organizations: [],
  });
  const started = Date.now();
  let raw: unknown = null;
  let attempts = 0;
  let lastDetail = "";
  let lastDiagnostic: unknown = null;
  const recordFailure = (): ErrorFile => ({
    model,
    transcript: name,
    attempts,
    ms: Date.now() - started,
    error: lastDetail,
    diagnostic: lastDiagnostic,
  });
  let failure: ErrorFile | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && Date.now() - started >= RETRY_BUDGET_MS) {
      console.log(
        `${tag} retry budget exhausted after ${attempt - 1} attempt(s), ${Date.now() - started}ms cumulative`,
      );
      failure = recordFailure();
      break;
    }
    attempts = attempt;
    const t0 = Date.now();
    try {
      raw = await complete({
        system: messages.system,
        user: messages.user,
        schema: messages.schema,
        temperature: 0,
      });
      break;
    } catch (error) {
      const ms = Date.now() - t0;
      lastDetail = errorMessage(error);
      if (attempt < MAX_ATTEMPTS) {
        console.log(
          `${tag} attempt ${attempt}/${MAX_ATTEMPTS} failed after ${ms}ms: ${lastDetail}`,
        );
        continue;
      }
      lastDiagnostic = modelBoundaryDiagnostic(error);
      console.log(
        `${tag} FAILED after ${attempt} attempt(s) / ${Date.now() - started}ms — last error after ${ms}ms: ${lastDetail}`,
      );
      console.log(
        `${tag}   diagnostic: ${JSON.stringify(
          lastDiagnostic ?? { note: "failure did not cross the model seam" },
        )}`,
      );
      failure = recordFailure();
      break;
    }
  }
  if (failure) {
    await writeErrorFile(errFile, outFile, failure);
    return "error";
  }
  const ms = Date.now() - started;
  try {
    const checked = MeetingDebriefExtractionSchema.safeParse(dropActionItemEvidence(raw));
    const parsed = checked.success
      ? {
          success: true as const,
          data: stripRestatedDecisions(
            stripFulfilledActionItems(
              clampDueDates(checked.data, record),
              actionItemEvidence(raw),
              record,
            ),
          ),
        }
      : checked;
    await writeFile(
      outFile,
      JSON.stringify(
        {
          model,
          ms,
          valid: parsed.success,
          /* What the production pipeline would store: the extraction after the
             module's dueDate clamp. The literal model reply rides beside it. */
          raw: parsed.success ? parsed.data : raw,
          modelRaw: raw,
        },
        null,
        2,
      ),
    );
    await discard(errFile);
    if (!parsed.success) {
      console.log(`${tag} INVALID after ${ms}ms: first of ${parsed.error.issues.length} issues:`);
      for (const issue of parsed.error.issues.slice(0, 5))
        console.log(`${tag}   ${issue.path.join(".")}: ${issue.message}`);
      return "invalid";
    }
    const d = parsed.data;
    console.log(
      `${tag} OK ${ms}ms summary=${d.summary.length}ch decisions=${d.decisions.length} actions=${d.actionItems.length} questions=${d.openQuestions.length} recipients=${d.suggestedRecipients.length}`,
    );
    for (const a of d.actionItems)
      console.log(`${tag}   - [${a.owner ?? "?"}] ${a.title} due=${a.dueDate ?? "-"}`);
    return "ok";
  } catch (error) {
    console.log(`${tag} ERROR after ${Date.now() - started}ms: ${errorMessage(error)}`);
    return "error";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 2000);
  return String(error).slice(0, 2000);
}

/** Recorded for a transcript×model run whose every attempt failed. */
type ErrorFile = {
  model: string;
  transcript: string;
  attempts: number;
  ms: number;
  error: string;
  diagnostic: unknown;
};

async function writeErrorFile(errFile: string, outFile: string, failure: ErrorFile): Promise<void> {
  await discard(outFile);
  try {
    await writeFile(errFile, JSON.stringify(failure, null, 2));
  } catch (error) {
    console.log(`could not write ${errFile}: ${errorMessage(error)}`);
  }
}

/* A run owns its transcript's slot in the model dir: the file the other outcome
   would have written goes, or the scorer pairs the golden with a result from a
   previous run and reports it as this one's. */
async function discard(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    console.log(`could not remove ${path}: ${errorMessage(error)}`);
  }
}

const { options, unknown } = parseArgs(process.argv.slice(2));
if (unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(", ")} — quote globs, see --help`);
  process.exit(1);
}
if (options.help) {
  console.log(helpText());
  process.exit(0);
}
if (options.models.length === 0) {
  console.error("no models given (--models m1,m2)");
  process.exit(1);
}
if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
  console.error(`--concurrency must be a positive integer, got ${options.concurrency}`);
  process.exit(1);
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY missing");
  process.exit(1);
}
const files = expandGlob(options.glob);
if (files.length === 0) {
  console.error(`no transcripts match ${options.glob}`);
  process.exit(1);
}

const total = files.length * options.models.length;
console.log(
  `${files.length} transcripts × ${options.models.length} model(s) = ${total} runs, concurrency=${options.concurrency}`,
);

const completes = new Map(
  options.models.map((model) => [
    model,
    makeCompleteJson({ provider: "openrouter", model, apiKey }, ""),
  ]),
);
for (const model of options.models)
  await mkdir(join(options.outdir, slugify(model)), { recursive: true });

type Task = { model: string; file: string };
const tasks: Task[] = [];
for (const model of options.models) for (const file of files) tasks.push({ model, file });

type Outcome = "ok" | "invalid" | "error";
const perModelOutcomes = new Map<string, Record<Outcome, number>>(
  options.models.map((model) => [model, { ok: 0, invalid: 0, error: 0 }]),
);
const failed: string[] = [];

await forEachOfLimit(tasks, options.concurrency, async (task) => {
  const slug = slugify(task.model);
  const counts = perModelOutcomes.get(task.model)!;
  const done = counts.ok + counts.invalid + counts.error + 1;
  const tag = `[${slug} ${done}/${files.length}]`;
  const name = task.file.split("/").pop()!;
  const dir = join(options.outdir, slug);
  console.log(`${tag} === ${name} ===`);
  let outcome: Outcome;
  try {
    outcome = await runOne(
      completes.get(task.model)!,
      task.file,
      join(dir, `${name}.debrief.json`),
      join(dir, `${name}.error.json`),
      task.model,
      tag,
    );
  } catch (error) {
    console.log(`${tag} crashed: ${errorMessage(error)}`);
    outcome = "error";
    await writeErrorFile(join(dir, `${name}.error.json`), join(dir, `${name}.debrief.json`), {
      model: task.model,
      transcript: name,
      attempts: 0,
      ms: 0,
      error: errorMessage(error),
      diagnostic: null,
    });
  }
  counts[outcome]++;
  if (outcome !== "ok") failed.push(`${task.model} ${name}: ${outcome}`);
});

console.log(`\ndone: ${total - failed.length}/${total} runs`);
for (const model of options.models) {
  const dir = join(options.outdir, slugify(model));
  const counts = perModelOutcomes.get(model)!;
  console.log(
    `results: ${dir}  (${model}) — ${counts.ok} ok, ${counts.invalid} invalid, ${counts.error} error`,
  );
  console.log(`  score: tsx scripts/score-debrief-eval.mts --all ${dir}`);
}
if (failed.length > 0) {
  console.log(`failed (${failed.length}):`);
  for (const entry of failed) console.log(`  ${entry}`);
}

let exitCode = failed.length > 0 ? 1 : 0;
if (options.score) {
  for (const model of options.models) {
    const dir = join(options.outdir, slugify(model));
    console.log(`\n──── scoring ${dir} ────`);
    const scored = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/score-debrief-eval.mts", "--all", dir],
      { stdio: "inherit" },
    );
    if (scored.status !== 0) exitCode = 1;
  }
}
process.exit(exitCode);
