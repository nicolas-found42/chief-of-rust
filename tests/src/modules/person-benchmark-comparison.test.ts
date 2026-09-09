import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BenchmarkReportSchema } from "@chief-of-staff-demo/shared";
import {
  compareReports,
  renderComparison,
  renderReport,
} from "../../../apps/server/src/person-benchmark/report";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus";

/** Historical failed smoke data stays failed; these controlled assessments are test-only. */
function assessedReport() {
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
  report.execution = {
    status: "completed",
    selected: report.people.map((person) => person.slug),
    evaluated: report.people.length,
    assessed: report.people.length,
    scenarioIds: [],
  };
  for (const person of report.people)
    person.assessment = {
      operationId: `controlled-${person.slug}`,
      integrity: "completed",
      judge: "completed",
    };
  report.collection = [];
  return report;
}

it("compares fully assessed failed research without converting the run to success", () => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  baseline.people[0].operational.conclusion = "bounded";
  candidate.people[0].operational.conclusion = "completed";
  candidate.people[0].completeness.recovered += 1;
  const comparison = compareReports(baseline, candidate);
  expect(comparison.comparable).toBe(true);
  expect(comparison.verdict).toBe("improved");
  expect(baseline.status).toBe("failed");
  expect(comparison.operational.baselineStatus).toBe("failed");
  expect(comparison.perPerson[0]).toMatchObject({
    baselineConclusion: "bounded",
    candidateConclusion: "completed",
  });
  expect(renderComparison(comparison)).toContain("Research outcomes");
  expect(renderComparison(comparison)).toContain("failed");
});

it("excludes support-incomplete pairs from the recovery verdict and names the exclusion", () => {
  const baseline = assessedReport();
  for (const person of baseline.people)
    person.assessment!.phases = {
      reference: { status: "completed", failure: null, judgements: [] },
      support: { status: "completed", failure: null, unresolvedFindings: [] },
    };
  const candidate = structuredClone(baseline);
  for (const person of candidate.people) person.completeness.recovered += 1;
  expect(compareReports(baseline, candidate).verdict).toBe("improved");

  /* The same research delta with one support phase failed: that pair's
     recovery credit is withheld under ADR-0067, so it cannot carry the
     verdict — the measured pairs still do, and the exclusion is named (#281). */
  const withSupportFailed = structuredClone(candidate);
  withSupportFailed.people[0].assessment!.phases!.support.status = "failed";
  const comparison = compareReports(baseline, withSupportFailed);
  expect(comparison.comparable).toBe(true);
  expect(comparison.perPerson[0].candidateAssessed).toBe(false);
  expect(comparison.perPerson.slice(1).every((entry) => entry.candidateAssessed)).toBe(true);
  expect(comparison.verdict).toBe("improved");
  expect(comparison.verdictDetail).toContain("support/usefulness assessment did not complete");
  expect(comparison.verdictDetail).toContain(comparison.perPerson[0].slug);
  expect(comparison.conditionChanges.join("\n")).toContain("support/usefulness");
});

it("declares a comparison with no measured pair not comparable", () => {
  const baseline = assessedReport();
  for (const person of baseline.people)
    person.assessment!.phases = {
      reference: { status: "completed", failure: null, judgements: [] },
      support: { status: "failed", failure: null, unresolvedFindings: [] },
    };
  const candidate = structuredClone(baseline);
  const comparison = compareReports(baseline, candidate);
  expect(comparison.comparable).toBe(false);
  expect(comparison.verdict).toBe("not-comparable");
  expect(comparison.conditionChanges.join("\n")).toContain("no pair");
});

it("notes research-setting differences as condition changes without flipping comparability", () => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  baseline.provenance.researchSettings["reasoningEffort"] = "unset";
  candidate.provenance.researchSettings["reasoningEffort"] = "low";
  const comparison = compareReports(baseline, candidate);
  expect(comparison.conditionChanges.join("\n")).toContain(
    "research setting reasoningEffort: unset → low",
  );
  /* Settings differences are notes, not verdict inputs: recording a new
     routing or reasoning condition must never flip comparability by itself. */
  expect(comparison.comparable).toBe(true);
});

it("notes settings the baseline predates as absent rather than staying silent", () => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  delete baseline.provenance.researchSettings["reasoningEffort"];
  candidate.provenance.researchSettings["reasoningEffort"] = "low";
  const comparison = compareReports(baseline, candidate);
  expect(comparison.conditionChanges.join("\n")).toContain(
    "research setting reasoningEffort: absent → low",
  );
  expect(comparison.comparable).toBe(true);
});

/* Three shipped reports carried a table whose separator row had one cell
   fewer than its header (#271, #282) — markdown consumers rendered the
   columns misaligned and the missing count stayed unread. Within one table
   block, every row must carry the same cell count. */
function assertTablesWellFormed(rendered: string): void {
  let block: string[] = [];
  const check = (rows: string[]) => {
    if (rows.length < 2) return;
    for (const row of rows) {
      const trimmed = row.trim();
      if (!trimmed.startsWith("|") || !trimmed.endsWith("|"))
        throw new Error(`table row lost its outer delimiters: ${row}`);
    }
    /* A pipe is a column delimiter unless markdown-escaped: escapeCell
       renders in-cell pipes as \|, and markdown reads \| as a literal pipe
       while \\| is an escaped backslash followed by a real delimiter — so
       the decision is backslash parity, not the immediately preceding
       character. */
    const cells = rows.map((row) => {
      let delimiters = 0;
      let backslashes = 0;
      for (const character of row) {
        if (character === "\\") backslashes++;
        else {
          if (character === "|" && backslashes % 2 === 0) delimiters++;
          backslashes = 0;
        }
      }
      return delimiters - 1;
    });
    if (new Set(cells).size !== 1)
      throw new Error(`table rows disagree on cell count: ${JSON.stringify(cells)}`);
  };
  for (const line of rendered.split("\n")) {
    if (line.startsWith("|")) block.push(line);
    else {
      check(block);
      block = [];
    }
  }
  check(block);
}

it("renders every markdown table with rows of one cell count", () => {
  const report = assessedReport();
  const corpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const people = corpus.people.filter((person) => report.selection.evaluated.includes(person.slug));
  /* The conditional tables only render when the fixture carries the data:
     a collection entry for the intersections table, and judge phases —
     one failed support phase — for the per-person support-failed column. */
  report.collection = [
    {
      scenarioId: "intersection",
      assessmentStatus: "completed",
      requirement: "r18",
      categories: ["directing", "screenwriting"],
      expectedMatches: [],
      recoveredMatches: [],
      missingMatches: [],
      additionalMatchesForReview: [],
      assessments: [],
      demonstrated: [],
      claimed: [],
      coverage: {
        activeProfiles: report.people.length,
        researchedProfiles: 0,
        demonstrated: 0,
        claimedOnly: 0,
      },
      scope: "Controlled missing intersection",
    },
  ];
  for (const [index, person] of report.people.entries()) {
    const assessment = person.assessment;
    if (!assessment) throw new Error("fixture lost its assessment");
    assessment.phases = {
      reference: { status: "completed", failure: null, judgements: [] },
      support: {
        status: index === 0 ? "failed" : "completed",
        failure: null,
        unresolvedFindings: [],
      },
    };
  }
  /* Exercise the delimiter-parity path: escapeCell renders this statement's
     pipe as \| inside the remaining-misses cell, which the checker must
     read as content rather than a column delimiter. */
  report.remainingMisses[0].statement = "Statement with a | literal pipe";
  const rendered = renderReport(report, people);
  expect(rendered).toContain("\\|");
  assertTablesWellFormed(rendered);
  const candidate = structuredClone(report);
  candidate.people[0].completeness.recovered += 1;
  assertTablesWellFormed(renderReport(candidate, people));
  assertTablesWellFormed(renderComparison(compareReports(report, candidate)));
});

it("escapes a backslash so it cannot swallow the following cell delimiter", () => {
  /* #284: escapeCell escapes pipes but not pre-existing backslashes, so a
     value carrying `\|` renders as `\\|` — markdown reads that as an
     escaped backslash plus a REAL delimiter, splitting the cell. */
  const report = assessedReport();
  const corpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const people = corpus.people.filter((person) => report.selection.evaluated.includes(person.slug));
  report.remainingMisses[0].statement = "Statement with a backslash \\| before the pipe";
  assertTablesWellFormed(renderReport(report, people));
});

it("names the planning model only when the pipeline ran one, and keeps usefulness honest", () => {
  const report = assessedReport();
  const corpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const people = corpus.people.filter((person) => report.selection.evaluated.includes(person.slug));
  /* The bare fixture has no planning provenance (fixed-documents runs no
     planner) and no support/usefulness assessments, so the Conditions table
     carries no planning row and the usefulness measure is unavailable
     rather than an averaged zero (#289). */
  const bare = renderReport(report, people);
  expect(bare).not.toContain("Planning provider/model");
  expect(bare).toContain(
    "Meeting-preparation usefulness** — unavailable: no support/usefulness assessment completed",
  );
  /* The schema enforces the pair: the script records both or neither, and a
     half-written planning record fails at parse instead of rendering a
     half-documented Conditions table. */
  const halfProvenance = structuredClone(report);
  halfProvenance.provenance.planningProvider = "fixture";
  delete halfProvenance.provenance.planningModel;
  expect(() => BenchmarkReportSchema.parse(halfProvenance)).toThrow();
  report.provenance.planningProvider = "fixture";
  report.provenance.planningModel = "fixture/mercury";
  const assessment = report.people[1].assessment;
  if (!assessment) throw new Error("fixture lost its assessment");
  assessment.phases = {
    reference: { status: "completed", failure: null, judgements: [] },
    support: { status: "completed", failure: null, unresolvedFindings: [] },
  };
  const rendered = renderReport(report, people);
  expect(rendered).toContain("Planning provider/model");
  expect(rendered).toContain("fixture · fixture/mercury");
  /* The mean runs over the one completed support assessment, not the
     population (the unassessed dossier offers no zero to average). */
  expect(rendered).toContain("of 3 over 1 completed support/usefulness assessments");
  assertTablesWellFormed(rendered);
});

it("renders withheld recovery as unmeasured rather than a proven zero", () => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  /* The tracked 2d0a fixture carries null contributions on every person;
     stamp entries on all four sides so the family totals measure the stamped
     rows instead of reporting a whole side unmeasured. The candidate-side
     assessment deletion is the observed judge-infrastructure shape (#271,
     #282): that person's recovery was never measured. */
  for (const side of [baseline, candidate])
    side.people[0].sourceContributions = [
      {
        family: "documents-publishers",
        claimIds: [],
        recoveredFactIds: [],
        exclusiveRecoveredFactIds: [],
        sources: [],
      },
    ];
  candidate.people[1].sourceContributions = [
    {
      family: "public-social",
      claimIds: [],
      recoveredFactIds: ["fact-1"],
      exclusiveRecoveredFactIds: [],
      sources: [],
    },
  ];
  baseline.people[1].sourceContributions = [
    {
      family: "public-social",
      claimIds: [],
      recoveredFactIds: ["fact-1"],
      exclusiveRecoveredFactIds: ["fact-1"],
      sources: [],
    },
  ];
  delete candidate.people[1].assessment;
  const comparison = compareReports(baseline, candidate);
  expect(comparison.perPerson[1]).toMatchObject({
    baselineAssessed: true,
    candidateAssessed: false,
  });
  const rendered = renderComparison(comparison);
  const rowOf = (slug: string) =>
    rendered.split("\n").find((line) => line.startsWith(`| ${slug} `));
  expect(rowOf(comparison.perPerson[1].slug)).toContain("| 0 | unmeasured |");
  expect(rowOf(comparison.perPerson[0].slug)).not.toContain("unmeasured");
  /* The family table inherits the same withholding: the candidate side holds
     an unassessed person, so its recovered column is unmeasured while the
     fully assessed baseline side keeps its numbers. */
  expect(rowOf("public-social")).toBe("| public-social | 0 / 0 | 0 / 0 | 1 / 1 | unmeasured |");
});
it.each(["critical", "wrong-person"])(
  "detects a newly introduced %s failure when another failure disappears at the same count",
  (kind) => {
    const baseline = assessedReport();
    const original = baseline.people[0].factualReliability;
    if (kind === "critical") {
      original.criticalFindings = 1;
      original.criticalFindingKeys = ["a".repeat(64)];
      original.integrityFindings = [
        {
          check: "citation-quote-present",
          severity: "critical",
          subject: "generated-old-claim-id",
          detail: "Unsupported first assertion",
          fingerprint: "a".repeat(64),
        },
      ];
    } else {
      original.wrongPersonAttributions = 1;
      original.overclaims = [
        {
          claimId: "generated-old-claim-id",
          statement: "First namesake built Atlas.",
          kind: "wrong-person",
          citedQuote: "Atlas credits",
          rationale: "Wrong person",
          matchedUnjustifiedId: null,
          reviewRequired: false,
        },
      ];
    }
    const candidate = structuredClone(baseline);
    candidate.people[0].completeness.recovered += 1;
    const changed = candidate.people[0].factualReliability;
    if (kind === "critical") {
      changed.criticalFindingKeys = ["b".repeat(64)];
      changed.integrityFindings[0] = {
        ...changed.integrityFindings[0],
        fingerprint: "b".repeat(64),
        subject: "generated-new-claim-id",
        detail: "Unsupported second assertion",
      };
    } else {
      changed.overclaims[0] = {
        ...changed.overclaims[0],
        claimId: "generated-new-claim-id",
        statement: "Second namesake built Borealis.",
      };
    }
    const comparison = compareReports(baseline, candidate);
    expect(comparison.comparable).toBe(true);
    expect(comparison.verdict).toBe("regressed");
    expect(comparison.perPerson[0]).toMatchObject(
      kind === "critical" ? { newCriticalFindings: 1 } : { newWrongPersonAttributions: 1 },
    );

    // Merely regenerating a claim ID does not introduce a different failure.
    if (kind === "critical") {
      changed.criticalFindingKeys = original.criticalFindingKeys;
      changed.integrityFindings = original.integrityFindings.map((finding) => ({
        ...finding,
        subject: "different-generated-id",
      }));
    } else
      changed.overclaims = original.overclaims.map((finding) => ({
        ...finding,
        claimId: "different-generated-id",
      }));
    expect(compareReports(baseline, candidate).verdict).toBe("improved");
  },
);

it("refuses to establish improvement when a critical count has no retained finding identities", () => {
  const report = assessedReport();
  report.people[0].factualReliability.criticalFindings = 1;
  report.people[0].factualReliability.integrityFindings = [];
  expect(compareReports(report, report).comparable).toBe(false);
  report.people[0].factualReliability.integrityFindings = [
    {
      check: "private-evidence-isolation",
      severity: "critical",
      subject: "random-claim-id",
      detail: "A public projection cites private Workspace evidence.",
    },
  ];
  expect(compareReports(report, report).comparable).toBe(false);
});

it.each([
  "legacy",
  "judge",
  "integrity",
  "operation",
  "partial",
  "duplicate",
  "empty",
  "execution",
])("does not compare an unassessed or incomplete evaluation: %s", (reason) => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  if (reason === "legacy") delete candidate.execution;
  if (reason === "judge") candidate.people[0].assessment!.judge = "failed";
  if (reason === "integrity") candidate.people[0].assessment!.integrity = "failed";
  if (reason === "operation") candidate.people[0].assessment!.operationId = null;
  if (reason === "partial") candidate.people.pop();
  if (reason === "duplicate") candidate.people[1] = structuredClone(candidate.people[0]);
  if (reason === "empty") {
    candidate.people = [];
    candidate.execution!.selected = [];
    candidate.selection.evaluated = [];
    candidate.execution!.evaluated = 0;
    candidate.execution!.assessed = 0;
  }
  if (reason === "execution") candidate.execution!.status = "interrupted";
  expect(compareReports(baseline, candidate).verdict).toBe("not-comparable");
});

it("reports operational regressions separately from improved reference recovery", () => {
  const baseline = assessedReport();
  const candidate = structuredClone(baseline);
  baseline.people[0].operational.conclusion = "completed";
  candidate.people[0].operational.conclusion = "interrupted";
  candidate.people[0].completeness.recovered += 1;
  const comparison = compareReports(baseline, candidate);
  expect(comparison.verdict).toBe("improved");
  expect(comparison.operational.regressedPeople).toEqual([candidate.people[0].slug]);
  expect(comparison.verdictDetail).toContain("Reference coverage");
});

it("requires every planned collection assessment to complete", () => {
  const baseline = assessedReport();
  baseline.execution!.scenarioIds = ["intersection"];
  expect(compareReports(baseline, baseline).comparable).toBe(false);
  baseline.collection = [
    {
      scenarioId: "intersection",
      assessmentStatus: "completed",
      requirement: "r18",
      categories: ["directing", "screenwriting"],
      expectedMatches: [],
      recoveredMatches: [],
      missingMatches: [],
      additionalMatchesForReview: [],
      assessments: [],
      demonstrated: [],
      claimed: [],
      coverage: {
        activeProfiles: baseline.people.length,
        researchedProfiles: 0,
        demonstrated: 0,
        claimedOnly: 0,
      },
      scope: "Controlled missing intersection",
    },
  ];
  expect(compareReports(baseline, baseline).comparable).toBe(true);
  baseline.collection[0].assessmentStatus = "failed";
  expect(compareReports(baseline, baseline).comparable).toBe(false);
});

it.each([true, false])(
  "CLI comparison keeps failed research honest and refuses failed assessment: assessed=%s",
  (assessed) => {
    const output = mkdtempSync(join(tmpdir(), "benchmark-comparison-contract-"));
    try {
      const baseline = assessedReport();
      const candidate = structuredClone(baseline);
      if (!assessed) candidate.people[0].assessment!.judge = "failed";
      const before = join(output, "baseline.json");
      const after = join(output, "candidate.json");
      writeFileSync(before, JSON.stringify(baseline));
      writeFileSync(after, JSON.stringify(candidate));
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/person-research-benchmark.mts",
          "--compare",
          before,
          after,
          "--out",
          output,
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(assessed ? 0 : 1);
      expect(result.stdout).toContain(assessed ? "unchanged" : "not-comparable");
      expect(result.stdout).toContain("failed");
      expect(JSON.parse(readFileSync(before, "utf8"))).toMatchObject({ status: "failed" });
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  },
);
