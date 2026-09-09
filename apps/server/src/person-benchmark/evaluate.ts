import { canonicalSourceUrl } from "../source-adapters/source-identity.js";
import { WorkLimiter } from "../person-profile/work-limiter.js";
import { createHash } from "node:crypto";
import {
  BENCHMARK_DOSSIER_REQUIREMENTS,
  type BenchmarkMode,
  type BenchmarkPerson,
  type BenchmarkPersonResult,
  type BenchmarkModelAttempt,
  type PersonProfile,
  type PersonDossier,
  type PersonSourceDocument,
  type PersonResearchOperationOutcome,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../llm/providers.js";
import type { PublicSearch, PublicSearchResult } from "../source-adapters/search.js";
import type { BrowserRenderer } from "../source-adapters/browser.js";
import {
  composePersonProfiles,
  type PersonProfilesComposition,
} from "../person-profile/composition.js";
import { archivedCaptureDate, type readPersonSource } from "../person-profile/research-readers.js";
import { isolatedLookup } from "./corpus.js";
import { checkIntegrity, criticalCount } from "./integrity.js";
import { judgePerson } from "./judge.js";
import { sourceContributions } from "./source-contributions.js";

/**
 * What the evaluator needs to run one Benchmark Person through production.
 *
 * There is deliberately no research implementation here: the evaluator builds
 * the ordinary Person Profiles composition over an isolated Workspace and asks
 * it for an operation. Everything it measures is what the product actually
 * did (#228: "the evaluator must not maintain a second discovery, attribution,
 * extraction or dossier-synthesis implementation").
 */
export interface EvaluationPorts {
  /** A temporary directory. Never a live Workspace. */
  workspaceDir: string;
  search: PublicSearch;
  complete: () => CompleteJson;
  plan?: () => CompleteJson;
  /** The separately configured semantic judge. */
  judge: CompleteJson;
  render?: BrowserRenderer;
  /** Seed and reader overrides, used to reconstruct the incumbent pipeline. */
  seeds?: (profile: PersonProfile) => string[];
  readSource?: typeof readPersonSource;
  /** Bounds handed to the operation, recorded in the report's provenance. */
  settings?: { profileCalls?: number; profileMilliseconds?: number; readConcurrency?: number };
}

/**
 * Fixed-document mode.
 *
 * Discovery is replaced by the person's own retained reference excerpts, and
 * reading returns those excerpts verbatim at their real URLs. Everything after
 * the read — identity matching, extraction, attribution, publication — is the
 * production path, so a gap here is a downstream failure rather than a search
 * failure. The reference *facts* are never exposed: only the documents.
 */
function fixedDocumentPorts(person: BenchmarkPerson): {
  search: PublicSearch;
  readSource: typeof readPersonSource;
} {
  const documents = person.documents;
  const search: PublicSearch = async (query) => {
    const words = query
      .replace(/["']/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2);
    const results: PublicSearchResult[] = documents
      .filter((document) => {
        const haystack = `${document.title} ${document.excerpt}`.toLowerCase();
        return words.length === 0 || words.some((word) => haystack.includes(word));
      })
      .map((document) => ({
        url: document.url,
        title: document.title,
        snippet: document.excerpt.slice(0, 400),
      }));
    return results;
  };
  const readSource: typeof readPersonSource = async (url, snippet) => {
    const document = documents.find(
      (entry) => canonicalSourceUrl(entry.url) === canonicalSourceUrl(url),
    );
    if (!document)
      return {
        text: snippet,
        capturedAt: null,
        completeness: "unavailable",
        access: "failed",
        outboundUrls: [],
        family: "documents-publishers",
        route: "fixed-document",
        upstreamIndex: null,
        publishedAt: null,
        author: null,
        anchors: [],
        provenanceNote: "Not part of this person's retained reference corpus.",
        sourceVersion: null,
        rights: null,
        finalUrl: url,
      };
    return {
      text: document.excerpt,
      /* A reference document captured from a web archive is dated by its
         capture here too: fixed-document mode replaces retrieval, never the
         rule that archived evidence is evidence about its capture date. */
      capturedAt: archivedCaptureDate(document.url),
      completeness: "partial",
      access: "retrieved",
      outboundUrls: [],
      family: document.family,
      route: "fixed-document",
      upstreamIndex: document.publisher,
      publishedAt: document.publishedAt,
      author: null,
      anchors: [],
      provenanceNote: `Retained reference excerpt of ${document.url}, ${document.rights}.`,
      sourceVersion: null,
      rights: null,
      finalUrl: document.url,
    };
  };
  return { search, readSource };
}

export interface PersonEvaluation {
  profileId: string;
  result: BenchmarkPersonResult;
  /** The operation record behind the result, for the failure breakdown. */
  operation: PersonResearchOperationOutcome | null;
}

/**
 * Evaluate one Benchmark Person.
 *
 * The order matters: research runs first with no access to the reference, then
 * the deterministic integrity checks run over what it produced, and only then
 * does the judge see anything. A failed integrity check is recorded whatever
 * the judge later says about the same claim.
 */
export async function evaluatePerson(
  person: BenchmarkPerson,
  mode: BenchmarkMode,
  ports: EvaluationPorts,
): Promise<PersonEvaluation> {
  const people = composeEvaluation(
    ports,
    1,
    mode === "fixed-documents" ? fixedDocumentPorts(person) : null,
  );
  const profile = people.research.startFor(isolatedLookup(person));
  return evaluateInComposition(person, mode, ports, people, profile.id);
}

function composeEvaluation(
  ports: EvaluationPorts,
  concurrency: number,
  fixed: ReturnType<typeof fixedDocumentPorts> | null = null,
): PersonProfilesComposition {
  const people: PersonProfilesComposition = composePersonProfiles({
    workspaceDir: ports.workspaceDir,
    search: fixed?.search ?? ports.search,
    complete: ports.complete,
    /* Fixed-document mode isolates downstream quality over a supplied corpus.
       Asking for internet targets here cannot add evidence and confounds that
       measurement with adaptive discovery. Live mode keeps the real planner. */
    ...(ports.plan && !fixed ? { plan: ports.plan } : {}),
    ...(ports.render && !fixed ? { render: ports.render } : {}),
    /* One seam, two uses: fixed-document mode replaces retrieval with the
       retained excerpts, and the incumbent baseline replaces it with the two
       readers that pipeline had. Everything downstream stays production. */
    researchTestPorts: {
      ...(fixed
        ? { readSource: fixed.readSource }
        : ports.readSource
          ? { readSource: ports.readSource }
          : {}),
      ...(ports.seeds ? { seeds: ports.seeds } : {}),
    },
    confirmedTranscripts: () => [],
    transcriptStillConfirmed: () => false,
    researchEnabled: () => true,
  });
  people.queue.configure({
    paused: false,
    concurrency,
    ...(ports.settings?.profileCalls !== undefined
      ? { profileCalls: ports.settings.profileCalls }
      : {}),
    ...(ports.settings?.profileMilliseconds !== undefined
      ? { profileMilliseconds: ports.settings.profileMilliseconds }
      : {}),
    ...(ports.settings?.readConcurrency !== undefined
      ? { readConcurrency: ports.settings.readConcurrency }
      : {}),
  });

  return people;
}

/** Live workers share the actual queue, stores, source cooldowns and model ports. */
export async function evaluateLivePopulation(
  selected: BenchmarkPerson[],
  ports: EvaluationPorts & {
    concurrency: number;
    onStarted?: (person: BenchmarkPerson, index: number) => void;
    onEvaluated?: (evaluation: PersonEvaluation, index: number) => void;
  },
): Promise<{ people: PersonProfilesComposition; evaluations: PersonEvaluation[] }> {
  if (!Number.isInteger(ports.concurrency) || ports.concurrency < 1 || ports.concurrency > 4)
    throw new Error("Live benchmark concurrency must be an integer from 1 to 4.");
  if (new Set(selected.map((person) => person.slug)).size !== selected.length)
    throw new Error("Live benchmarking requires unique selected Benchmark People.");
  const people = composeEvaluation(ports, ports.concurrency);
  const profiles = selected.map((person) => people.research.startFor(isolatedLookup(person)));
  if (new Set(profiles.map((profile) => profile.id)).size !== selected.length)
    throw new Error("Selected Benchmark People resolved to duplicate canonical Profiles.");
  const evaluations: PersonEvaluation[] = new Array<PersonEvaluation>(selected.length);
  let next = 0;
  const judgeWork = new WorkLimiter(ports.concurrency);
  const assessments: Promise<void>[] = [];
  const workers = Array.from({ length: Math.min(ports.concurrency, selected.length) }, async () => {
    while (next < selected.length) {
      const index = next++;
      const person = selected[index]!;
      ports.onStarted?.(person, index);
      const assess = await researchInComposition(
        person,
        "live-discovery",
        ports,
        people,
        profiles[index]!.id,
      );
      const assessment = judgeWork.run(async () => {
        const evaluation = await assess();
        evaluations[index] = evaluation;
        ports.onEvaluated?.(evaluation, index);
      });
      // Attach a rejection handler immediately; all outcomes are checked below,
      // after both queues drain, before callers may remove the workspace.
      void assessment.catch(() => {});
      assessments.push(assessment);
    }
  });
  // An output/assessment failure must not let the CLI delete a workspace while
  // another accepted operation still has I/O or publication in flight.
  const settled = await Promise.allSettled(workers);
  const judged = await Promise.allSettled(assessments);
  const failure = [...settled, ...judged].find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return { people, evaluations };
}

async function evaluateInComposition(
  person: BenchmarkPerson,
  mode: BenchmarkMode,
  ports: EvaluationPorts,
  people: PersonProfilesComposition,
  profileId: string,
): Promise<PersonEvaluation> {
  return (await researchInComposition(person, mode, ports, people, profileId))();
}

async function researchInComposition(
  person: BenchmarkPerson,
  mode: BenchmarkMode,
  ports: EvaluationPorts,
  people: PersonProfilesComposition,
  profileId: string,
): Promise<() => Promise<PersonEvaluation>> {
  const startedAt = Date.now();
  let failure: string | null = null;
  let operation: PersonResearchOperationOutcome | null = null;
  try {
    operation = await people.research.runNow(profileId);
  } catch (error) {
    failure = `Research failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }

  if (!operation || operation.conclusion !== "completed")
    failure ??= `Research ${operation?.conclusion ?? "interrupted"} before the operation completed.`;

  const dossier = people.research.dossier(profileId, "private");
  const sources = people.research.sources(profileId);
  const evidence = {
    dossier,
    sources,
    publicProjection: people.research.dossier(profileId, "public"),
    operation,
    judge: ports.judge,
    elapsedMilliseconds: Date.now() - startedAt,
    failure,
  };
  return async () => {
    const result = await assessPerson(person, mode, evidence);
    return { result, operation, profileId };
  };
}

/** Assess retained production evidence without initiating research. */
export async function assessPerson(
  person: BenchmarkPerson,
  mode: BenchmarkMode,
  evidence: {
    dossier: PersonDossier | null;
    sources: PersonSourceDocument[];
    publicProjection: PersonDossier | null;
    operation: PersonResearchOperationOutcome | null;
    judge: CompleteJson;
    elapsedMilliseconds: number;
    failure?: string | null;
  },
): Promise<BenchmarkPersonResult> {
  const { dossier, sources, operation } = evidence;
  let failure =
    evidence.failure ??
    (operation?.conclusion === "completed"
      ? null
      : `Research ${operation?.conclusion ?? "interrupted"} before the operation completed.`);
  const integrity = checkIntegrity(dossier, sources, evidence.publicProjection);

  let judged;
  let judgeCompleted = false;
  const modelAttempts: BenchmarkModelAttempt[] = [];
  let judgeCalls = 0;
  const observedJudge: CompleteJson = (request) => {
    const call = ++judgeCalls;
    return evidence.judge({
      ...request,
      retry: {
        onAttempt: (observation) =>
          modelAttempts.push({
            call,
            subject: person.slug,
            observation,
            inputCharacters: request.system.length + request.user.length,
          }),
      },
    });
  };
  try {
    judged = await judgePerson(observedJudge, person, dossier, sources);
    judgeCompleted = judged.complete;
    if (!judgeCompleted) failure ??= judged.incompleteReason ?? "Judge assessment was incomplete.";
  } catch (error) {
    const judgeFailure =
      `Judge reference assessment failed: ${error instanceof Error ? error.message : "unknown error"}`.slice(
        0,
        2000,
      );
    failure ??= judgeFailure;
    judged = {
      phases: {
        reference: { status: "failed" as const, judgements: [], failure: judgeFailure },
        support: { status: "not-attempted" as const, failure: null },
      },
      judgements: person.facts.map((fact) => ({
        factId: fact.id,
        verdict: "ambiguous" as const,
        referenceQuote: fact.support[0]?.quote ?? fact.statement,
        evidenceQuote: null,
        claimId: null,
        rationale: "The judge did not return a usable verdict for this run.",
        reviewRequired: true,
      })),
      overclaims: [],
      usefulness: {
        understanding: 0,
        remainingQuestions: 0,
        conversationReadiness: 0,
        rationale: "Not assessed: the judge failed for this person.",
        reviewRequired: true,
      },
    };
  }

  let supportAssessmentFailed = 0;
  const verdicts = judged.judgements.map((judgement) => {
    const supportIncomplete = judged.phases.support.status !== "completed";
    const overclaimed = judged.overclaims.some((finding) => finding.claimId === judgement.claimId);
    const failedChecks = [
      ...new Set(
        integrity.findings
          .filter(
            (finding) => finding.severity === "critical" && finding.subject === judgement.claimId,
          )
          .map((finding) => finding.check),
      ),
    ];
    if (
      (failedChecks.length === 0 && !supportIncomplete && !overclaimed) ||
      (judgement.verdict !== "recovered" && judgement.verdict !== "partial")
    )
      return judgement;
    /* #271: the verdict stays withheld exactly as ADR-0067 wrote it, but the
       headline counts must not blur an upstream support-phase failure into
       semantic ambiguity, so the downgrades it caused are counted apart. */
    if (supportIncomplete) supportAssessmentFailed += 1;
    // Semantic agreement cannot turn a broken evidence record into recovery.
    // Preserve the judge's decision for review before computing every aggregate.
    const reasons = [
      ...(overclaimed
        ? [
            "the matched claim has a validated overclaim finding, including findings requiring review",
          ]
        : []),
      ...(failedChecks.length
        ? [`the matched claim failed critical integrity checks: ${failedChecks.join(", ")}`]
        : []),
      ...(supportIncomplete
        ? ["support/usefulness assessment did not complete; positive recovery credit is withheld"]
        : []),
    ];
    const explanation = `Original semantic verdict: ${judgement.verdict}; downgraded to ambiguous because ${reasons.join("; ")}. `;
    return {
      ...judgement,
      verdict: "ambiguous" as const,
      reviewRequired: true,
      rationale: `${explanation}${judgement.rationale}`.slice(0, 2000),
    };
  });
  const counted = (verdict: string) =>
    verdicts.filter((judgement) => judgement.verdict === verdict).length;
  const recoveredIds = new Set(
    verdicts.filter((judgement) => judgement.verdict === "recovered").map((j) => j.factId),
  );

  const byAcquisition: BenchmarkPersonResult["completeness"]["byAcquisition"] = {};
  for (const fact of person.facts) {
    const bucket = (byAcquisition[fact.acquisition] ??= { total: 0, recovered: 0 });
    bucket.total += 1;
    if (recoveredIds.has(fact.id)) bucket.recovered += 1;
  }
  const byRequirement: BenchmarkPersonResult["completeness"]["byRequirement"] = {};
  for (const fact of person.facts)
    for (const requirement of fact.requirements) {
      const bucket = (byRequirement[requirement] ??= { total: 0, recovered: 0 });
      bucket.total += 1;
      if (recoveredIds.has(fact.id)) bucket.recovered += 1;
    }

  const failuresByCode: Record<string, number> = {};
  for (const attempt of operation?.attempts ?? [])
    if (attempt.outcome === "failed")
      failuresByCode[attempt.code] = (failuresByCode[attempt.code] ?? 0) + 1;

  const result: BenchmarkPersonResult = {
    slug: person.slug,
    referenceVersion: person.referenceVersion,
    mode,
    failure,
    sourceContributions: sourceContributions(
      dossier,
      sources,
      verdicts,
      new Set([
        ...integrity.findings
          .filter((finding) => finding.severity === "critical")
          .map((finding) => finding.subject),
        ...judged.overclaims.map((overclaim) => overclaim.claimId),
      ]),
    ),
    assessment: {
      operationId: operation?.operationId ?? null,
      integrity: "completed",
      judge: judgeCompleted ? "completed" : "failed",
      phases: judged.phases,
      modelAttempts,
    },
    factualReliability: {
      verifiedCitations: integrity.verifiedCitations,
      totalCitations: integrity.totalCitations,
      integrityFindings: integrity.findings.slice(0, 200),
      criticalFindings: criticalCount(integrity.findings),
      criticalFindingKeys: integrity.findings
        .filter((finding) => finding.severity === "critical")
        .map((finding) => finding.fingerprint ?? `${finding.check}:${finding.detail}`),
      overclaims: judged.overclaims,
      wrongPersonAttributions: judged.overclaims.filter((entry) => entry.kind === "wrong-person")
        .length,
      contradictedFacts: counted("contradicted"),
    },
    completeness: {
      referenceFacts: person.facts.length,
      recovered: counted("recovered"),
      partial: counted("partial"),
      missing: counted("missing"),
      ambiguous: counted("ambiguous"),
      ambiguousSupportAssessmentFailed: supportAssessmentFailed,
      byAcquisition,
      byRequirement,
      judgements: verdicts,
    },
    richness: {
      claims: dossier?.claims.length ?? 0,
      works: dossier?.works.length ?? 0,
      expertise: dossier?.expertise.length ?? 0,
      connections: dossier?.connections.length ?? 0,
      sources: sources.length,
      distinctFamilies: new Set(sources.map((source) => source.evidenceFamily ?? "unclassified"))
        .size,
      /* Independence is counted from the upstream index, not the hostname:
         several wrappers over one index are one piece of evidence. */
      distinctUpstreamIndexes: new Set(
        sources.map((source) => source.upstreamIndex ?? source.family),
      ).size,
      sectionsWithGroundedSummary: (dossier?.sections ?? []).filter(
        (section) => section.claimIds.length > 0,
      ).length,
    },
    usefulness: judged.usefulness,
    operational: {
      conclusion: operation?.conclusion ?? "interrupted",
      rounds: operation?.rounds ?? 0,
      requests: operation?.requests ?? 0,
      modelCalls: operation?.modelCalls ?? 0,
      sourcesRetained: operation?.sourcesRetained ?? 0,
      leadsInvestigated: (operation?.leads ?? []).filter(
        (lead) => lead.disposition === "investigated",
      ).length,
      leadsUnresolved: (operation?.leads ?? []).filter(
        (lead) => lead.disposition === "pending" || lead.disposition === "interrupted",
      ).length,
      failuresByCode,
      coverageGaps: operation?.gaps ?? [],
      elapsedMilliseconds: evidence.elapsedMilliseconds,
    },
  };
  return result;
}

/** A stable run identity from what the run was actually over. */
export function runId(corpusVersion: string, mode: BenchmarkMode, startedAt: string): string {
  return createHash("sha256")
    .update(`${corpusVersion}:${mode}:${startedAt}`)
    .digest("hex")
    .slice(0, 16);
}

/** The requirement label, for reports that name a requirement by its id. */
export function requirementLabel(requirement: string): string {
  return (
    (BENCHMARK_DOSSIER_REQUIREMENTS as Partial<Record<string, string>>)[requirement] ?? requirement
  );
}
