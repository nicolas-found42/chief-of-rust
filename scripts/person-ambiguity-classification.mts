import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkReportSchema } from "../packages/shared/src/index.js";
import { loadCorpus } from "../apps/server/src/person-benchmark/corpus.js";
import {
  AMBIGUITY_CAUSES,
  classifyPerson,
  summarizeAssignments,
  type AmbiguityAssignment,
  type ClassifiablePerson,
} from "../apps/server/src/person-benchmark/ambiguity.js";

/**
 * The Person Ambiguity Classification CLI (issue #234).
 *
 * Deterministic reassessment over retained benchmark reports: it loads each
 * report, walks every per-person semantic assessment, and assigns each
 * verdict === "ambiguous" exactly one named cause. It repeats no research,
 * makes no model calls, and never writes to the input reports. Causes that
 * cannot be decided from retained evidence stay explicitly undetermined.
 */

const HELP = `Person Ambiguity Classification

  pnpm exec tsx scripts/person-ambiguity-classification.mts [options]

Options
  --report <path>       Retained benchmark report JSON. Repeat with --population,
                        in order, to classify several populations at once.
  --population <name>   Population label for the preceding --report
                        (e.g. fixed, incumbent, expanded). Repeatable.
  --corpus <dir>        Corpus directory for reference-fact citations
                        (default: benchmark/person-research/people).
  --out <dir>           Output directory for classification.json/.md
                        (default: artifacts/person-benchmark/ambiguity-classification-2026-09-06).
  --help                This text.

Every --report needs a matching --population. Reports are only read: their
sha256 is recorded before parsing so the output proves the inputs are
untouched.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
  return value;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/**
 * The checkout root owning this script. Worktrees carry a `.git` file rather
 * than a directory, so existence — not type — is the marker.
 */
function repositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (; current !== dirname(current); current = dirname(current))
    if (existsSync(join(current, ".git"))) return current;
  throw new Error("Unable to locate the repository root.");
}

/**
 * Report paths are recorded repo-relative so committed outputs carry no
 * machine-specific absolute paths, and must live inside the repository: an
 * outside path would otherwise serialize as `../` traversal into the
 * committed artifacts. The original path is still used for reading.
 */
function repoRelativePath(path: string): string {
  const within = relative(repositoryRoot(), resolve(path)).replace(/\\/g, "/");
  if (within === ".." || within.startsWith("../"))
    throw new Error(`--report path must live inside the repository: ${path}`);
  return within;
}
function args(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}`) {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`--${name} needs a value.`);
      values.push(value);
    }
  }
  return values;
}

if (flag("help")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const reportPaths = args("report");
const populations = args("population");
if (reportPaths.length === 0) throw new Error("--report <path> is required.");
if (reportPaths.length !== populations.length)
  throw new Error("Every --report needs a matching --population, in order.");
if (new Set(populations).size !== populations.length)
  throw new Error("--population values must be unique.");

const corpusDir = arg("corpus") ?? "benchmark/person-research/people";
const outDir = arg("out") ?? "artifacts/person-benchmark/ambiguity-classification-2026-09-06";

const corpus = loadCorpus(corpusDir);
for (const rejection of corpus.rejected)
  process.stderr.write(`REJECTED ${rejection.file}: ${rejection.reason}\n`);
if (corpus.rejected.length) throw new Error("Benchmark corpus contains rejected entries.");
const corpusStatements = new Map<string, string>();
for (const person of corpus.people)
  for (const fact of person.facts)
    corpusStatements.set(`${person.slug}/${fact.id}`, fact.statement);

const inputs: { population: string; reportPath: string; sha256: string }[] = [];
const assignments: AmbiguityAssignment[] = [];
const measuredPerPopulation: Record<string, { facts: number; ambiguous: number }> = {};

for (let index = 0; index < reportPaths.length; index += 1) {
  const reportPath = reportPaths[index];
  const population = populations[index];
  if (reportPath === undefined || population === undefined)
    throw new Error("Every --report needs a matching --population, in order.");
  // Validates in-repository before any report is read, then records it repo-relative.
  const displayPath = repoRelativePath(reportPath);
  const raw = readFileSync(reportPath, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  inputs.push({ population, reportPath: displayPath, sha256 });
  const report = BenchmarkReportSchema.parse(JSON.parse(raw));
  let facts = 0;
  let ambiguous = 0;
  for (const person of report.people) {
    facts += person.completeness.judgements.length;
    const assessment = person.assessment;
    if (!assessment) throw new Error(`Report person ${person.slug} has no assessment.`);
    const phases = assessment.phases;
    if (!phases) throw new Error(`Report person ${person.slug} has no judge phases.`);
    const classifiable: ClassifiablePerson = {
      slug: person.slug,
      claimCount: person.richness.claims,
      referenceFailure: phases.reference.failure,
      supportStatus: phases.support.status,
      supportFailure: phases.support.failure,
      unresolved: (phases.support.unresolvedFindings ?? []).map((entry) => ({
        claimId: entry.claimId,
        citedQuote: entry.citedQuote,
      })),
      overclaims: person.factualReliability.overclaims.map((entry) => ({
        claimId: entry.claimId,
        citedQuote: entry.citedQuote,
      })),
      integritySubjects: person.factualReliability.integrityFindings.map((entry) => entry.subject),
      sourceContributionClaims: (person.sourceContributions ?? []).flatMap((contribution) =>
        contribution.claimIds.map((claimId) => ({ claimId, family: contribution.family })),
      ),
      judgements: person.completeness.judgements.map((judgement) => ({ ...judgement })),
    };
    const personAssignments = classifyPerson(population, classifiable, (slug, factId) => {
      const statement = corpusStatements.get(`${slug}/${factId}`);
      if (statement !== undefined) return statement;
      // Corpus drift must not silently re-label verdicts: fall back to the
      // verdict's own retained reference quote and say so in the record.
      const fallback = person.completeness.judgements.find((entry) => entry.factId === factId);
      process.stderr.write(
        `WARNING: no corpus fact for ${slug}/${factId}; citing the retained referenceQuote.\n`,
      );
      return fallback?.referenceQuote ?? null;
    });
    ambiguous += personAssignments.length;
    assignments.push(...personAssignments);
  }
  measuredPerPopulation[population] = { facts, ambiguous };
}

const summary = summarizeAssignments(assignments);
const generatedAt = new Date().toISOString();
const payload = {
  schemaVersion: 1 as const,
  generatedAt,
  corpusVersion: corpus.version,
  corpusDir,
  inputs,
  measuredPerPopulation,
  summary,
  causes: AMBIGUITY_CAUSES,
  assignments,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "classification.json"), `${JSON.stringify(payload, null, 2)}\n`);

const lines: string[] = [];
lines.push(`# Ambiguous semantic verdict classification — ${generatedAt.slice(0, 10)}`);
lines.push(``);
lines.push(
  `Every ambiguous verdict in the retained populations, each assigned one named cause. ` +
    `Causes that cannot be decided from retained evidence are explicitly undetermined.`,
);
lines.push(``);
lines.push(`## Inputs (read-only; sha256 recorded before parsing)`);
lines.push(``);
for (const input of inputs) {
  const measured = measuredPerPopulation[input.population] ?? { facts: 0, ambiguous: 0 };
  lines.push(
    `- **${input.population}**: \`${input.reportPath}\` sha256 \`${input.sha256}\` — ` +
      `${String(measured.ambiguous)} ambiguous of ${String(measured.facts)} facts`,
  );
}
lines.push(``);
lines.push(
  `Corpus \`${corpusDir}\` version \`${corpus.version}\` (reference-fact citations only).`,
);
lines.push(``);
lines.push(`## Counts per cause per population`);
lines.push(``);
lines.push(`| Cause | ${populations.join(" | ")} | Total |`);
lines.push(`| --- | ${populations.map(() => "---").join(" | ")} | --- |`);
for (const cause of AMBIGUITY_CAUSES) {
  const cells = populations.map((population) =>
    String(summary.perCausePerPopulation[population]?.[cause] ?? 0),
  );
  cells.push(String(summary.perCause[cause] ?? 0));
  lines.push(`| ${cause} | ${cells.join(" | ")} |`);
}
lines.push(``);
lines.push(`Total ambiguous verdicts classified: ${String(summary.total)}.`);
lines.push(``);
lines.push(`## Example assignments`);
lines.push(``);
for (const cause of AMBIGUITY_CAUSES) {
  const example = assignments.find((assignment) => assignment.cause === cause);
  if (!example) {
    lines.push(`### ${cause} (0 assignments)`);
    lines.push(``);
    continue;
  }
  lines.push(`### ${cause}`);
  lines.push(``);
  lines.push(
    `- ${example.personSlug}/${example.factId} (${example.population}): ` +
      `claim=${example.claimId ?? "null"}, ` +
      `evidence=${JSON.stringify(example.evidenceQuote ?? null)}, ` +
      `reference=${JSON.stringify(example.referenceQuote.slice(0, 120))}`,
  );
  for (const basis of example.basis) lines.push(`  - ${basis}`);
  lines.push(`  - Fix: ${example.downstreamFix}`);
  lines.push(``);
}
writeFileSync(join(outDir, "classification.md"), `${lines.join("\n")}\n`);

process.stdout.write(
  `Classified ${String(summary.total)} ambiguous verdicts across ${String(inputs.length)} populations.\n`,
);
for (const [population, measured] of Object.entries(measuredPerPopulation))
  process.stdout.write(
    `  ${population}: ${String(measured.ambiguous)} of ${String(measured.facts)}\n`,
  );
process.stdout.write(
  `Wrote ${join(outDir, "classification.json")} and ${join(outDir, "classification.md")}\n`,
);
