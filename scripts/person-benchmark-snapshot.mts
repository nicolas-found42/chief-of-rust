import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BenchmarkPersonSchema } from "../packages/shared/src/index.js";
import { readPersonSource } from "../apps/server/src/person-profile/research-readers.js";
import { ResearchAttemptRecorder } from "../apps/server/src/person-profile/research-diagnostics.js";
import { publicHttpFetch, publicHttpFetchBytes } from "../apps/server/src/source-adapters/http.js";
import { playwrightBrowserRenderer } from "../apps/server/src/source-adapters/browser.js";
import { validateReference } from "../apps/server/src/person-benchmark/corpus.js";

/**
 * Retain the reference excerpts a Benchmark Person's facts are judged against.
 *
 * The tool does exactly one thing: fetch the source a reference file already
 * names, keep a bounded excerpt of it, and hash what it kept. It never writes,
 * edits or infers a fact — authoring a reference is a human reading a source,
 * and a tool that could fill facts in would be generating the benchmark from
 * the thing it is meant to measure.
 *
 *   pnpm exec tsx scripts/person-benchmark-snapshot.mts [--slug <slug>] [--force]
 *
 * `--force` re-fetches documents that already carry an excerpt. Without it, a
 * retained excerpt is left exactly as it was: excerpts are immutable within a
 * reference version, and a re-fetch that changed one silently would invalidate
 * every fact quoting it.
 */

const PEOPLE_DIR = "benchmark/person-research/people";
const EXCERPT_LIMIT = 6000;

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const force = process.argv.includes("--force");
const only = arg("slug");

if (!existsSync(PEOPLE_DIR)) mkdirSync(PEOPLE_DIR, { recursive: true });

const files = (await import("node:fs")).readdirSync(PEOPLE_DIR).filter((f) => f.endsWith(".json"));
let fetched = 0;
let failed = 0;

for (const file of files) {
  const slug = file.replace(/\.json$/, "");
  if (only && slug !== only) continue;
  const path = join(PEOPLE_DIR, file);
  const person = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
    documents: {
      id: string;
      url: string;
      excerpt?: string;
      hash?: string;
      retrievedAt?: string;
    }[];
  };
  let changed = false;
  for (const document of person.documents) {
    if (document.excerpt && !force) continue;
    const recorder = new ResearchAttemptRecorder(`snapshot-${slug}`);
    const read = await readPersonSource(document.url, "", {
      fetch: publicHttpFetch,
      fetchBytes: publicHttpFetchBytes,
      render: playwrightBrowserRenderer(),
      recorder,
      timeoutMs: 30_000,
    });
    if (read.access !== "retrieved" || read.text.trim().length < 200) {
      failed += 1;
      process.stderr.write(
        `FAILED ${slug}/${document.id} ${document.url}\n  ${recorder
          .failures()
          .map((attempt) => `${attempt.code}: ${attempt.reason}`)
          .join("\n  ")}\n`,
      );
      continue;
    }
    const excerpt = read.text.replace(/\s+\n/g, "\n").trim().slice(0, EXCERPT_LIMIT);
    document.excerpt = excerpt;
    document.hash = createHash("sha256").update(excerpt).digest("hex");
    document.retrievedAt = new Date().toISOString();
    changed = true;
    fetched += 1;
    process.stdout.write(
      `retained ${slug}/${document.id} ${String(excerpt.length)} chars via ${read.route}\n`,
    );
  }
  if (changed) writeFileSync(path, `${JSON.stringify(person, null, 2)}\n`);
  const parsed = BenchmarkPersonSchema.safeParse(person);
  if (!parsed.success) {
    process.stderr.write(`INVALID ${slug}: ${parsed.error.issues[0]?.message ?? "schema error"}\n`);
    continue;
  }
  const problems = validateReference(parsed.data);
  for (const problem of problems) process.stderr.write(`PROBLEM ${slug}: ${problem}\n`);
}

process.stdout.write(`\nretained ${String(fetched)} excerpts, ${String(failed)} failures\n`);
process.exit(failed ? 1 : 0);
