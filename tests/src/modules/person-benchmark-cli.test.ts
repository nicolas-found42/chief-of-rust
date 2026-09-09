import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BenchmarkArmStatsSchema,
  BenchmarkReportSchema,
  BenchmarkPersonArtifactSchema,
  type BenchmarkReport,
} from "@chief-of-staff-demo/shared";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus";

it("rejects unknown requested people without writing a successful empty report", () => {
  const output = mkdtempSync(join(tmpdir(), "benchmark-invalid-selection-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--people",
        "definitely-unknown",
        "--out",
        output,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown Benchmark Person: definitely-unknown");
    expect(readdirSync(output)).toEqual([]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

it("refuses a rejected corpus instead of evaluating its remaining entries", () => {
  const corpus = mkdtempSync(join(tmpdir(), "benchmark-invalid-corpus-"));
  const output = mkdtempSync(join(tmpdir(), "benchmark-invalid-output-"));
  try {
    writeFileSync(join(corpus, "broken.json"), "{}");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--corpus",
        corpus,
        "--out",
        output,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Benchmark corpus contains rejected entries");
    expect(readdirSync(output)).toEqual([]);
  } finally {
    rmSync(corpus, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

it.each([
  { args: [], error: "Benchmark selection is empty" },
  { args: ["--people", ""], error: "--people must select at least one person" },
  { args: ["--limit", "0"], error: "--limit must be a positive integer" },
  { args: ["--limit", "-1"], error: "--limit must be a positive integer" },
  { args: ["--limit", "no"], error: "--limit must be a positive integer" },
])("rejects invalid selection: $error", ({ args, error }) => {
  const corpus = mkdtempSync(join(tmpdir(), "benchmark-empty-corpus-"));
  const output = mkdtempSync(join(tmpdir(), "benchmark-empty-output-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--corpus",
        corpus,
        "--out",
        output,
        ...args,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(readdirSync(output)).toEqual([]);
  } finally {
    rmSync(corpus, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

it("records a valid limited subset as intentional and preserves its failed evaluation", () => {
  const output = mkdtempSync(join(tmpdir(), "benchmark-limited-"));
  try {
    const config = join(output, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner,ana-botin",
        "--limit",
        "1",
        "--out",
        output,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    const reportFile = readdirSync(output).find(
      (file) =>
        file.startsWith("fixed-documents-") &&
        file.endsWith(".json") &&
        !file.endsWith(".operation.json") &&
        !file.endsWith(".person.json"),
    )!;
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(join(output, reportFile), "utf8")),
    );
    expect(report.selection).toEqual({
      requested: ["achim-steiner", "ana-botin"],
      evaluated: ["achim-steiner"],
      skipped: [{ slug: "ana-botin", reason: "Excluded by --limit." }],
    });
    expect(report.status).toBe("failed");
    expect(report.execution).toMatchObject({
      status: "completed",
      selected: ["achim-steiner"],
      evaluated: 1,
      assessed: 0,
    });
    expect(report.people[0]?.assessment?.judge).toBe("failed");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

it("records all default corpus members excluded by --limit without an explicit --people list", () => {
  const output = mkdtempSync(join(tmpdir(), "benchmark-default-limit-"));
  try {
    const config = join(output, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--limit",
        "1",
        "--out",
        output,
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    const file = readdirSync(output).find(
      (name) =>
        name.startsWith("fixed-documents-") &&
        name.endsWith(".json") &&
        !name.endsWith(".operation.json") &&
        !name.endsWith(".person.json"),
    )!;
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(join(output, file), "utf8")),
    );
    expect(report.selection.requested).toHaveLength(30);
    expect(report.selection.evaluated).toHaveLength(1);
    expect(report.selection.skipped).toEqual(
      report.selection.requested
        .filter((slug) => !report.selection.evaluated.includes(slug))
        .map((slug) => ({ slug, reason: "Excluded by --limit." })),
    );
    expect(report.selection.skipped).toHaveLength(29);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

it.each([
  {
    args: ["--mode", "live-discovery", "--concurrency", "0"],
    error: "--concurrency must be a positive integer",
  },
  {
    args: ["--mode", "live-discovery", "--concurrency", "5"],
    error: "--concurrency must be an integer from 1 to 4",
  },
  {
    args: ["--mode", "live-discovery", "--concurrency", "1.5"],
    error: "--concurrency must be a positive integer",
  },
  /* Fixed-document mode researches people concurrently now: each person runs
     through its own composition over per-profile keyed stores, so parallel
     people touch disjoint files and share only process-wide route rests
     (#233). There is no fixed-documents concurrency case left to reject. */
])("rejects unsafe benchmark concurrency: $args", ({ args, error }) => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/person-research-benchmark.mts", ...args],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(error);
});

it("retains public evidence without credentials and produces a separately reassessable artifact", () => {
  const output = mkdtempSync(join(tmpdir(), "benchmark-retained-evidence-"));
  try {
    const config = join(output, "config.json");
    writeFileSync(
      config,
      JSON.stringify({ provider: "mock", model: "mock", apiKey: "fixture-secret-never-copy" }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner",
        "--retain-evidence",
        "--out",
        output,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1); // Mock judging fails honestly, evidence remains usable.
    const files = readdirSync(output);
    const evidence = join(
      output,
      files.find((file) => file.endsWith(".evidence"))!,
    );
    expect(readdirSync(evidence)).not.toContain("config.json");
    const manifest = JSON.parse(readFileSync(join(evidence, "snapshot-manifest.json"), "utf8")) as {
      completedOperationIds: string[];
    };
    const reportFile = files.find(
      (file) =>
        file.endsWith(".json") &&
        file !== "config.json" &&
        !file.endsWith(".operation.json") &&
        !file.endsWith(".person.json"),
    )!;
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(join(output, reportFile), "utf8")),
    );
    expect(report.provenance.researchSettings.operationConcurrency).toBe(1);
    expect(report.evidenceBundleHash).toMatch(/^[a-f0-9]{64}$/);
    const personFile = files.find((file) => file.endsWith(".person.json"))!;
    const personArtifact = BenchmarkPersonArtifactSchema.parse(
      JSON.parse(readFileSync(join(output, personFile), "utf8")),
    );
    expect(personArtifact.runId).toBe(report.runId);
    expect(personArtifact.result).toEqual(report.people[0]);
    expect(personArtifact.result.assessment?.phases).toMatchObject({
      reference: { status: "failed" },
      support: { status: "not-attempted" },
    });
    expect(result.stderr).toContain(
      "judge failed (reference failed, support/usefulness not-attempted)",
    );
    expect(result.stderr).toContain("credited recovery 0/");

    expect(manifest.completedOperationIds).toEqual([report.people[0].assessment!.operationId]);
    const reassessed = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--reassess",
        join(output, reportFile),
        "--evidence-workspace",
        evidence,
        "--config",
        config,
        "--out",
        join(output, "reassessed"),
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(reassessed.status, reassessed.stderr).toBe(1);
    expect(reassessed.stdout).toContain("no research was repeated");
    const reassessedPerson = readdirSync(join(output, "reassessed")).find((file) =>
      file.endsWith(".person.json"),
    )!;
    const reassessedArtifact = BenchmarkPersonArtifactSchema.parse(
      JSON.parse(readFileSync(join(output, "reassessed", reassessedPerson), "utf8")),
    );
    expect(reassessedArtifact.reassessmentOf).toBe(report.runId);
    expect(reassessedArtifact.result.assessment?.judge).toBe("failed");
    expect(reassessed.stderr).toContain(
      "judge failed (reference failed, support/usefulness not-attempted)",
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

/* ---- Standardized-arm wiring: resume, repeats, stats, cost (issue #237) ---- */

import { BenchmarkStatsComparisonSchema } from "@chief-of-staff-demo/shared";

/** An eligible, conditions-stamped artifact for `achim-steiner` under the mock
 *  provider, so --retry can carry it without spending a model call. */
function eligibleArtifact() {
  /* Structural conditions (corpus version et al.) must match the corpus the
     driver actually loads, so stamp from the live corpus, not the fixture. */
  const corpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const report = BenchmarkReportSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
  const person = structuredClone(report.people[0]);
  person.failure = null;
  person.operational = { ...person.operational, conclusion: "completed" };
  person.assessment = { operationId: "op-carried", integrity: "completed", judge: "completed" };
  return BenchmarkPersonArtifactSchema.parse({
    schemaVersion: 1,
    runId: "priorarm000000",
    corpusVersion: corpus.version,
    pipeline: "expanded",
    judgeProvider: "mock",
    judgeModel: "mock",
    judgeVersion: "2026-09-06.10",
    assessedAt: "2026-09-08T09:00:00.000Z",
    conditions: {
      mode: "fixed-documents",
      researchProvider: "mock",
      researchModel: "mock",
      promptVersion: "2026-09-06.4",
      reasoningEffort: "low",
      judgeReasoningEffort: "high",
    },
    result: person,
  });
}

it("--retry carries an eligible person and re-runs only the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cli-retry-"));
  try {
    writeFileSync(
      join(dir, "fixed-documents-expanded-priorarm000000-achim-steiner.person.json"),
      `${JSON.stringify(eligibleArtifact())}\n`,
    );
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner,ana-botin",
        "--retry",
        dir,
        "--out",
        dir,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    const reportFile = readdirSync(dir).find(
      (file) =>
        file.includes("-retry") === false &&
        /^fixed-documents-expanded-[0-9a-f]+\.json$/.test(file),
    )!;
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(join(dir, reportFile), "utf8")),
    );
    expect(report.resume).toEqual({
      carriedPeople: ["achim-steiner"],
      retriedPeople: ["ana-botin"],
    });
    expect(report.people.map((person) => person.slug)).toEqual(["achim-steiner", "ana-botin"]);
    expect(report.people[0].assessment!.operationId).toBe("op-carried");
    expect(report.provenance.researchSettings.gitSha).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("--retry with --repeats 2 records carried people once: later repeats sample everyone fresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cli-retry-repeats-"));
  try {
    writeFileSync(
      join(dir, "fixed-documents-expanded-priorarm000000-achim-steiner.person.json"),
      `${JSON.stringify(eligibleArtifact())}\n`,
    );
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner,ana-botin",
        "--retry",
        dir,
        "--repeats",
        "2",
        "--out",
        dir,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    const read = (suffix: string): BenchmarkReport =>
      BenchmarkReportSchema.parse(
        JSON.parse(
          readFileSync(
            join(
              dir,
              readdirSync(dir).find((file) => file.endsWith(suffix))!,
            ),
            "utf8",
          ),
        ),
      );
    const r1 = read("-r1.json");
    const r2 = read("-r2.json");
    for (const report of [r1, r2]) {
      const slugs = report.people.map((person) => person.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect([...slugs].sort()).toEqual(["achim-steiner", "ana-botin"]);
    }
    expect(
      r1.people.find((person) => person.slug === "achim-steiner")!.assessment!.operationId,
    ).toBe("op-carried");
    expect(
      r2.people.find((person) => person.slug === "achim-steiner")!.assessment!.operationId,
    ).not.toBe("op-carried");
    const stats = BenchmarkArmStatsSchema.parse(
      JSON.parse(readFileSync(join(dir, "stats.json"), "utf8")),
    );
    expect(stats.people.map((person) => person.scores)).toEqual([
      [expect.any(Number), expect.any(Number)],
      [expect.any(Number), expect.any(Number)],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("--retry refuses a stamped artifact from a different run recipe", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cli-mismatch-"));
  try {
    const artifact = eligibleArtifact();
    const mixed = {
      ...artifact,
      conditions: { ...artifact.conditions!, researchModel: "acme/different" },
    };
    writeFileSync(
      join(dir, "fixed-documents-expanded-priorarm000000-achim-steiner.person.json"),
      `${JSON.stringify(mixed)}\n`,
    );
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner",
        "--retry",
        dir,
        "--out",
        dir,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("researchModel");
    expect(
      readdirSync(dir).filter(
        (file) =>
          file.endsWith(".json") && !file.endsWith(".person.json") && file !== "config.json",
      ),
    ).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("--repeats 2 writes one report per repeat plus arm statistics", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cli-repeats-"));
  try {
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner,ana-botin",
        "--repeats",
        "2",
        "--out",
        dir,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    const repeatReports = readdirSync(dir).filter((file) => /-r[12]\.json$/.test(file));
    expect(repeatReports).toHaveLength(2);
    for (const file of repeatReports)
      expect(
        BenchmarkReportSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8"))).provenance
          .researchSettings.repeats,
      ).toBe(2);
    const stats = BenchmarkArmStatsSchema.parse(
      JSON.parse(readFileSync(join(dir, "stats.json"), "utf8")),
    );
    expect(stats.repeats).toBe(2);
    expect(stats.people.map((person) => person.scores)).toEqual([
      [expect.any(Number), expect.any(Number)],
      [expect.any(Number), expect.any(Number)],
    ]);
    expect(readFileSync(join(dir, "stats.md"), "utf8")).toContain("95% CI");
    // A second opinion pass over the same directory reproduces the same stats.
    const again = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/person-research-benchmark.mts", "--stats", dir],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(again.stdout).toContain("95% CI");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("--compare-stats pairs two arm statistics files and warns inside the noise band", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cli-compare-stats-"));
  try {
    const person = {
      slug: "achim-steiner",
      scores: [0.25, 0.75],
      mean: 0.5,
    };
    const arm = (runId: string, mean: number) => ({
      schemaVersion: 1,
      runIds: [runId],
      mode: "fixed-documents",
      pipeline: "expanded",
      repeats: 2,
      people: [person, { slug: "ana-botin", scores: [mean, mean], mean }],
      ci: { mean, se: 0.1, lo: mean - 0.196, hi: mean + 0.196 },
      totals: { referenceFacts: 256, recoveredMean: mean * 256, rate: mean },
    });
    writeFileSync(join(dir, "baseline.json"), `${JSON.stringify(arm("base0000000", 0.5))}\n`);
    writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(arm("cand0000000", 0.52))}\n`);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--compare-stats",
        join(dir, "baseline.json"),
        join(dir, "candidate.json"),
        "--out",
        dir,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(result.stdout).toContain("paired");
    const comparison = BenchmarkStatsComparisonSchema.parse(
      JSON.parse(readFileSync(join(dir, "stats-comparison.json"), "utf8")),
    );
    expect(comparison.sharedPeople).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("--seed is recorded and a non-integer seed is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-cli-seed-"));
  try {
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--people",
        "achim-steiner",
        "--seed",
        "7",
        "--out",
        dir,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    const reportFile = readdirSync(dir).find((file) =>
      /^fixed-documents-expanded-[0-9a-f]+\.json$/.test(file),
    )!;
    const report = BenchmarkReportSchema.parse(
      JSON.parse(readFileSync(join(dir, reportFile), "utf8")),
    );
    expect(report.provenance.researchSettings.seed).toBe(7);
    const bad = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/person-research-benchmark.mts",
        "--config",
        config,
        "--seed",
        "1.5",
        "--out",
        join(dir, "nope"),
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--seed must be a non-negative integer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
