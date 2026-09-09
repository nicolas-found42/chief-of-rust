import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BenchmarkPersonArtifactSchema,
  BenchmarkReportSchema,
  type BenchmarkPersonArtifact,
} from "@chief-of-staff-demo/shared";
import { loadReusable } from "../../../apps/server/src/person-benchmark/resume.js";

const FIXTURE =
  "../../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.json";

const CONDITIONS = {
  mode: "fixed-documents",
  researchProvider: "openrouter",
  researchModel: "acme/tiny",
  promptVersion: "2026-09-06.4",
  reasoningEffort: "low",
  judgeReasoningEffort: "high",
  corpusVersion: "41d616ea8dfb1786",
  pipeline: "expanded",
  judgeProvider: "openrouter",
  judgeModel: "acme/tiny",
  judgeVersion: "2026-09-06.10",
  referenceVersions: {},
} as const;

/** A valid artifact built from the committed fixture's first person, shaped
 *  by a mutator so nested records stay complete and schema-valid. */
function artifact(
  mutate: (candidate: BenchmarkPersonArtifact) => void = () => {},
): BenchmarkPersonArtifact {
  const report = BenchmarkReportSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL(FIXTURE, import.meta.url)), "utf8")),
  );
  const candidate: BenchmarkPersonArtifact = {
    schemaVersion: 1,
    runId: "armstats1111",
    corpusVersion: report.provenance.corpusVersion,
    pipeline: "expanded",
    judgeProvider: "openrouter",
    judgeModel: "acme/tiny",
    judgeVersion: "2026-09-06.10",
    assessedAt: "2026-09-08T12:00:00.000Z",
    conditions: { ...CONDITIONS },
    result: structuredClone(report.people[0]),
  };
  mutate(candidate);
  return BenchmarkPersonArtifactSchema.parse(candidate);
}

function completed(candidate: BenchmarkPersonArtifact): void {
  candidate.result.failure = null;
  candidate.result.operational = { ...candidate.result.operational, conclusion: "completed" };
  candidate.result.assessment = {
    operationId: "op-1",
    integrity: "completed",
    judge: "completed",
  };
}

function writeArtifacts(dir: string, artifacts: BenchmarkPersonArtifact[]): void {
  for (const [index, entry] of artifacts.entries())
    writeFileSync(
      join(dir, `fixed-documents-expanded-run0000-p${String(index)}.person.json`),
      `${JSON.stringify(entry)}\n`,
    );
}

it("carries a person whose research and assessment both completed under matching conditions", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    writeArtifacts(dir, [artifact(completed)]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(1);
    expect(reuse.mismatched).toEqual([]);
    expect(reuse.unstamped).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses to carry interrupted, failed, or unassessed research", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    writeArtifacts(dir, [
      artifact((candidate) => {
        completed(candidate);
        candidate.result.operational.conclusion = "interrupted";
      }),
      artifact((candidate) => {
        completed(candidate);
        candidate.result.failure = "Research ran out of calls.";
      }),
      artifact((candidate) => {
        candidate.result.failure = null;
        candidate.result.assessment = {
          operationId: "op-1",
          integrity: "completed",
          judge: "failed",
        };
      }),
    ]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("judges the latest assessment per slug: a superseded mismatch no longer refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    const superseded = artifact((candidate) => {
      completed(candidate);
      candidate.assessedAt = "2026-09-08T10:00:00.000Z";
      candidate.conditions = { ...candidate.conditions!, researchModel: "acme/old" };
    });
    const latest = artifact((candidate) => {
      completed(candidate);
      candidate.assessedAt = "2026-09-08T12:00:00.000Z";
    });
    writeArtifacts(dir, [superseded, latest]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(1);
    expect(reuse.mismatched).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("carries the original when the newest artifact is only a reassessment", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    const original = artifact((candidate) => {
      completed(candidate);
      candidate.assessedAt = "2026-09-08T10:00:00.000Z";
    });
    const reassessment = artifact((candidate) => {
      candidate.assessedAt = "2026-09-08T12:00:00.000Z";
      candidate.reassessmentOf = "priorrun000000";
    });
    writeArtifacts(dir, [original, reassessment]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(1);
    expect(reuse.mismatched).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses on the latest assessment alone when it mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    const matching = artifact((candidate) => {
      completed(candidate);
      candidate.assessedAt = "2026-09-08T10:00:00.000Z";
    });
    const latest = artifact((candidate) => {
      completed(candidate);
      candidate.assessedAt = "2026-09-08T12:00:00.000Z";
      candidate.conditions = { ...candidate.conditions!, researchModel: "acme/old" };
    });
    writeArtifacts(dir, [matching, latest]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(0);
    expect(reuse.mismatched.map((entry) => entry.field)).toEqual(["researchModel"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reports a conditions mismatch field by field instead of carrying the artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    writeArtifacts(dir, [
      artifact((candidate) => {
        completed(candidate);
        candidate.conditions = { ...CONDITIONS, researchModel: "acme/small" };
      }),
    ]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(0);
    expect(reuse.mismatched).toEqual([
      {
        slug: artifact().result.slug,
        field: "researchModel",
        prior: "acme/small",
        current: "acme/tiny",
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("lists unstamped artifacts separately rather than carrying or refusing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    writeArtifacts(dir, [
      artifact((candidate) => {
        completed(candidate);
        candidate.conditions = undefined;
      }),
    ]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(0);
    expect(reuse.mismatched).toEqual([]);
    expect(reuse.unstamped).toEqual([artifact().result.slug]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("ignores reassessed artifacts: the original run is the reuse source", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    writeArtifacts(dir, [
      artifact((candidate) => {
        completed(candidate);
        candidate.reassessmentOf = "someearlierrun";
      }),
    ]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(0);
    expect(reuse.unstamped).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps the latest assessment when one person appears in several runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    const earlier = artifact((candidate) => {
      completed(candidate);
      candidate.assessedAt = "2026-09-08T10:00:00.000Z";
      candidate.result.factualReliability.verifiedCitations = 1;
    });
    const later = artifact((candidate) => {
      completed(candidate);
      candidate.assessedAt = "2026-09-08T11:00:00.000Z";
      candidate.result.factualReliability.verifiedCitations = 2;
    });
    writeArtifacts(dir, [earlier, later]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(1);
    expect(reuse.eligible.get(later.result.slug)!.result.factualReliability.verifiedCitations).toBe(
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("compares a recorded seed as part of the run recipe", () => {
  const dir = mkdtempSync(join(tmpdir(), "benchmark-resume-"));
  try {
    writeArtifacts(dir, [
      artifact((candidate) => {
        completed(candidate);
        candidate.conditions = { ...CONDITIONS, seed: 7 };
      }),
    ]);
    const reuse = loadReusable(dir, CONDITIONS);
    expect(reuse.eligible.size).toBe(0);
    expect(reuse.mismatched[0]?.field).toBe("seed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
