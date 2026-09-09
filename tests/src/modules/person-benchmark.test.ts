import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus";
import { evaluatePerson } from "../../../apps/server/src/person-benchmark/evaluate";
import {
  coverageGapTotals,
  leadDispositionTotals,
  renderReport,
} from "../../../apps/server/src/person-benchmark/report";
import {
  BenchmarkReportSchema,
  PersonResearchOperationOutcomeSchema,
  type PersonResearchLead,
} from "@chief-of-staff-demo/shared";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("retains omitted reference verdicts as misses without claiming complete judge assessment", async () => {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-omitted-verdicts-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "live-discovery", {
    workspaceDir,
    search: async () => [],
    complete: () => async () => ({}),
    judge: async ({ user }) =>
      user.includes('"references":')
        ? { judgements: [] }
        : {
            understanding: 0,
            remainingQuestions: 0,
            conversationReadiness: 0,
            rationale: "Empty dossier",
            uncertain: false,
            overclaims: [],
          },
  });
  expect(result.assessment?.judge).toBe("failed");
  expect(result.failure).toContain("Judge assessment was incomplete");
  expect(result.completeness.missing).toBe(person.facts.length);
});

it("does not count a judge's unsupported recovery of an empty dossier", async () => {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people.find((entry) => entry.slug === "achim-steiner")!;
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-report-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "live-discovery", {
    workspaceDir,
    search: async () => [],
    complete: () => async () => ({}),
    judge: async ({ user }) => {
      if (user.includes('"references":'))
        return {
          judgements: person.facts.map((fact) => ({
            factId: fact.id,
            verdict: "recovered",
            evidence: null,
            claimId: null,
            rationale: "I know this fact from general knowledge.",
          })),
        };
      return {
        understanding: 0,
        remainingQuestions: 0,
        conversationReadiness: 0,
        rationale: "Empty dossier.",
        uncertain: false,
        overclaims: [],
      };
    },
  });
  expect(result.richness.claims).toBe(0);
  expect(result.completeness.recovered).toBe(0);
  expect(result.completeness.judgements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ verdict: "ambiguous", reviewRequired: true }),
    ]),
  );
});

it("reports an interrupted production operation as an evaluation failure", async () => {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people.find((entry) => entry.slug === "achim-steiner")!;
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-interrupted-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "fixed-documents", {
    workspaceDir,
    search: async () => [],
    complete: () => async () => {
      throw new Error("Model provider unavailable");
    },
    judge: async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: person.facts.map((fact) => ({
              factId: fact.id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "No published claims.",
            })),
          }
        : {
            understanding: 0,
            remainingQuestions: 0,
            conversationReadiness: 0,
            rationale: "No published claims.",
            uncertain: false,
            overclaims: [],
          },
  });
  expect(result.assessment).toMatchObject({
    integrity: "completed",
    judge: "completed",
    operationId: expect.any(String),
  });
  expect(result.operational.conclusion).toBe("interrupted");
  expect(result.failure).toMatch(/interrupt/i);
});

it("changes corpus identity when retained reference content changes without a version bump", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const source = fileURLToPath(
    new URL("../../../benchmark/person-research/people/achim-steiner.json", import.meta.url),
  );
  const directory = mkdtempSync(join(tmpdir(), "benchmark-corpus-"));
  roots.push(directory);
  const path = join(directory, "person.json");
  writeFileSync(path, readFileSync(source));
  const before = loadCorpus(directory);
  const person = before.people[0];
  person.facts[0].statement = "The retained account describes Steiner's UNDP tenure as historical.";
  writeFileSync(path, JSON.stringify(person));
  const after = loadCorpus(directory);
  expect(after.rejected).toEqual([]);
  expect(after.version).not.toBe(before.version);
});

it("refuses comparisons across different people and judge providers", async () => {
  const { compareReports } = await import("../../../apps/server/src/person-benchmark/report");
  const { BenchmarkReportSchema } = await import("@chief-of-staff-demo/shared");
  const baseline = BenchmarkReportSchema.parse({
    schemaVersion: 1,
    runId: "baseline",
    status: "completed",
    statusDetail: "Fixture",
    mode: "live-discovery",
    selection: { requested: ["alice"], evaluated: ["alice"], skipped: [] },
    provenance: {
      corpusVersion: "fixed",
      referenceVersions: { alice: "2026-09-06.1" },
      pipeline: "incumbent",
      researchProvider: "openrouter",
      researchModel: "research",
      judgeProvider: "openrouter",
      judgeModel: "judge",
      judgeVersion: "1",
      promptVersion: "1",
      collectorVersions: {},
      researchSettings: {},
      network: "live",
      startedAt: "2026-09-06",
      finishedAt: "2026-09-06",
      host: "fixture",
    },
    people: [],
    groups: [],
    remainingMisses: [],
  });
  const candidate = structuredClone(baseline);
  candidate.runId = "candidate";
  candidate.selection.evaluated = ["bob"];
  candidate.provenance.referenceVersions.bob = "2026-09-06.1";
  expect(compareReports(baseline, candidate).verdict).toBe("not-comparable");
  candidate.selection.evaluated = ["alice"];
  delete candidate.provenance.referenceVersions.bob;
  candidate.provenance.judgeProvider = "ollama";
  expect(compareReports(baseline, candidate).verdict).toBe("not-comparable");
});

it("rejects ambiguous document identities instead of silently choosing one retained version", async () => {
  const { writeFileSync } = await import("node:fs");
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  const directory = mkdtempSync(join(tmpdir(), "benchmark-duplicate-"));
  roots.push(directory);
  person.documents.push(structuredClone(person.documents[0]));
  writeFileSync(join(directory, "person.json"), JSON.stringify(person));
  const corpus = loadCorpus(directory);
  expect(corpus.people).toEqual([]);
  expect(corpus.rejected[0]?.reason).toMatch(/duplicate/i);
});

it.each([
  ["Maya built the entire Atlas product alone.", "team-output-as-personal"],
  ["Daniel Ortiz designed the Atlas scheduler.", "wrong-person"],
] as const)("separates quote integrity from semantic attribution: %s", async (statement, kind) => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { BenchmarkPersonSchema } = await import("@chief-of-staff-demo/shared");
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../fixtures/person-dossiers/comprehensive.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    url: string;
    text: string;
    extraction: { claims: { statement: string }[] };
  };
  const person = BenchmarkPersonSchema.parse({
    schemaVersion: 1,
    slug: "fictional-maya",
    referenceVersion: "2026-09-06.1",
    displayName: "Maya Chen",
    industry: "technology",
    role: "Engineer",
    region: "Fictional",
    language: "en",
    footprint: "rich",
    fictional: true,
    lookup: { fullName: "Maya Chen", employerHint: null, profileUrls: [fixture.url], emails: [] },
    identityAnchors: ["Fictional Maya Chen at example.com/maya"],
    documents: [
      {
        id: "fixture",
        url: fixture.url,
        title: "Fictional Maya Chen",
        publisher: "Fictional Northline",
        publishedAt: null,
        retrievedAt: "2026-09-06",
        family: "documents-publishers",
        sourceClass: "independent-account",
        language: "en",
        hash: createHash("sha256").update(fixture.text).digest("hex"),
        excerpt: fixture.text,
        rights: "public-domain",
      },
    ],
    facts: [
      {
        id: "contribution",
        requirements: ["r1"],
        section: "work",
        statement: "Maya designed the scheduler; the team built the UI.",
        effectiveFrom: null,
        effectiveTo: null,
        support: [
          {
            documentId: "fixture",
            quote:
              "Maya Chen designed the Atlas scheduler; the Northline team built its user interface.",
          },
        ],
        importance: "core",
        acquisition: "app-supported",
      },
    ],
  });
  person.documents.push({
    ...person.documents[0],
    id: "mirror",
    url: "https://mirror.example/maya",
  });
  fixture.extraction.claims[0].statement = statement;
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-semantics-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "fixed-documents", {
    workspaceDir,
    search: async () => {
      throw new Error("Fixed documents must not contact live search");
    },
    complete: () => async () => structuredClone(fixture.extraction),
    judge: async ({ user }) => {
      if (user.includes('"references":'))
        return {
          judgements: person.facts.map((fact) => ({
            factId: fact.id,
            verdict: "missing",
            evidence: null,
            claimId: null,
            rationale: "No matching reference claim.",
          })),
        };
      const input = JSON.parse(user) as { dossier: { id: string; statement: string }[] };
      const claim = input.dossier.find((entry) => entry.statement === statement)!;
      return {
        understanding: 1,
        remainingQuestions: 1,
        conversationReadiness: 1,
        rationale: "The quoted passage does not justify the asserted attribution.",
        uncertain: false,
        overclaims: [
          {
            claimId: claim.id,
            citationIndex: 0,
            statement,
            kind,
            rationale: "The source credits Maya with the scheduler and the team with the UI.",
            matchedUnjustifiedId: null,
            uncertain: false,
          },
        ],
      };
    },
  });
  expect(result.failure).toBeNull();
  expect(result.richness.sources).toBeGreaterThan(1);
  expect(result.richness.distinctUpstreamIndexes).toBe(1);
  expect(result.factualReliability.verifiedCitations).toBeGreaterThan(0);
  expect(result.factualReliability.overclaims).toContainEqual(
    expect.objectContaining({ statement, kind }),
  );
  expect(result.completeness.recovered).toBe(0);
  const { compareReports, renderReport, summarizeGroups, remainingMisses } =
    await import("../../../apps/server/src/person-benchmark/report");
  const { BenchmarkReportSchema } = await import("@chief-of-staff-demo/shared");
  const baseline = BenchmarkReportSchema.parse({
    schemaVersion: 1,
    runId: "baseline",
    status: "completed",
    statusDetail: "Fixture",
    mode: "fixed-documents",
    selection: { requested: [person.slug], evaluated: [person.slug], skipped: [] },
    provenance: {
      corpusVersion: "fixed",
      referenceVersions: { [person.slug]: person.referenceVersion },
      pipeline: "expanded",
      researchProvider: "fixture",
      researchModel: "fixture",
      judgeProvider: "fixture",
      judgeModel: "fixture",
      judgeVersion: "1",
      promptVersion: "1",
      collectorVersions: {},
      researchSettings: {},
      network: "fixed-documents",
      startedAt: "2026-09-06",
      finishedAt: "2026-09-06",
      host: "fixture",
    },
    execution: {
      status: "completed",
      selected: [person.slug],
      evaluated: 1,
      assessed: 1,
      scenarioIds: [],
    },
    people: [result],
    groups: summarizeGroups([person], [result]),
    remainingMisses: remainingMisses([person], [result]),
  });
  const readable = renderReport(baseline, [person]);
  expect(readable).toContain("Remaining misses");
  expect(readable).toContain("Maya designed the scheduler");
  expect(baseline.groups).toContainEqual(
    expect.objectContaining({ dimension: "industry", people: 1, referenceFacts: 1, recovered: 0 }),
  );
  if (kind === "wrong-person") {
    const candidate = structuredClone(baseline);
    baseline.people[0].factualReliability.overclaims = [];
    baseline.people[0].factualReliability.wrongPersonAttributions = 0;
    candidate.people[0].completeness.recovered = 1;
    expect(compareReports(baseline, candidate).verdict).toBe("regressed");
  }
});

it("finishes fixed-document evaluation without planning internet targets outside its supplied documents", async () => {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people.find((entry) => entry.slug === "achim-steiner")!;
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-fixed-scope-"));
  roots.push(workspaceDir);
  const { operation, result } = await evaluatePerson(person, "fixed-documents", {
    workspaceDir,
    search: async () => {
      throw new Error("No live discovery in fixed mode");
    },
    complete: () => async () => ({
      fullName: "Achim Steiner",
      employer: null,
      sourceClass: "independent-account",
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
    plan: () => async () => {
      throw new Error("Fixed documents must not plan inaccessible internet targets");
    },
    judge: async () => {
      throw new Error("Controlled unassessed judge");
    },
  });
  expect(result.assessment?.judge).toBe("failed");
  expect(operation?.conclusion).toBe("completed");
  expect(
    operation?.attempts.some(
      (attempt) => attempt.stage === "planning" && attempt.outcome === "failed",
    ),
  ).toBe(false);
});

it.each([false, true])("preserves judge wire attempts when assessment fails=%s", async (fails) => {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-judge-attempts-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "live-discovery", {
    workspaceDir,
    search: async () => [],
    complete: () => async () => ({}),
    judge: async (request) => {
      const { modelBoundaryFailure } = await import("../../../apps/server/src/llm/failure.js");
      const error = modelBoundaryFailure({
        call: { provider: "openrouter", model: "model", binding: "response_format" },
        classification: "request_timeout",
        status: 200,
        bodyBytes: 11,
        timeoutMs: 30000,
      });
      request.retry?.onAttempt({
        attempt: 1,
        binding: "response_format",
        provider: "openrouter",
        model: "model",
        outcome: "retrying",
        diagnostic: error.diagnostic,
        delayMs: 500,
        stoppedReason: null,
      });
      request.retry?.onAttempt({
        attempt: 2,
        binding: "response_format",
        provider: "openrouter",
        model: "model",
        outcome: fails ? "failed" : "succeeded",
        diagnostic: fails ? error.diagnostic : null,
        delayMs: 0,
        stoppedReason: fails ? "Retry exhausted" : null,
      });
      if (fails) throw error;
      return request.user.includes('"references":')
        ? {
            judgements: person.facts.map((fact) => ({
              factId: fact.id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "No dossier claims.",
            })),
          }
        : {
            understanding: 0,
            remainingQuestions: 0,
            conversationReadiness: 0,
            rationale: "No dossier claims.",
            uncertain: false,
            overclaims: [],
          };
    },
  });
  expect(result.assessment?.judge).toBe(fails ? "failed" : "completed");
  expect(result.assessment?.modelAttempts?.[0]).toMatchObject({
    call: 1,
    subject: person.slug,
    observation: {
      outcome: "retrying",
      diagnostic: { classification: "request_timeout", bodyBytes: 11 },
    },
  });
  expect(result.assessment?.modelAttempts?.[1]?.observation.outcome).toBe(
    fails ? "failed" : "succeeded",
  );
  expect(result.assessment?.modelAttempts?.length).toBe(4);
  expect(result.completeness.recovered).toBe(0);
});

it.each(["recovered", "partial"] as const)(
  "does not count %s semantic recovery when the matched claim fails retained citation integrity",
  async (verdict) => {
    const person = loadCorpus(
      fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
    ).people.find((entry) => entry.slug === "achim-steiner")!;
    const url = "https://example.com/achim-steiner";
    const statements = [
      "Achim Steiner led the test programme.",
      "Achim Steiner wrote the test report.",
    ];
    person.lookup.profileUrls = [url];
    person.facts = statements.map((statement, index) => ({
      ...person.facts[0],
      id: `fact-${index}`,
      statement,
    }));
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-critical-recovery-"));
    roots.push(workspaceDir);
    let corrupted = 0;
    const { result } = await evaluatePerson(person, "live-discovery", {
      workspaceDir,
      search: async () => [],
      seeds: () => [url],
      readSource: async () => ({
        text: statements.join(" "),
        capturedAt: null,
        completeness: "full",
        access: "retrieved",
        outboundUrls: [],
        family: "documents-publishers",
        route: "controlled-fixture",
        upstreamIndex: null,
        publishedAt: null,
        author: null,
        anchors: [],
        provenanceNote: "Controlled evaluator fixture",
        sourceVersion: null,
        rights: null,
        finalUrl: url,
      }),
      complete: () => async () => ({
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: statements.map((statement, index) => ({
          id: `claim-${index}`,
          section: "career",
          statement,
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote: statement }],
          supports: [],
          supersedes: [],
          changeReason: null,
        })),
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      }),
      plan: () => async () => {
        // Simulate retained evidence corruption after production publication,
        // before the evaluator reads the final dossier and runs integrity checks.
        const directory = join(workspaceDir, "person-source-documents");
        for (const file of readdirSync(directory)) {
          const path = join(directory, file);
          const source = JSON.parse(readFileSync(path, "utf8")) as { text: string };
          if (source.text.includes(statements[0])) {
            source.text = source.text.replace(
              statements[0],
              "The first passage is no longer retained.",
            );
            writeFileSync(path, JSON.stringify(source));
            corrupted += 1;
          }
        }
        throw new Error("Controlled stop after evidence corruption");
      },
      judge: async ({ user }) => {
        const request = JSON.parse(user) as { dossier: { id: string; statement: string }[] };
        if (user.includes('"references":'))
          return {
            judgements: person.facts.map((fact, index) => {
              const claim = request.dossier.find((entry) => entry.statement === statements[index])!;
              return {
                factId: fact.id,
                verdict: index === 0 ? verdict : "recovered",
                evidence: claim.statement,
                claimId: claim.id,
                rationale: "The dossier states the reference fact.",
              };
            }),
          };
        return {
          understanding: 1,
          remainingQuestions: 1,
          conversationReadiness: 1,
          rationale: "Controlled assessment",
          uncertain: false,
          overclaims: [],
        };
      },
    });
    expect(corrupted).toBeGreaterThan(0);
    expect(result.assessment?.judge).toBe("completed");
    expect(result.factualReliability.integrityFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "citation-quote-present", severity: "critical" }),
      ]),
    );
    expect(result.completeness).toMatchObject({ recovered: 1, partial: 0, ambiguous: 1 });
    expect(result.completeness.judgements[0]).toMatchObject({
      verdict: "ambiguous",
      reviewRequired: true,
      rationale: expect.stringContaining(`Original semantic verdict: ${verdict}`),
    });
    expect(result.completeness.judgements[0].rationale).toContain("citation-quote-present");
    expect(result.completeness.byAcquisition[person.facts[0].acquisition]).toEqual({
      total: 2,
      recovered: 1,
    });
    for (const requirement of person.facts[0].requirements)
      expect(result.completeness.byRequirement[requirement]).toEqual({ total: 2, recovered: 1 });
  },
);

it("reports a saturated semantic assessment as failed instead of fully assessed", async () => {
  const person = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  ).people[0];
  const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-judge-limit-"));
  roots.push(workspaceDir);
  const { result } = await evaluatePerson(person, "live-discovery", {
    workspaceDir,
    search: async () => [],
    complete: () => async () => ({}),
    judge: async ({ user }) =>
      user.includes('"references":')
        ? {
            judgements: person.facts.map((fact) => ({
              factId: fact.id,
              verdict: "missing",
              evidence: null,
              claimId: null,
              rationale: "Empty dossier.",
            })),
          }
        : {
            understanding: 0,
            remainingQuestions: 0,
            conversationReadiness: 0,
            uncertain: false,
            rationale: "Saturated response; identifiers must still be checked.",
            overclaims: Array.from({ length: 40 }, (_, index) => ({
              claimId: `unknown-${index}`,
              citationIndex: null,
              statement: "Unrecognized claim",
              kind: "unsupported-inference",
              rationale: "Unverified",
              matchedUnjustifiedId: null,
              uncertain: false,
            })),
          },
  });
  expect(result.assessment?.judge).toBe("failed");
  expect(result.failure).toContain("overclaim response limit of 40");
  expect(result.usefulness).toMatchObject({
    reviewRequired: true,
    rationale: expect.stringContaining("overclaim response limit of 40"),
  });
  expect(result.factualReliability.overclaims).toEqual([]);
});

it("aggregates lead dispositions and coverage gaps at report level", () => {
  const outcome = (leads: PersonResearchLead[]) =>
    PersonResearchOperationOutcomeSchema.parse({
      operationId: "op-1",
      profileId: "profile-1",
      conclusion: "completed",
      startedAt: "2026-09-07",
      finishedAt: "2026-09-07",
      rounds: 1,
      modelCalls: 1,
      requests: 1,
      sourcesRetained: 0,
      claimsPublished: 0,
      coverage: [
        {
          key: "employment",
          label: "Employment",
          kind: "dossier-section",
          state: "investigated",
          sources: 1,
          claims: 1,
          gaps: ["Start date unconfirmed"],
        },
        {
          key: "education",
          label: "Education",
          kind: "source-family",
          state: "satisfied",
          sources: 2,
          claims: 1,
          gaps: [],
        },
      ],
      leads,
      attempts: [],
      gaps: ["No interview record found"],
      detail: "done",
    });
  const lead = (id: string, disposition: "investigated" | "pending" | "inaccessible") => ({
    id,
    kind: "url" as const,
    target: `https://example.com/${id}`,
    origin: "seed" as const,
    coverage: [],
    disposition,
    reason: "fixture",
    yieldedEvidence: false,
  });
  const first = outcome([
    lead("l1", "investigated"),
    lead("l2", "investigated"),
    lead("l3", "pending"),
    lead("l4", "inaccessible"),
  ]);
  const second = outcome([lead("l5", "investigated")]);
  const dispositions = leadDispositionTotals([first, second]);
  expect(dispositions.totalLeads).toBe(5);
  expect(dispositions.dispositions).toEqual([
    { disposition: "investigated", count: 3, share: 0.6 },
    { disposition: "inaccessible", count: 1, share: 0.2 },
    { disposition: "pending", count: 1, share: 0.2 },
  ]);
  expect(coverageGapTotals([first, second])).toEqual({
    areas: 4,
    areasWithOpenGaps: 2,
    areaGaps: 2,
    explicitGaps: 2,
  });
  /* The rendered report carries both aggregations; a report assembled before
     the fields existed renders neither. */
  const report = BenchmarkReportSchema.parse({
    schemaVersion: 1,
    runId: "aggregation",
    status: "completed",
    statusDetail: "Fixture",
    mode: "live-discovery",
    selection: { requested: ["alice"], evaluated: ["alice"], skipped: [] },
    provenance: {
      corpusVersion: "fixed",
      referenceVersions: { alice: "2026-09-06.1" },
      pipeline: "expanded",
      researchProvider: "openrouter",
      researchModel: "research",
      judgeProvider: "openrouter",
      judgeModel: "judge",
      judgeVersion: "1",
      promptVersion: "1",
      collectorVersions: {},
      researchSettings: {},
      network: "live",
      startedAt: "2026-09-06",
      finishedAt: "2026-09-06",
      host: "fixture",
    },
    people: [],
    groups: [],
    remainingMisses: [],
    leadDispositions: dispositions,
    coverageGaps: coverageGapTotals([first, second]),
  });
  const rendered = renderReport(report, []);
  expect(rendered).toContain("## Lead dispositions");
  expect(rendered).toContain("| investigated | 3 | 60% |");
  expect(rendered).toContain("## Coverage gaps");
  expect(rendered).toContain("4 planned coverage areas");
  const bare = BenchmarkReportSchema.parse({
    ...report,
    leadDispositions: undefined,
    coverageGaps: undefined,
  });
  expect(renderReport(bare, [])).not.toContain("## Lead dispositions");
  expect(renderReport(bare, [])).not.toContain("## Coverage gaps");
});
