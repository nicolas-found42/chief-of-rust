import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BenchmarkReportSchema, type BenchmarkReport } from "@chief-of-staff-demo/shared";
import {
  buildArmStats,
  compareArmStats,
  renderArmStats,
  renderStatsComparison,
} from "../../../apps/server/src/person-benchmark/arm-stats.js";

const FIXTURE =
  "../../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.json";

/** The committed fixture report with deterministic, hand-checkable scores:
 *  100 reference facts per person, recovery fraction set per person in file
 *  order. */
function scoredReport(scores: number[]): BenchmarkReport {
  const report = BenchmarkReportSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL(FIXTURE, import.meta.url)), "utf8")),
  );
  /* Denominator 128 keeps every fixture score a dyadic rational, so the
     zero-spread and exact-mean cases are float-exact, not float-lucky. */
  for (const [index, person] of report.people.entries())
    person.completeness = {
      ...person.completeness,
      referenceFacts: 128,
      recovered: Math.round(scores[index] * 128),
    };
  /* The driver stamps status and execution on every report it writes; the
     pre-standard fixture is a failed run without execution, so mirror the
     driver here — tests opt back out explicitly when they need otherwise. */
  report.status = "completed";
  report.execution = {
    status: "completed",
    selected: report.selection.requested,
    evaluated: report.people.length,
    assessed: report.people.length,
    scenarioIds: [],
  };
  return report;
}

function armDirectory(label: string, reports: Record<string, BenchmarkReport>): string {
  const dir = mkdtempSync(join(tmpdir(), `benchmark-armstats-${label}-`));
  for (const [name, report] of Object.entries(reports))
    writeFileSync(join(dir, name), `${JSON.stringify(report)}\n`);
  return dir;
}

const SINGLE = "fixed-documents-expanded-armstats1111.json";
const R1 = "fixed-documents-expanded-armstats2222-r1.json";
const R2 = "fixed-documents-expanded-armstats2222-r2.json";

it("reads one report as a single-repeat arm with per-person recovery fractions", () => {
  const report = scoredReport([0.25, 0.75]);
  const dir = armDirectory("one", { [SINGLE]: report });
  try {
    const stats = buildArmStats(dir)!;
    expect(stats).not.toBeNull();
    expect(stats.repeats).toBe(1);
    expect(stats.runIds).toEqual([report.runId]);
    expect(stats.people.map((person) => person.scores)).toEqual([[0.25], [0.75]]);
    // sd(0.25,0.75) = 0.3535534, se = 0.25, half-width = 0.489991
    expect(stats.ci.mean).toBeCloseTo(0.5, 10);
    expect(stats.ci.lo).toBeCloseTo(0.010009, 6);
    expect(stats.ci.hi).toBeCloseTo(0.989991, 6);
    expect(stats.totals).toEqual({ referenceFacts: 256, recoveredMean: 128, rate: 0.5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("pairs repeat reports by their -rN suffix and averages per person", () => {
  const dir = armDirectory("two", {
    [R1]: scoredReport([0.25, 0.75]),
    [R2]: scoredReport([0.75, 0.25]),
  });
  try {
    const stats = buildArmStats(dir)!;
    expect(stats.repeats).toBe(2);
    expect(stats.people[0].scores).toEqual([0.25, 0.75]);
    expect(stats.people[0].mean).toBeCloseTo(0.5, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("counts only completed reports as repeats: an interrupted repeat stays out", () => {
  const interrupted = scoredReport([0.5]);
  interrupted.execution = {
    status: "interrupted",
    selected: interrupted.selection.requested,
    evaluated: 1,
    assessed: 1,
    scenarioIds: [],
  };
  interrupted.people = [interrupted.people[0]];
  const dir = armDirectory("interrupted", {
    [R1]: scoredReport([0.25, 0.75]),
    [R2]: interrupted,
  });
  try {
    const stats = buildArmStats(dir)!;
    expect(stats).not.toBeNull();
    expect(stats.repeats).toBe(1);
    expect(stats.people.map((person) => person.scores)).toEqual([[0.25], [0.75]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("includes a finished pass with person failures as a repeat, but surfaces it", () => {
  const failed = scoredReport([0.5, 0.5]);
  failed.status = "failed";
  const dir = armDirectory("failed", {
    [R1]: scoredReport([0.25, 0.75]),
    [R2]: failed,
  });
  try {
    const stats = buildArmStats(dir)!;
    expect(stats.repeats).toBe(2);
    expect(stats.partialRepeats).toBe(1);
    expect(renderArmStats(stats)).toContain(
      "Warning: 1 of 2 repeat report(s) recorded person-level failures",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("returns null when the newest arm holds no completed report", () => {
  const interrupted = scoredReport([0.5, 0.5]);
  interrupted.execution = {
    status: "interrupted",
    selected: interrupted.selection.requested,
    evaluated: 2,
    assessed: 2,
    scenarioIds: [],
  };
  const dir = armDirectory("allinterrupted", { [R1]: interrupted });
  try {
    expect(buildArmStats(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("treats the newest run id as the arm and ignores older runs beside it", () => {
  const older = scoredReport([0.25, 0.75]);
  older.runId = "olderaaa00000001";
  older.provenance.finishedAt = "2026-09-08T08:00:00.000Z";
  const newer1 = scoredReport([0.5, 0.5]);
  newer1.runId = "newerbbb00000002";
  newer1.provenance.finishedAt = "2026-09-08T09:00:00.000Z";
  const newer2 = scoredReport([0.75, 0.25]);
  newer2.runId = "newerbbb00000002";
  newer2.provenance.finishedAt = "2026-09-08T09:30:00.000Z";
  /* A retried arm writes its fresh run beside the interrupted one: one old
     single report and two -rN reports of the new run share the directory. */
  const dir = armDirectory("mixed", {
    "fixed-documents-expanded-olderrun01.json": older,
    [R1]: newer1,
    [R2]: newer2,
  });
  try {
    const stats = buildArmStats(dir)!;
    expect(stats.repeats).toBe(2);
    expect(stats.runIds).toEqual(["newerbbb00000002", "newerbbb00000002"]);
    expect(stats.people[0].scores).toEqual([0.5, 0.75]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("skips files that are not arm reports and returns null for a report-less directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-armstats-empty-"));
  try {
    writeFileSync(join(dir, "comparison.json"), "{}\n");
    writeFileSync(join(dir, "some-person.json"), "{}\n");
    writeFileSync(join(dir, "stats.json"), "{}\n");
    expect(buildArmStats(dir)).toBeNull();
    expect(readdirSync(dir)).toHaveLength(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("renders the arm's interval and detectable-effect bar", () => {
  const dir = armDirectory("render", { [SINGLE]: scoredReport([0.25, 0.75]) });
  try {
    const rendered = renderArmStats(buildArmStats(dir)!);
    expect(rendered).toContain("0.5000");
    expect(rendered).toContain("95% CI");
    expect(rendered).toContain("detect");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("compares two arms on their paired per-person differences", () => {
  const baselineDir = armDirectory("base", { [SINGLE]: scoredReport([0.25, 0.75]) });
  const candidateDir = armDirectory("cand", { [SINGLE]: scoredReport([0.3125, 0.8125]) });
  try {
    const comparison = compareArmStats(buildArmStats(baselineDir)!, buildArmStats(candidateDir)!);
    // diffs 0.0625 on every person: zero spread, so the bar is gone entirely.
    expect(comparison.paired.z).toBeNull();
    const rendered = renderStatsComparison(comparison);
    expect(rendered).toContain("paired");
  } finally {
    rmSync(baselineDir, { recursive: true, force: true });
    rmSync(candidateDir, { recursive: true, force: true });
  }
});

it("calls a small ragged delta noise and says so in plain words", () => {
  const baselineDir = armDirectory("noisy-base", { [SINGLE]: scoredReport([0.25, 0.75]) });
  const candidateDir = armDirectory("noisy-cand", {
    [SINGLE]: scoredReport([0.375, 0.625]),
  });
  try {
    const comparison = compareArmStats(buildArmStats(baselineDir)!, buildArmStats(candidateDir)!);
    expect(comparison.verdict).toBe("noise");
    expect(comparison.paired.z).not.toBeNull();
    expect(Math.abs(comparison.paired.z!)).toBeLessThan(2);
    expect(renderStatsComparison(comparison)).toContain("not distinguishable from noise");
  } finally {
    rmSync(baselineDir, { recursive: true, force: true });
    rmSync(candidateDir, { recursive: true, force: true });
  }
});
