import { assessTimeline } from "./timeline.js";
import { PersonDossierStore } from "../person-profile/dossier-store.js";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod/v3";
import {
  BenchmarkReportSchema,
  BenchmarkPersonArtifactSchema,
  PersonResearchOperationOutcomeSchema,
  type BenchmarkPersonResult,
  type BenchmarkCollectionResult,
  type BenchmarkReport,
  type BenchmarkPersonArtifact,
  type PersonResearchOperationOutcome,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../llm/providers.js";
import { composePersonProfiles } from "../person-profile/composition.js";
import type { BenchmarkCorpus } from "./corpus.js";
import { assessPerson, runId } from "./evaluate.js";
import { evaluateCollection } from "./collection.js";
import { JUDGE_VERSION } from "./judge.js";
import { remainingMisses, summarizeGroups } from "./report.js";

import { copyEvidence } from "./evidence.js";
import { readBenchmarkReport, reportLineage, safeReportPath } from "./lineage.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (path: string): unknown => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
    throw new Error("Invalid or oversized reassessment evidence file.");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Invalid reassessment evidence JSON.");
  }
};
const same = (a: string[], b: string[]) =>
  a.length === b.length &&
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  a.every((value) => b.includes(value));

/** Reassess a complete retained population. All evidence checks precede every judge call. */
export async function reassessReport(input: {
  reportPath: string;
  evidenceWorkspace: string;
  corpus: BenchmarkCorpus;
  judge: CompleteJson;
  judgeProvider: string;
  judgeModel: string;
  onlyFailed?: boolean;
  timelineMinutes?: number[];
  onTimeline?: (
    slug: string,
    points: Awaited<ReturnType<typeof assessTimeline>>,
    provenance: { runId: string; evidenceBundleHash: string; judgeVersion: string },
  ) => void;
  lineageRoot?: string;
  outputDirectory?: string;
  onPerson?: (artifact: BenchmarkPersonArtifact, operation: PersonResearchOperationOutcome) => void;
}): Promise<BenchmarkReport> {
  const saved = readBenchmarkReport(input.reportPath);
  const original = saved.report;
  const lineage = reportLineage(saved, input.lineageRoot);
  if (input.outputDirectory)
    safeReportPath(lineage.root, join(input.outputDirectory, basename(input.reportPath)), true);
  const selected = original.execution?.selected ?? [];
  const fullResearch = lineage.reports.find(
    ({ report }) =>
      selected.length > 0 &&
      same(selected, report.execution?.selected ?? []) &&
      report.execution?.evaluated === selected.length &&
      same(
        selected,
        report.people.map((person) => person.slug),
      ) &&
      same(selected, report.selection.evaluated) &&
      report.provenance.corpusVersion === original.provenance.corpusVersion &&
      report.mode === original.mode &&
      report.provenance.pipeline === original.provenance.pipeline &&
      same(report.execution.scenarioIds, original.execution?.scenarioIds ?? []) &&
      selected.every(
        (slug) =>
          report.provenance.referenceVersions[slug] === original.provenance.referenceVersions[slug],
      ),
  );
  if (
    !fullResearch ||
    !same(selected, Object.keys(original.provenance.referenceVersions)) ||
    (!input.onlyFailed && original.execution?.evaluated !== selected.length)
  )
    throw new Error(
      "Reassessment requires a complete nonempty selected research population or its verified parent report.",
    );
  if (input.onlyFailed && !original.evidenceBundleHash)
    throw new Error(
      "Failed-only reassessment requires an attested evidence bundle hash; run a full reassessment first.",
    );
  if (
    input.onlyFailed &&
    (original.provenance.judgeProvider !== input.judgeProvider ||
      original.provenance.judgeModel !== input.judgeModel ||
      original.provenance.judgeVersion !== JUDGE_VERSION)
  )
    throw new Error(
      "Failed-only reassessment requires the same judge provider, model and version.",
    );
  if (input.corpus.rejected.length || input.corpus.version !== original.provenance.corpusVersion)
    throw new Error("Reassessment corpus version does not match the original research report.");
  const references = selected.map((slug) => {
    const person = input.corpus.people.find((person) => person.slug === slug);
    if (
      !person ||
      person.referenceVersion !== original.provenance.referenceVersions[slug] ||
      fullResearch.report.people.find((result) => result.slug === slug)?.referenceVersion !==
        person.referenceVersion
    )
      throw new Error(`Reassessment reference version mismatch: ${slug}`);
    return person;
  });
  if (
    !same(
      original.execution?.scenarioIds ?? [],
      input.corpus.scenarios.map((scenario) => scenario.id),
    )
  )
    throw new Error("Reassessment collection scenarios differ from the original selection.");

  const workspaceDir = mkdtempSync(join(tmpdir(), "person-benchmark-reassessment-"));
  try {
    const bundleHash = copyEvidence(input.evidenceWorkspace, workspaceDir);
    if (original.evidenceBundleHash && original.evidenceBundleHash !== bundleHash)
      throw new Error("Reassessment evidence bundle does not match its attestation.");
    const manifestText = readFileSync(join(workspaceDir, "snapshot-manifest.json"), "utf8");
    const manifest = z
      .object({ completedOperationIds: z.array(z.string().min(1).max(64)).max(200) })
      .parse(JSON.parse(manifestText));
    const queue = z
      .object({
        jobs: z.array(
          z.object({
            profileId: z.string(),
            operation: PersonResearchOperationOutcomeSchema.nullable().optional(),
          }),
        ),
      })
      .parse(read(join(workspaceDir, "person-research.json")));
    const unavailable = async (): Promise<never> => {
      throw new Error("Research I/O is unavailable during reassessment.");
    };
    const people = composePersonProfiles({
      workspaceDir,
      search: unavailable,
      complete: () => unavailable,
      confirmedTranscripts: () => [],
      transcriptStillConfirmed: () => false,
      researchEnabled: () => false,
    });
    const evidence = references.map((person) => {
      const previous = fullResearch.report.people.find((result) => result.slug === person.slug)!;
      const operationPath = join(
        dirname(fullResearch.path),
        `${basename(fullResearch.path, ".json")}-${person.slug}.operation.json`,
      );
      const operation = PersonResearchOperationOutcomeSchema.parse(read(operationPath));
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(operation.profileId))
        throw new Error(`Invalid reassessment profile identity: ${person.slug}`);
      const stored = queue.jobs.find((job) => job.profileId === operation.profileId)?.operation;
      if (
        previous.assessment?.operationId !== operation.operationId ||
        !manifest.completedOperationIds.includes(operation.operationId) ||
        !stored ||
        JSON.stringify(stored) !== JSON.stringify(operation)
      )
        throw new Error(`Reassessment operation/manifest mismatch: ${person.slug}`);
      if (
        previous.mode !== original.mode ||
        previous.operational.conclusion !== operation.conclusion ||
        previous.operational.rounds !== operation.rounds ||
        previous.operational.requests !== operation.requests ||
        previous.operational.modelCalls !== operation.modelCalls ||
        previous.operational.sourcesRetained !== operation.sourcesRetained
      )
        throw new Error(`Reassessment original operational outcome mismatch: ${person.slug}`);
      const profile = people.profiles.get(operation.profileId);
      if (!profile || profile.archivedAt)
        throw new Error(`Reassessment profile unavailable: ${person.slug}`);
      const dossier = people.research.dossier(operation.profileId, "private");
      const publicProjection = people.research.dossier(operation.profileId, "public");
      const sources = people.research.sources(operation.profileId);
      if (
        (dossier?.revision ?? 0) !== (operation.publishedDossierRevision ?? 0) ||
        (dossier?.claims.length ?? 0) !== previous.richness.claims ||
        sources.length !== previous.richness.sources ||
        dossier?.sourceIds.some((id) => !sources.some((source) => source.id === id))
      )
        throw new Error(`Reassessment dossier/source population mismatch: ${person.slug}`);
      if (JSON.stringify(dossier) !== JSON.stringify(publicProjection))
        throw new Error(`Reassessment refuses private dossier evidence: ${person.slug}`);
      return { person, previous, operation, dossier, publicProjection, sources };
    });
    const population = evidence.map((entry) => ({
      slug: entry.person.slug,
      profileId: entry.operation.profileId,
    }));
    if (
      !same(
        population.map((entry) => entry.profileId),
        people.profiles
          .search()
          .filter((profile) => !profile.archivedAt)
          .map((profile) => profile.id),
      )
    )
      throw new Error(
        "Reassessment workspace population differs from the selected report population.",
      );

    const carriedPeople = new Map<string, BenchmarkPersonResult>();
    const carriedScenarios = new Map<string, BenchmarkCollectionResult>();
    if (input.onlyFailed) {
      for (const { report } of lineage.reports) {
        const compatible =
          report.evidenceBundleHash === bundleHash &&
          report.mode === original.mode &&
          report.provenance.pipeline === original.provenance.pipeline &&
          report.provenance.corpusVersion === input.corpus.version &&
          report.provenance.judgeProvider === input.judgeProvider &&
          report.provenance.judgeModel === input.judgeModel &&
          report.provenance.judgeVersion === JUDGE_VERSION &&
          same(report.execution?.selected ?? [], selected) &&
          same(report.execution?.scenarioIds ?? [], original.execution!.scenarioIds) &&
          selected.every(
            (slug) =>
              report.provenance.referenceVersions[slug] ===
              original.provenance.referenceVersions[slug],
          );
        if (!compatible) continue;
        for (const person of report.people) {
          const phases = person.assessment?.phases;
          if (
            !carriedPeople.has(person.slug) &&
            person.assessment?.judge === "completed" &&
            person.assessment.integrity === "completed" &&
            person.assessment.operationId ===
              evidence.find((entry) => entry.person.slug === person.slug)?.operation.operationId &&
            (!phases ||
              (phases.reference.status === "completed" && phases.support.status === "completed"))
          )
            carriedPeople.set(person.slug, structuredClone(person));
        }
        for (const scenario of report.collection ?? [])
          if (
            !carriedScenarios.has(scenario.scenarioId) &&
            scenario.assessmentStatus === "completed"
          )
            carriedScenarios.set(scenario.scenarioId, structuredClone(scenario));
      }
    }
    if (input.timelineMinutes?.length) {
      const store = new PersonDossierStore(workspaceDir);
      for (const entry of evidence) {
        const revisions = [];
        for (let revision = 1; revision <= (entry.dossier?.revision ?? 0); revision += 1) {
          const dossier = store.getRevision(entry.operation.profileId, revision);
          if (dossier) revisions.push(dossier);
        }
        const points = await assessTimeline({
          person: entry.person,
          mode: original.mode,
          startedAt: entry.operation.startedAt,
          revisions,
          sources: entry.sources,
          minutes: input.timelineMinutes,
          judge: input.judge,
        });
        input.onTimeline?.(entry.person.slug, points, {
          runId: original.runId,
          evidenceBundleHash: bundleHash,
          judgeVersion: JUDGE_VERSION,
        });
      }
    }
    const retriedPeople: string[] = [];
    const retriedScenarios: string[] = [];
    const startedAt = new Date().toISOString();
    const id = runId(
      original.provenance.corpusVersion,
      original.mode,
      `${startedAt}:${original.runId}:reassess`,
    );
    let inputCharacters = 0;
    let outputCharacters = 0;
    const judge: CompleteJson = async (request) => {
      inputCharacters += request.system.length + request.user.length;
      const result = await input.judge(request);
      outputCharacters += JSON.stringify(result).length;
      return result;
    };
    const results: BenchmarkPersonResult[] = [];
    let collection: BenchmarkCollectionResult[] = [];
    let executionStatus: "completed" | "interrupted" = "interrupted";
    let statusDetail =
      "Retained research evidence reassessed; original operational outcomes preserved.";
    try {
      for (const entry of evidence) {
        const carried = carriedPeople.get(entry.person.slug);
        if (!carried) retriedPeople.push(entry.person.slug);
        const result =
          carried ??
          (await assessPerson(entry.person, original.mode, {
            ...entry,
            judge,
            elapsedMilliseconds: entry.previous.operational.elapsedMilliseconds,
          }));
        result.operational = entry.previous.operational;
        results.push(result);
        input.onPerson?.(
          BenchmarkPersonArtifactSchema.parse({
            schemaVersion: 1,
            runId: id,
            corpusVersion: input.corpus.version,
            pipeline: original.provenance.pipeline,
            judgeProvider: input.judgeProvider,
            judgeModel: input.judgeModel,
            judgeVersion: JUDGE_VERSION,
            assessedAt: new Date().toISOString(),
            reassessmentOf: original.runId,
            result,
          }),
          entry.operation,
        );
      }
      collection = await evaluateCollection(people, population, input.corpus.scenarios, {
        references,
        judge,
        carried: carriedScenarios,
        onScenario: (result) => {
          collection.push(result);
          if (!carriedScenarios.has(result.scenarioId)) retriedScenarios.push(result.scenarioId);
        },
      });
      executionStatus = "completed";
    } catch (error) {
      statusDetail = `Reassessment interrupted: ${error instanceof Error ? error.message : "unknown error"}`;
    }
    const status =
      executionStatus === "interrupted"
        ? "interrupted"
        : results.some((result) => result.failure !== null) ||
            collection.some((result) => result.assessmentStatus !== "completed")
          ? "failed"
          : "completed";
    return BenchmarkReportSchema.parse({
      ...original,
      runId: id,
      evidenceBundleHash: bundleHash,
      status,
      statusDetail,
      execution: {
        status: executionStatus,
        selected,
        evaluated: results.length,
        assessed: results.filter(
          (result) =>
            result.assessment?.judge === "completed" && result.assessment.integrity === "completed",
        ).length,
        scenarioIds: input.corpus.scenarios.map((scenario) => scenario.id),
      },
      selection: { ...original.selection, evaluated: results.map((result) => result.slug) },
      provenance: {
        ...original.provenance,
        judgeProvider: input.judgeProvider,
        judgeModel: input.judgeModel,
        judgeVersion: JUDGE_VERSION,
      },
      reassessment: {
        originalRunId: original.runId,
        originalReportHash: saved.hash,
        originalProvenance: original.provenance,
        evidenceManifestHash: hash(manifestText),
        lineage: {
          root: lineage.root,
          parent: relative(lineage.root, resolve(input.reportPath)),
          parentHash: saved.hash,
        },
        resume: {
          carriedPeople: results
            .filter((result) => carriedPeople.has(result.slug))
            .map((result) => result.slug),
          retriedPeople,
          carriedScenarios: collection
            .filter((result) => carriedScenarios.has(result.scenarioId))
            .map((result) => result.scenarioId),
          retriedScenarios,
        },
        startedAt,
        finishedAt: new Date().toISOString(),
        inputCharacters,
        outputCharacters,
        tokens: "unavailable",
        cost: "unavailable",
      },
      people: results,
      collection,
      groups: summarizeGroups(references, results),
      remainingMisses: remainingMisses(references, results),
    });
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}
