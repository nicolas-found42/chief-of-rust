import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { BenchmarkReportSchema } from "@chief-of-staff-demo/shared";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { evaluatePerson } from "../../../apps/server/src/person-benchmark/evaluate.js";
import { reassessReport } from "../../../apps/server/src/person-benchmark/reassess.js";
import { renderReport } from "../../../apps/server/src/person-benchmark/report.js";
import type { CompleteJson } from "../../../apps/server/src/llm/providers.js";

const ORIGINAL_STEM = "fixed-documents-expanded-0000000000000001";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const assessment = {
  understanding: 1,
  remainingQuestions: 1,
  conversationReadiness: 1,
  rationale: "Grounded fixture",
  uncertain: false,
  overclaims: [],
};
async function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "benchmark-reassess-test-"));
  roots.push(workspace);
  const corpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const person = structuredClone(corpus.people[0]);
  person.fictional = true;
  const statement = "Maya Chen designed the Atlas scheduler.";
  const url = "https://example.com/maya";
  person.lookup = { fullName: "Maya Chen", employerHint: null, profileUrls: [url], emails: [] };
  person.facts = [
    {
      ...person.facts[0],
      statement,
      support: [{ documentId: person.documents[0].id, quote: statement }],
    },
  ];
  person.documents = [{ ...person.documents[0], url, excerpt: statement }];
  corpus.people = [person];
  corpus.scenarios = [];
  const evaluation = await evaluatePerson(person, "fixed-documents", {
    workspaceDir: workspace,
    search: async () => [],
    complete: () => async () => ({
      fullName: null,
      employer: null,
      author: null,
      publishedAt: null,
      sourceClass: "primary-artifact",
      claims: [
        {
          id: "scheduler",
          statement,
          section: "work",
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote: statement }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
    judge: async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: [
              {
                factId: person.facts[0].id,
                verdict: "missing",
                evidence: null,
                claimId: null,
                rationale: "Old judge missed the claim.",
              },
            ],
          }
        : assessment,
  });
  expect(evaluation.result.richness.claims).toBe(1);
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
  report.runId = "0000000000000001";
  report.people = [evaluation.result];
  report.collection = [];
  report.selection = { requested: [person.slug], evaluated: [person.slug], skipped: [] };
  report.execution = {
    status: "completed",
    selected: [person.slug],
    evaluated: 1,
    assessed: 1,
    scenarioIds: [],
  };
  report.provenance.corpusVersion = corpus.version;
  report.provenance.referenceVersions = { [person.slug]: person.referenceVersion };
  report.provenance.judgeVersion = "2026-09-06.4";
  const reportPath = join(workspace, `${ORIGINAL_STEM}.json`);
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(
    join(workspace, `${ORIGINAL_STEM}-${person.slug}.operation.json`),
    JSON.stringify(evaluation.operation),
  );
  writeFileSync(
    join(workspace, "snapshot-manifest.json"),
    JSON.stringify({ completedOperationIds: [evaluation.operation!.operationId] }),
  );
  const judge: CompleteJson = async ({ user }) => {
    if (!user.includes('"references":')) return assessment;
    const request = JSON.parse(user) as { dossier: { id: string; statement: string }[] };
    const claim = request.dossier[0];
    return {
      judgements: [
        {
          factId: person.facts[0].id,
          verdict: "recovered",
          evidence: claim.statement,
          claimId: claim.id,
          rationale: "The retained claim states the reference.",
        },
      ],
    };
  };
  return {
    reportPath,
    evidenceWorkspace: workspace,
    corpus,
    judge,
    judgeProvider: "mock",
    judgeModel: "fixture",
    report,
    evaluation,
  };
}

it("assesses timed revisions without rewriting the original operation verdict", async () => {
  const input = await fixture();
  const timelines: { minute: number; revision: number | null }[][] = [];
  const result = await reassessReport({
    ...input,
    timelineMinutes: [1, 2, 3, 5, 15],
    onTimeline: (_, points) => {
      timelines.push(points);
    },
  });
  expect(timelines).toHaveLength(1);
  expect(timelines[0].map((point) => point.minute)).toEqual([1, 2, 3, 5, 15]);
  expect(timelines[0].every((point) => point.revision !== null)).toBe(true);
  expect(result.people[0].operational).toEqual(input.evaluation.result.operational);
});

it("rejudges exact persisted research and recomputes reports without changing original evidence or outcomes", async () => {
  const input = await fixture();
  const original = readFileSync(input.reportPath, "utf8");
  const queue = readFileSync(join(input.evidenceWorkspace, "person-research.json"), "utf8");
  const result = await reassessReport(input);
  expect(result.people[0].completeness.recovered).toBe(1);
  expect(result.people[0].operational).toEqual(input.evaluation.result.operational);
  expect(result.people[0].assessment?.operationId).toBe(input.evaluation.operation!.operationId);
  expect(result.groups.every((group) => group.recovered === 1)).toBe(true);
  expect(result.remainingMisses).toEqual([]);
  expect(result.reassessment).toMatchObject({
    originalRunId: input.report.runId,
    originalProvenance: input.report.provenance,
  });
  expect(result.reassessment!.inputCharacters).toBeGreaterThan(0);
  expect(result.provenance).toMatchObject({
    judgeVersion: "2026-09-06.10",
    startedAt: input.report.provenance.startedAt,
  });
  expect(renderReport(result, input.corpus.people)).toContain("no research was repeated");
  expect(readFileSync(input.reportPath, "utf8")).toBe(original);
  expect(readFileSync(join(input.evidenceWorkspace, "person-research.json"), "utf8")).toBe(queue);
});

it.each(["manifest", "operation", "source", "reference", "population", "private"] as const)(
  "rejects %s evidence mismatches before any judge call",
  async (kind) => {
    const input = await fixture();
    if (kind === "manifest")
      writeFileSync(
        join(input.evidenceWorkspace, "snapshot-manifest.json"),
        JSON.stringify({ completedOperationIds: [] }),
      );
    if (kind === "operation") {
      const operation = { ...input.evaluation.operation, operationId: "wrong-operation" };
      writeFileSync(
        join(
          input.evidenceWorkspace,
          `${ORIGINAL_STEM}-${input.corpus.people[0].slug}.operation.json`,
        ),
        JSON.stringify(operation),
      );
    }
    if (kind === "source")
      rmSync(join(input.evidenceWorkspace, "person-source-documents"), { recursive: true });
    if (kind === "reference") input.corpus.people[0].referenceVersion = "different";
    if (kind === "population") {
      input.report.execution!.selected.push("absent-person");
      writeFileSync(input.reportPath, JSON.stringify(input.report));
    }
    if (kind === "private") {
      const { readdirSync } = await import("node:fs");
      const directory = join(input.evidenceWorkspace, "person-source-documents");
      const path = join(directory, readdirSync(directory)[0]);
      const source = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      source.visibility = "private";
      writeFileSync(path, JSON.stringify(source));
    }
    const judge = vi.fn(input.judge);
    await expect(reassessReport({ ...input, judge })).rejects.toThrow();
    expect(judge).not.toHaveBeenCalled();
  },
);

it("writes a separate reassessment report through the CLI and preserves failed judging", async () => {
  const input = await fixture();
  const { spawnSync } = await import("node:child_process");
  const { readdirSync } = await import("node:fs");
  const actualCorpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  input.report.execution!.scenarioIds = actualCorpus.scenarios.map((scenario) => scenario.id);
  writeFileSync(input.reportPath, JSON.stringify(input.report));
  const original = readFileSync(input.reportPath, "utf8");
  const config = join(input.evidenceWorkspace, "mock-config.json");
  writeFileSync(config, JSON.stringify({ provider: "mock", model: "mock" }));
  const out = join(input.evidenceWorkspace, "reports");
  const command = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/person-research-benchmark.mts",
      "--reassess",
      input.reportPath,
      "--evidence-workspace",
      input.evidenceWorkspace,
      "--config",
      config,
      "--out",
      out,
    ],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
  );
  expect(command.status, command.stderr).toBe(1);
  expect(command.stdout).toContain("no research was repeated");
  const files = readdirSync(out);
  const path = files.find(
    (file) =>
      file.endsWith(".json") && !file.endsWith(".operation.json") && !file.endsWith(".person.json"),
  )!;
  const report = BenchmarkReportSchema.parse(JSON.parse(readFileSync(join(out, path), "utf8")));
  expect(report.runId).not.toBe(input.report.runId);
  expect(report.status).toBe("failed");
  expect(report.execution?.assessed).toBe(0);
  expect(report.provenance.judgeVersion).toBe("2026-09-06.10");
  expect(report.people[0].operational).toEqual(input.report.people[0].operational);
  expect(files.some((file) => file.endsWith(".operation.json"))).toBe(true);
  expect(readFileSync(input.reportPath, "utf8")).toBe(original);
});

async function mixedPopulation() {
  const input = await fixture();
  const person = structuredClone(input.corpus.people[0]);
  person.slug = "fictional-no-public-evidence";
  person.displayName = "Quinn Empty";
  person.lookup = { fullName: "Quinn Empty", employerHint: null, profileUrls: [], emails: [] };
  person.documents = [];
  const evaluation = await evaluatePerson(person, "fixed-documents", {
    workspaceDir: input.evidenceWorkspace,
    search: async () => [],
    seeds: () => [],
    complete: () => async () => {
      throw new Error("No source should require extraction.");
    },
    judge: async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: person.facts.map((fact) => ({
              factId: fact.id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "No public evidence found.",
            })),
          }
        : assessment,
  });
  expect(evaluation.result.richness.sources).toBe(0);
  expect(evaluation.operation?.publishedDossierRevision).toBeUndefined();
  input.corpus.people.push(person);
  input.report.people.push(evaluation.result);
  input.report.provenance.referenceVersions[person.slug] = person.referenceVersion;
  input.report.selection.requested.push(person.slug);
  input.report.selection.evaluated.push(person.slug);
  input.report.execution!.selected.push(person.slug);
  input.report.execution!.evaluated += 1;
  input.report.execution!.assessed += 1;
  writeFileSync(input.reportPath, JSON.stringify(input.report));
  writeFileSync(
    join(input.evidenceWorkspace, `${ORIGINAL_STEM}-${person.slug}.operation.json`),
    JSON.stringify(evaluation.operation),
  );
  writeFileSync(
    join(input.evidenceWorkspace, "snapshot-manifest.json"),
    JSON.stringify({
      completedOperationIds: [
        input.evaluation.operation!.operationId,
        evaluation.operation!.operationId,
      ],
    }),
  );
  const originalJudge = input.judge;
  input.judge = async (request) => {
    const data = JSON.parse(request.user) as { dossier: unknown[] };
    return data.dossier.length
      ? originalJudge(request)
      : request.user.includes('"references":')
        ? {
            judgements: person.facts.map((fact) => ({
              factId: fact.id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "No retained dossier.",
            })),
          }
        : assessment;
  };
  return input;
}

it("reassesses a complete mixed population including an operation that never published a dossier", async () => {
  const input = await mixedPopulation();
  const result = await reassessReport(input);
  expect(result.execution).toMatchObject({ evaluated: 2, assessed: 2, status: "completed" });
  expect(result.people[0].completeness.recovered).toBe(1);
  expect(result.people[1].richness).toMatchObject({ claims: 0, sources: 0 });
  expect(result.people[1].completeness.missing).toBe(input.corpus.people[1].facts.length);
});

it("rejects a missing published dossier anywhere in the mixed population before judging anyone", async () => {
  const input = await mixedPopulation();
  // Put the valid empty person first: validation must reach the later damaged person
  // before invoking a judge, rather than judging incrementally as records are read.
  input.report.execution!.selected.reverse();
  writeFileSync(input.reportPath, JSON.stringify(input.report));
  expect(input.evaluation.operation!.publishedDossierRevision).toBeGreaterThan(0);
  rmSync(join(input.evidenceWorkspace, "person-dossiers", `${input.evaluation.profileId}.json`));
  const judge = vi.fn(input.judge);
  await expect(reassessReport({ ...input, judge })).rejects.toThrow(
    "dossier/source population mismatch",
  );
  expect(judge).not.toHaveBeenCalled();
});

it.each(["recovered", "partial"] as const)(
  "preserves a completed %s reference judgement when later support assessment fails without crediting it",
  async (verdict) => {
    const input = await fixture();
    const { BenchmarkPersonArtifactSchema } = await import("@chief-of-staff-demo/shared");
    const { compareReports } = await import("../../../apps/server/src/person-benchmark/report.js");
    const artifacts: unknown[] = [];
    const judge: CompleteJson = async (request) => {
      if (!request.user.includes('"references":'))
        throw new Error("Controlled support-phase timeout");
      const data = JSON.parse(request.user) as { dossier: { id: string; statement: string }[] };
      return {
        judgements: [
          {
            factId: input.corpus.people[0].facts[0].id,
            verdict,
            evidence: data.dossier[0].statement,
            claimId: data.dossier[0].id,
            rationale: "Reference statement is present in the retained dossier.",
          },
        ],
      };
    };
    const report = await reassessReport({
      ...input,
      judge,
      onPerson: (artifact) => {
        artifacts.push(artifact);
      },
    });
    const person = report.people[0];
    expect(person.factualReliability.criticalFindings).toBe(0);
    expect(person.factualReliability.verifiedCitations).toBeGreaterThan(0);
    expect(person.assessment).toMatchObject({
      judge: "failed",
      phases: {
        reference: {
          status: "completed",
          failure: null,
          judgements: [
            expect.objectContaining({
              verdict,
              evidenceQuote: "Maya Chen designed the Atlas scheduler.",
              claimId: expect.any(String),
            }),
          ],
        },
        support: {
          status: "failed",
          failure: expect.stringContaining("Controlled support-phase timeout"),
        },
      },
    });
    expect(person.completeness).toMatchObject({ recovered: 0, partial: 0, ambiguous: 1 });
    expect(person.completeness.judgements[0]).toMatchObject({
      evidenceQuote: "Maya Chen designed the Atlas scheduler.",
      claimId: expect.any(String),
      rationale: expect.stringContaining("positive recovery credit is withheld"),
    });
    expect(report.status).toBe("failed");
    expect(report.execution?.assessed).toBe(0);
    expect(compareReports(report, report).comparable).toBe(false);
    expect(artifacts).toHaveLength(1);
    const artifact = BenchmarkPersonArtifactSchema.parse(artifacts[0]);
    expect(artifact.result).toEqual(person);
    expect(artifact).toMatchObject({
      runId: report.runId,
      judgeVersion: "2026-09-06.10",
      reassessmentOf: input.report.runId,
    });
    expect(renderReport(report, input.corpus.people)).toContain("Incomplete judge phases");
  },
);

function saveReassessment(
  input: Awaited<ReturnType<typeof fixture>>,
  report: ReturnType<typeof BenchmarkReportSchema.parse>,
) {
  const path = join(
    input.evidenceWorkspace,
    `fixed-documents-expanded-reassessed-${report.runId}.json`,
  );
  writeFileSync(path, JSON.stringify(report));
  return path;
}

it("resumes interrupted assessment with exact evidence and freezes the first completed zero result", async () => {
  const input = await mixedPopulation();
  const missingJudge: CompleteJson = async ({ user }) =>
    user.includes('"references":')
      ? {
          judgements: input.corpus.people[0].facts.map((fact) => ({
            factId: fact.id,
            verdict: "missing",
            evidence: null,
            claimId: null,
            rationale: "Completed negative judgement.",
          })),
        }
      : assessment;
  const partial = await reassessReport({
    ...input,
    judge: missingJudge,
    onPerson: () => {
      throw new Error("Interrupted after persisted first result.");
    },
  });
  expect(partial.status).toBe("interrupted");
  expect(partial.people).toHaveLength(1);
  expect(partial.people[0].assessment?.judge).toBe("completed");
  const reportPath = saveReassessment(input, partial);
  const judge = vi.fn(input.judge);
  const resumed = await reassessReport({ ...input, reportPath, onlyFailed: true, judge });
  expect(judge).toHaveBeenCalledTimes(2);
  expect(resumed.people[0]).toEqual(partial.people[0]);
  expect(resumed.people[0].completeness.recovered).toBe(0);
  expect(resumed.execution).toMatchObject({ evaluated: 2, assessed: 2 });
  expect(resumed.reassessment?.resume).toMatchObject({
    carriedPeople: [input.corpus.people[0].slug],
    retriedPeople: [input.corpus.people[1].slug],
  });
  expect(readFileSync(reportPath, "utf8")).toBe(JSON.stringify(partial));
});

it.each(["legacy", "bytes", "model", "parent", "traversal", "cycle", "symlink"] as const)(
  "rejects unsafe failed-only resume %s before judging",
  async (kind) => {
    const input = await fixture();
    const completed = await reassessReport(input);
    let reportPath = saveReassessment(input, completed);
    if (kind === "legacy") reportPath = input.reportPath;
    if (kind === "bytes") {
      const path = join(input.evidenceWorkspace, "person-research.json");
      writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
    }
    if (kind === "parent")
      writeFileSync(input.reportPath, `${readFileSync(input.reportPath, "utf8")}\n`);
    if (kind === "traversal" || kind === "cycle") {
      completed.reassessment!.lineage!.parent =
        kind === "traversal" ? "../config.json" : reportPath.split("/").at(-1)!;
      writeFileSync(reportPath, JSON.stringify(completed));
    }
    if (kind === "symlink") {
      const { symlinkSync } = await import("node:fs");
      const path = join(input.evidenceWorkspace, "person-research.json");
      const target = join(input.evidenceWorkspace, "private-config.json");
      writeFileSync(target, readFileSync(path));
      rmSync(path);
      symlinkSync(target, path);
    }
    const judge = vi.fn(input.judge);
    await expect(
      reassessReport({
        ...input,
        reportPath,
        onlyFailed: true,
        judge,
        ...(kind === "model" ? { judgeModel: "different" } : {}),
      }),
    ).rejects.toThrow(kind === "legacy" ? /full reassessment first/ : undefined);
    expect(judge).not.toHaveBeenCalled();
  },
);

it.each(["unknown-id", "unrelated-statement", "blank", "valid"] as const)(
  "gates unverified support finding %s at the real evaluator boundary",
  async (kind) => {
    const input = await fixture();
    const goodJudge = input.judge;
    const result = await reassessReport({
      ...input,
      judge: async (request) => {
        if (request.user.includes('"references":')) return goodJudge(request);
        const claim = JSON.parse(request.user).dossier[0] as { id: string; statement: string };
        return {
          ...assessment,
          overclaims: [
            {
              claimId: kind === "unknown-id" ? "invented-id" : claim.id,
              statement:
                kind === "unrelated-statement"
                  ? "An unrelated invented statement."
                  : kind === "blank"
                    ? " "
                    : claim.statement.slice(0, 12),
              kind: "wrong-person",
              citationIndex: 0,
              rationale: "Fixture allegation.",
              matchedUnjustifiedId: null,
              uncertain: false,
            },
          ],
        };
      },
    });
    const person = result.people[0];
    expect(person.assessment?.phases?.support.status).toBe(
      kind === "valid" ? "completed" : "failed",
    );
    if (kind !== "valid") {
      expect(person.completeness.recovered).toBe(0);
      expect(person.factualReliability.wrongPersonAttributions).toBe(0);
      expect(person.factualReliability.overclaims).toEqual([]);
      expect(person.assessment?.phases?.support.unresolvedFindings).toHaveLength(1);
      expect(person.usefulness.reviewRequired).toBe(true);
    } else {
      expect(person.factualReliability.overclaims).toHaveLength(1);
      expect(person.completeness.recovered).toBe(0);
    }
  },
);

it("attests public bytes while excluding configuration and bounds cross-directory report lineage explicitly", async () => {
  const input = await fixture();
  const first = await reassessReport(input);
  writeFileSync(
    join(input.evidenceWorkspace, "config.json"),
    JSON.stringify({ secret: "Never copied or hashed" }),
  );
  const judge = vi.fn(input.judge);
  const resumed = await reassessReport({
    ...input,
    reportPath: saveReassessment(input, first),
    onlyFailed: true,
    judge,
  });
  expect(resumed.evidenceBundleHash).toBe(first.evidenceBundleHash);
  expect(judge).not.toHaveBeenCalled();
  await expect(
    reassessReport({
      ...input,
      outputDirectory: join(input.evidenceWorkspace, "..", "outside"),
      judge,
    }),
  ).rejects.toThrow("escapes");
  expect(judge).not.toHaveBeenCalled();
});

it.each([false, true])(
  "full reassessment enforces an existing byte attestation (attested=%s)",
  async (attested) => {
    const input = await fixture();
    const { copyEvidence } = await import("../../../apps/server/src/person-benchmark/evidence.js");
    const beforeCopy = mkdtempSync(join(tmpdir(), "attestation-before-"));
    const afterCopy = mkdtempSync(join(tmpdir(), "attestation-after-"));
    roots.push(beforeCopy, afterCopy);
    const before = copyEvidence(input.evidenceWorkspace, beforeCopy);
    if (attested) {
      input.report.evidenceBundleHash = before;
      writeFileSync(input.reportPath, JSON.stringify(input.report));
    }
    // A harmless one-byte whitespace change keeps every source hash, dossier
    // revision and population count valid, but is not the attested evidence.
    const path = join(
      input.evidenceWorkspace,
      "person-dossiers",
      `${input.evaluation.profileId}.json`,
    );
    writeFileSync(path, `${readFileSync(path, "utf8")} `);
    const after = copyEvidence(input.evidenceWorkspace, afterCopy);
    expect(after).not.toBe(before);
    const judge = vi.fn(input.judge);
    const pending = reassessReport({ ...input, judge, judgeModel: "new-full-assessment-model" });
    if (attested) {
      await expect(pending).rejects.toThrow(/evidence bundle.*attestation/);
      expect(judge).not.toHaveBeenCalled();
    } else {
      const report = await pending;
      expect(judge).toHaveBeenCalledTimes(2);
      expect(report.execution?.assessed).toBe(1);
      expect(report.evidenceBundleHash).toBe(after);
    }
  },
);
