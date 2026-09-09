import { z } from "zod/v3";
import { ModelAttemptEventSchema } from "./llm.js";
import {
  PERSON_SOURCE_FAMILIES,
  PersonResearchLeadSchema,
  type PersonSourceFamily,
} from "./person-research.js";

/** Wire attempts observed while assessing one public benchmark subject. */
export const BenchmarkModelAttemptSchema = z.object({
  call: z.number().int().positive(),
  subject: z.string().max(80),
  observation: ModelAttemptEventSchema,
  /** Request text characters of the logical call this attempt belongs to. */
  inputCharacters: z.number().nonnegative().optional(),
});
export type BenchmarkModelAttempt = z.infer<typeof BenchmarkModelAttemptSchema>;

/** Independently authored positive expectations, never a census of absent capabilities. */
export const BenchmarkCollectionScenarioSchema = z.object({
  id: z.string().min(1).max(80),
  categories: z.array(z.string().min(1).max(200)).min(2).max(10),
  expected: z
    .array(
      z.object({
        slug: z.string().min(1).max(80),
        factIds: z.array(z.string().min(1).max(80)).min(1).max(20),
      }),
    )
    .min(1)
    .max(200),
  rationale: z.string().min(1).max(2000),
});
export type BenchmarkCollectionScenario = z.infer<typeof BenchmarkCollectionScenarioSchema>;

export const BenchmarkCollectionAssessmentSchema = z.object({
  slug: z.string().max(80),
  verdict: z.enum(["supported", "unsupported", "ambiguous"]),
  rationale: z.string().max(2000),
  evidence: z
    .array(
      z.object({
        category: z.string().max(200),
        claimId: z.string().max(200),
        quote: z.string().max(2000),
        referenceFactId: z.string().max(80),
        referenceQuote: z.string().max(2000),
      }),
    )
    .max(20),
});

const CollectionMatchSchema = z.object({
  slug: z.string(),
  claimIds: z.array(z.string()),
  workIds: z.array(z.string()),
  citations: z.array(
    z.object({ sourceId: z.string(), quote: z.string(), url: z.string(), hash: z.string() }),
  ),
  gaps: z.array(z.string()),
});
export const BenchmarkCollectionResultSchema = z.object({
  /** Absent on historical reports, which cannot establish complete assessment. */
  assessmentStatus: z.enum(["completed", "failed"]).optional(),
  modelAttempts: z.array(BenchmarkModelAttemptSchema).max(1000).optional(),
  scenarioId: z.string(),
  requirement: z.literal("r18"),
  categories: z.array(z.string()),
  expectedMatches: z.array(z.string()),
  recoveredMatches: z.array(z.string()),
  missingMatches: z.array(z.string()),
  additionalMatchesForReview: z.array(z.string()),
  assessments: z.array(BenchmarkCollectionAssessmentSchema),
  demonstrated: z.array(CollectionMatchSchema),
  claimed: z.array(CollectionMatchSchema),
  coverage: z.object({
    activeProfiles: z.number().int().nonnegative(),
    researchedProfiles: z.number().int().nonnegative(),
    demonstrated: z.number().int().nonnegative(),
    claimedOnly: z.number().int().nonnegative(),
  }),
  scope: z.string(),
});
export type BenchmarkCollectionResult = z.infer<typeof BenchmarkCollectionResultSchema>;

/**
 * The Person Research Benchmark (issue #228).
 *
 * A Benchmark Person is an independently researched reference for one public
 * person: dated facts, each anchored to a retained excerpt of a real dated
 * source, plus the conclusions that evidence does *not* justify. References
 * describe a strong research outcome, so a fact the application cannot
 * currently acquire stays in the reference and becomes a visible target.
 * Nothing here is generated from the application's own answers.
 */

/**
 * The twenty dossier depth requirements from issue #204, kept verbatim in
 * meaning so a benchmark fact can name the requirement it exercises and the
 * collection can be checked for coverage of all twenty.
 */
export const BENCHMARK_DOSSIER_REQUIREMENTS = {
  r1: "Personal contribution distinguished from team output",
  r2: "Sourced operating magnitudes with unit, scope and date",
  r3: "Claimed and demonstrated expertise in one taxonomy",
  r4: "Counterparties, relation type, shared work and dates",
  r5: "Documented constraint environments",
  r6: "Work followed after departure",
  r7: "Dated history of problem areas and focus",
  r8: "Writing and thinking separated from building",
  r9: "Independent verifiers and the exact assertion verified",
  r10: "Per-section freshness and explicit gaps",
  r11: "Deciding, recommending and executing distinguished",
  r12: "Unsuccessful work and postmortems",
  r13: "Repeated collaboration evidenced by distinct shared work",
  r14: "Third-party credit and acknowledgments",
  r15: "Dated governance, funding and advisory ties",
  r16: "Dated observed artifacts by kind",
  r17: "Individually dated domain crossings",
  r18: "Capability intersections reported with denominators",
  r19: "Documented availability constraints",
  r20: "Source composition and single-source dependency",
} as const;
export type BenchmarkDossierRequirement = keyof typeof BENCHMARK_DOSSIER_REQUIREMENTS;
export const BenchmarkDossierRequirementSchema = z.enum(
  Object.keys(BENCHMARK_DOSSIER_REQUIREMENTS) as [
    BenchmarkDossierRequirement,
    ...BenchmarkDossierRequirement[],
  ],
);

/** The industry groups the collection is deliberately balanced across. */
export const BENCHMARK_INDUSTRY_GROUPS = {
  healthcare: "Healthcare",
  education: "Education",
  finance: "Finance and professional services",
  manufacturing: "Manufacturing and logistics",
  construction: "Construction and property",
  retail: "Retail and hospitality",
  agriculture: "Agriculture and food",
  media: "Media and creative work",
  government: "Government and nonprofits",
  technology: "Technology and telecommunications",
} as const;
export type BenchmarkIndustryGroup = keyof typeof BENCHMARK_INDUSTRY_GROUPS;

/**
 * How the person's public evidence is shaped. Easy, richly documented cases
 * cannot conceal systematic failure, so the collection deliberately carries
 * the awkward shapes as their own labelled kind.
 */
export const BenchmarkFootprintSchema = z.enum([
  "rich",
  "ordinary",
  "sparse",
  "ambiguous",
  "social-first",
  "video-first",
  "records-first",
]);
export type BenchmarkFootprint = z.infer<typeof BenchmarkFootprintSchema>;

/**
 * Whether the application can plausibly acquire the fact's support today.
 * Authoring records the honest answer; the evaluator reports recovery split
 * both ways so a reference that exceeds current coverage drives work instead
 * of being quietly deleted to make a run look better.
 */
export const BenchmarkAcquisitionSchema = z.enum(["app-supported", "beyond-current-coverage"]);

/**
 * A retained excerpt of one real, dated source.
 *
 * The excerpt is what makes the reference judgeable without re-fetching the
 * web: fixed-document mode feeds these through the production reader, and the
 * deterministic integrity checks verify every reference quote occurs in one.
 */
export const BenchmarkReferenceDocumentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  url: z.string().max(4000),
  title: z.string().min(1).max(500),
  publisher: z.string().max(300),
  /** The source's own publication date, when it states one. */
  publishedAt: z.string().max(40).nullable(),
  /** When this excerpt was retained. Immutable once a version is published. */
  retrievedAt: z.string().max(40),
  family: z.enum(
    Object.keys(PERSON_SOURCE_FAMILIES) as [PersonSourceFamily, ...PersonSourceFamily[]],
  ),
  sourceClass: z.enum(["self-report", "independent-account", "primary-artifact"]),
  language: z.string().max(20),
  /** SHA-256 of `excerpt`; a corrected excerpt is a new reference version. */
  hash: z.string().length(64),
  /** A bounded excerpt retained under quotation. Never a whole work. */
  excerpt: z.string().min(1).max(20000),
  /** Why retaining this excerpt is permitted. */
  rights: z.enum(["short-quotation", "public-record", "open-licence", "public-domain"]),
  note: z.string().max(1000).optional(),
});
export type BenchmarkReferenceDocument = z.infer<typeof BenchmarkReferenceDocumentSchema>;

/** One reference fact: what strong research should recover, and from where. */
export const BenchmarkReferenceFactSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  /** Which of the twenty dossier requirements this fact exercises. */
  requirements: z.array(BenchmarkDossierRequirementSchema).min(1).max(6),
  section: z.enum([
    "overview",
    "career",
    "work",
    "expertise",
    "ideas",
    "connections",
    "recognition",
    "context",
  ]),
  /** The fact itself, stated as a reader would want it. */
  statement: z.string().min(1).max(2000),
  /** Dates the fact holds for, where the source states them. */
  effectiveFrom: z.string().max(40).nullable(),
  effectiveTo: z.string().max(40).nullable(),
  /** Verbatim support. Every quote must occur in the named document. */
  support: z
    .array(z.object({ documentId: z.string().max(80), quote: z.string().min(8).max(4000) }))
    .min(1)
    .max(6),
  importance: z.enum(["core", "supporting"]),
  acquisition: BenchmarkAcquisitionSchema,
  /** Why this fact is beyond current coverage, when it is. */
  note: z.string().max(1000).optional(),
});
export type BenchmarkReferenceFact = z.infer<typeof BenchmarkReferenceFactSchema>;

/**
 * A conclusion the evidence does not justify. A dossier asserting one of these
 * is an overclaim, not a bonus: the evaluator counts it against factual
 * reliability rather than rewarding the extra volume.
 */
export const BenchmarkUnjustifiedConclusionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  statement: z.string().min(1).max(2000),
  /** Why the available evidence does not establish it. */
  why: z.string().min(1).max(2000),
  kind: z.enum([
    "scope-inflation",
    "wrong-person",
    "unsupported-inference",
    "stale-as-current",
    "team-output-as-personal",
  ]),
});
export type BenchmarkUnjustifiedConclusion = z.infer<typeof BenchmarkUnjustifiedConclusionSchema>;

/**
 * What live research is allowed to see. Realistic lookup inputs only: the
 * reference facts, the expected source list and the evaluator's judgments are
 * never visible to the pipeline under test.
 */
export const BenchmarkLookupSchema = z.object({
  fullName: z.string().min(1).max(200),
  employerHint: z.string().max(200).nullable(),
  profileUrls: z.array(z.string().max(4000)).max(4),
  emails: z.array(z.string().max(320)).max(2),
});
export type BenchmarkLookup = z.infer<typeof BenchmarkLookupSchema>;

export const BenchmarkPersonSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
  /** Immutable version of this reference; a corrected fact bumps it. */
  referenceVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
  displayName: z.string().min(1).max(200),
  industry: z.enum(
    Object.keys(BENCHMARK_INDUSTRY_GROUPS) as [BenchmarkIndustryGroup, ...BenchmarkIndustryGroup[]],
  ),
  role: z.string().min(1).max(200),
  region: z.string().min(1).max(120),
  /** BCP-47-ish primary language of the person's public evidence. */
  language: z.string().min(2).max(20),
  footprint: BenchmarkFootprintSchema,
  /** True only for the fictional adversarial fixtures, which say so loudly. */
  fictional: z.boolean().default(false),
  lookup: BenchmarkLookupSchema,
  /** What establishes that a document is about this person and not a namesake. */
  identityAnchors: z.array(z.string().min(1).max(1000)).min(1).max(12),
  /** Namesakes and near-matches whose achievements must not be absorbed. */
  confusableWith: z.array(z.string().min(1).max(500)).max(10).default([]),
  documents: z.array(BenchmarkReferenceDocumentSchema).min(1).max(40),
  facts: z.array(BenchmarkReferenceFactSchema).min(1).max(120),
  unjustified: z.array(BenchmarkUnjustifiedConclusionSchema).max(20).default([]),
  /**
   * Dimensions honestly unavailable for this person. Authoring records them
   * rather than manufacturing a fact to fill the requirement checklist.
   */
  unavailable: z
    .array(
      z.object({
        requirement: BenchmarkDossierRequirementSchema,
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(20)
    .default([]),
  /** Corrections traced to their evidence, newest last. */
  corrections: z
    .array(
      z.object({
        at: z.string().max(40),
        referenceVersion: z.string().max(40),
        change: z.string().min(1).max(2000),
        evidence: z.string().min(1).max(2000),
      }),
    )
    .max(40)
    .default([]),
});
export type BenchmarkPerson = z.infer<typeof BenchmarkPersonSchema>;

/* ------------------------------------------------------------------ */
/* Evaluation results                                                   */
/* ------------------------------------------------------------------ */

export const BenchmarkModeSchema = z.enum(["live-discovery", "fixed-documents"]);
export type BenchmarkMode = z.infer<typeof BenchmarkModeSchema>;

/**
 * A deterministic integrity finding. These cannot be overridden by the judge:
 * a citation that does not occur in its retained source version is a broken
 * record whatever a model thinks of the sentence it supports.
 */
export const BenchmarkIntegrityFindingSchema = z.object({
  /** Stable evidence identity, excluding generated claim/source IDs. */
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  check: z.enum([
    "citation-quote-present",
    "citation-source-retained",
    "citation-source-version",
    "claim-status-supported",
    "work-claim-reference",
    "private-evidence-isolation",
    "reference-quote-present",
  ]),
  severity: z.enum(["critical", "major", "minor"]),
  subject: z.string().max(500),
  detail: z.string().max(2000),
});
export type BenchmarkIntegrityFinding = z.infer<typeof BenchmarkIntegrityFindingSchema>;

/**
 * One semantic judgment about one reference fact, always carrying the
 * reference text and the evaluated evidence it rests on. `ambiguous` is a
 * first-class verdict: an uncertain model decision is surfaced for review
 * rather than rounded into a pass or a fail.
 */
export const BenchmarkJudgementSchema = z.object({
  factId: z.string().max(80),
  verdict: z.enum(["recovered", "partial", "missing", "contradicted", "ambiguous"]),
  /** The reference quote the judgment was made against. */
  referenceQuote: z.string().max(4000),
  /** The dossier text the judge matched, when it found one. */
  evidenceQuote: z.string().max(4000).nullable(),
  /** The dossier claim the evidence came from, when one applies. */
  claimId: z.string().max(200).nullable(),
  rationale: z.string().max(2000),
  reviewRequired: z.boolean(),
});
export type BenchmarkJudgement = z.infer<typeof BenchmarkJudgementSchema>;

/** A dossier statement the judge found unsupported by its own citations. */
export const BenchmarkOverclaimSchema = z.object({
  claimId: z.string().max(200),
  statement: z.string().max(2000),
  kind: z.enum([
    "scope-inflation",
    "wrong-person",
    "unsupported-inference",
    "stale-as-current",
    "team-output-as-personal",
    "invented-evidence",
  ]),
  citedQuote: z.string().max(4000).nullable(),
  /** Absent in legacy reports. For validated findings, null means the claim has no citations. */
  citationIndex: z.number().int().min(0).max(29).nullable().optional(),
  citedSourceId: z.string().max(200).nullable().optional(),
  rationale: z.string().max(2000),
  /** Set when this matches a reference's recorded unjustified conclusion. */
  matchedUnjustifiedId: z.string().max(80).nullable(),
  reviewRequired: z.boolean(),
});
export type BenchmarkOverclaim = z.infer<typeof BenchmarkOverclaimSchema>;

/** Observed production sources and supported recovery, not reference-person demographics. */
export const BenchmarkSourceContributionSchema = z.object({
  family: z.enum([
    "unclassified",
    ...(Object.keys(PERSON_SOURCE_FAMILIES) as PersonSourceFamily[]),
  ]),
  sources: z
    .array(
      z.object({
        id: z.string().max(200),
        url: z.string().max(4000),
        hash: z.string().max(100),
        upstreamIndex: z.string().max(500).nullable(),
        cited: z.boolean(),
        /**
         * The upstream's own version marker for this retained source, when it
         * states one (issue #252), mirroring `PersonSourceDocument.sourceVersion`.
         *
         * Three states, and they are not the same thing. A string is the
         * version the route stated. Null means the route states no version.
         * Absent means the report was written before this field existed and
         * the version went unmeasured — which is why this is optional rather
         * than defaulted: every benchmark report committed before issue #252
         * omits it on every retained source, and collapsing that into null
         * would claim those routes declared no version when nobody asked.
         * Reassessment (#270) and the acceptance comparison (#259) both read
         * those older artifacts.
         */
        sourceVersion: z.string().max(200).nullable().optional(),
      }),
    )
    .max(10000),
  claimIds: z.array(z.string().max(200)).max(10000),
  recoveredFactIds: z.array(z.string().max(80)).max(200),
  /** All citations of the matched claim are from this family; not proof of causal necessity. */
  exclusiveRecoveredFactIds: z.array(z.string().max(80)).max(200),
});
export type BenchmarkSourceContribution = z.infer<typeof BenchmarkSourceContributionSchema>;

const SourceContributionTotalsSchema = z.object({
  people: z.number().int().nonnegative(),
  retainedSources: z.number().int().nonnegative(),
  citedSources: z.number().int().nonnegative(),
  recoveredFacts: z.number().int().nonnegative(),
  exclusiveRecoveredFacts: z.number().int().nonnegative(),
});

/**
 * The four measured families, kept separate on purpose: there is no overall
 * score, so a large but unreliable dossier cannot average its way to a pass.
 */
export const BenchmarkJudgePhasesSchema = z.object({
  reference: z.object({
    status: z.enum(["completed", "failed"]),
    /** Validated semantic verdicts before final support/integrity credit gates. */
    judgements: z.array(BenchmarkJudgementSchema).max(200),
    failure: z.string().max(2000).nullable(),
  }),
  support: z.object({
    status: z.enum(["completed", "failed", "not-attempted"]),
    failure: z.string().max(2000).nullable(),
    /** Structured findings whose claim identity or verbatim statement could not be verified. */
    unresolvedFindings: z.array(BenchmarkOverclaimSchema).max(40).optional(),
  }),
});
export type BenchmarkJudgePhases = z.infer<typeof BenchmarkJudgePhasesSchema>;

export const BenchmarkPersonResultSchema = z.object({
  slug: z.string().max(80),
  referenceVersion: z.string().max(40),
  mode: BenchmarkModeSchema,
  /** Research or assessment failure; retained even when assessment itself completed. */
  failure: z.string().max(2000).nullable(),
  /** Explicit evidence that observed research output received both assessments. */
  assessment: z
    .object({
      operationId: z.string().min(1).max(200).nullable(),
      integrity: z.enum(["completed", "failed"]),
      judge: z.enum(["completed", "failed"]),
      phases: BenchmarkJudgePhasesSchema.optional(),
      modelAttempts: z.array(BenchmarkModelAttemptSchema).max(100).optional(),
    })
    .optional(),
  /** Absent in older reports means unmeasured, not zero contribution. */
  sourceContributions: z.array(BenchmarkSourceContributionSchema).max(20).optional(),
  factualReliability: z.object({
    /** Claims whose citations verify against their retained source version. */
    verifiedCitations: z.number().int().nonnegative(),
    totalCitations: z.number().int().nonnegative(),
    integrityFindings: z.array(BenchmarkIntegrityFindingSchema).max(200),
    criticalFindings: z.number().int().nonnegative(),
    /** Complete identity list even when the readable finding detail is sliced. */
    criticalFindingKeys: z.array(z.string().max(2000)).max(100000).optional(),
    overclaims: z.array(BenchmarkOverclaimSchema).max(100),
    wrongPersonAttributions: z.number().int().nonnegative(),
    contradictedFacts: z.number().int().nonnegative(),
  }),
  completeness: z.object({
    referenceFacts: z.number().int().nonnegative(),
    recovered: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    /** #271: how many of those ambiguous verdicts are withheld for an
     *  incomplete support/usefulness assessment — judge infrastructure, not
     *  semantic ambiguity. Reports written before #271 carry no measurement;
     *  a carried assessment always completed its support phase, so
     *  aggregates read absence as zero. */
    ambiguousSupportAssessmentFailed: z.number().int().nonnegative().optional(),
    /** Split by whether the app can plausibly acquire the support today. */
    byAcquisition: z.record(
      z.string().max(40),
      z.object({
        total: z.number().int().nonnegative(),
        recovered: z.number().int().nonnegative(),
      }),
    ),
    byRequirement: z.record(
      z.string().max(10),
      z.object({
        total: z.number().int().nonnegative(),
        recovered: z.number().int().nonnegative(),
      }),
    ),
    judgements: z.array(BenchmarkJudgementSchema).max(200),
  }),
  /** Absolute volume, reported next to completeness rather than folded in. */
  richness: z.object({
    claims: z.number().int().nonnegative(),
    works: z.number().int().nonnegative(),
    expertise: z.number().int().nonnegative(),
    connections: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    distinctFamilies: z.number().int().nonnegative(),
    /** Distinct upstream indexes behind those sources, where known. */
    distinctUpstreamIndexes: z.number().int().nonnegative(),
    sectionsWithGroundedSummary: z.number().int().nonnegative(),
  }),
  usefulness: z.object({
    /** 0–3 each, judged with cited evidence. Never summed with the rest. */
    understanding: z.number().int().min(0).max(3),
    remainingQuestions: z.number().int().min(0).max(3),
    conversationReadiness: z.number().int().min(0).max(3),
    rationale: z.string().max(4000),
    reviewRequired: z.boolean(),
  }),
  operational: z.object({
    conclusion: z.enum(["completed", "interrupted", "bounded"]),
    rounds: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    sourcesRetained: z.number().int().nonnegative(),
    leadsInvestigated: z.number().int().nonnegative(),
    leadsUnresolved: z.number().int().nonnegative(),
    failuresByCode: z.record(z.string().max(60), z.number().int().nonnegative()),
    coverageGaps: z.array(z.string().max(1000)).max(60),
    elapsedMilliseconds: z.number().nonnegative(),
  }),
});
export type BenchmarkPersonResult = z.infer<typeof BenchmarkPersonResultSchema>;

/** Independently inspectable assessment saved as soon as one person finishes. */
export const BenchmarkPersonArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().max(80),
  corpusVersion: z.string().max(80),
  pipeline: z.enum(["incumbent", "expanded"]),
  judgeProvider: z.string().max(80),
  judgeModel: z.string().max(200),
  judgeVersion: z.string().max(40),
  assessedAt: z.string().max(40),
  reassessmentOf: z.string().max(80).optional(),
  /** Conditions the person ran under, for reuse decisions. Absent means the
     artifact predates conditions stamping: it cannot prove it is the same
     run recipe, so a resume refuses to carry it silently. */
  conditions: z
    .object({
      mode: BenchmarkModeSchema,
      researchProvider: z.string().max(80),
      researchModel: z.string().max(200),
      promptVersion: z.string().max(40),
      reasoningEffort: z.string().max(20),
      /** Absent in artifacts stamped before the judge effort became a recipe
       *   field: an old artifact then classifies as a recipe mismatch, not a
       *   parse failure. */
      judgeReasoningEffort: z.string().max(20).optional(),
      seed: z.number().int().optional(),
    })
    .optional(),
  result: BenchmarkPersonResultSchema,
});
export type BenchmarkPersonArtifact = z.infer<typeof BenchmarkPersonArtifactSchema>;

/**
 * Everything needed to attribute a change to the research change under test.
 * Absent measurements stay absent — an invented token count would defeat the
 * purpose of recording usage at all.
 */
export const BenchmarkProvenanceSchema = z
  .object({
    corpusVersion: z.string().max(80),
    referenceVersions: z.record(z.string().max(80), z.string().max(40)),
    pipeline: z.enum(["incumbent", "expanded"]),
    researchProvider: z.string().max(80),
    researchModel: z.string().max(200),
    /** Present when the pipeline ran a planner; fixed-documents and the incumbent have none. */
    planningProvider: z.string().max(80).optional(),
    planningModel: z.string().max(200).optional(),
    judgeProvider: z.string().max(80),
    judgeModel: z.string().max(200),
    judgeVersion: z.string().max(40),
    usage: z
      .object({
        inputCharacters: z.number().int().nonnegative(),
        outputCharacters: z.number().int().nonnegative(),
        /* Token counts, when the provider boundary reported them. */
        tokens: z.union([
          z.literal("unavailable"),
          z.object({
            /* Providers report halves independently; either may be missing. */
            input: z.number().int().nonnegative().nullable(),
            output: z.number().int().nonnegative().nullable(),
          }),
        ]),
        /* The provider's own charge, when it names one (OpenRouter does). */
        cost: z.union([z.literal("unavailable"), z.number().nonnegative()]),
      })
      .optional(),
    promptVersion: z.string().max(40),
    collectorVersions: z.record(z.string().max(120), z.string().max(40)),
    researchSettings: z.record(z.string().max(80), z.union([z.string(), z.number(), z.boolean()])),
    network: z.enum(["live", "fixed-documents", "offline"]),
    startedAt: z.string().max(40),
    finishedAt: z.string().max(40),
    host: z.string().max(200),
  })
  .refine(
    (provenance) =>
      (provenance.planningProvider === undefined) === (provenance.planningModel === undefined),
    { message: "planningProvider and planningModel are recorded together" },
  );
export type BenchmarkProvenance = z.infer<typeof BenchmarkProvenanceSchema>;

/** Aggregation over a labelled slice of the collection, with denominators. */
export const BenchmarkGroupSummarySchema = z.object({
  dimension: z.enum([
    "industry",
    "role",
    "footprint",
    "language",
    "region",
    "source-family",
    "reference-source-family",
  ]),
  key: z.string().max(120),
  people: z.number().int().nonnegative(),
  referenceFacts: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  /** #271: the withheld-for-support part of the ambiguous count. Reports
   *  written before #271 carry no measurement; aggregates read absence as
   *  zero, since a reassessment only carries support-completed assessments. */
  ambiguousSupportAssessmentFailed: z.number().int().nonnegative().optional(),
  criticalFindings: z.number().int().nonnegative(),
  overclaims: z.number().int().nonnegative(),
});
export type BenchmarkGroupSummary = z.infer<typeof BenchmarkGroupSummarySchema>;

export const BenchmarkReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().max(80),
  /** A run that failed or was interrupted says so; it never reports stale output. */
  status: z.enum(["completed", "failed", "interrupted"]),
  statusDetail: z.string().max(2000),
  /** Evaluation execution is independent of whether research succeeded. */
  execution: z
    .object({
      status: z.enum(["completed", "interrupted"]),
      selected: z.array(z.string().min(1).max(80)).max(200),
      evaluated: z.number().int().nonnegative(),
      assessed: z.number().int().nonnegative(),
      scenarioIds: z.array(z.string().min(1).max(80)).max(100),
    })
    .optional(),
  mode: BenchmarkModeSchema,
  selection: z.object({
    requested: z.array(z.string().max(80)).max(200),
    evaluated: z.array(z.string().max(80)).max(200),
    skipped: z.array(z.object({ slug: z.string().max(80), reason: z.string().max(500) })).max(200),
  }),
  provenance: BenchmarkProvenanceSchema,
  evidenceBundleHash: z.string().length(64).optional(),
  /** A new assessment of immutable research evidence; research is not rerun. */
  reassessment: z
    .object({
      originalRunId: z.string().max(80),
      originalReportHash: z.string().length(64),
      originalProvenance: BenchmarkProvenanceSchema,
      evidenceManifestHash: z.string().length(64),
      lineage: z
        .object({
          root: z.string().min(1).max(4000),
          parent: z.string().min(1).max(1000),
          parentHash: z.string().length(64),
        })
        .optional(),
      resume: z
        .object({
          carriedPeople: z.array(z.string().max(80)).max(200),
          retriedPeople: z.array(z.string().max(80)).max(200),
          carriedScenarios: z.array(z.string().max(80)).max(100),
          retriedScenarios: z.array(z.string().max(80)).max(100),
        })
        .optional(),
      startedAt: z.string().max(40),
      finishedAt: z.string().max(40),
      inputCharacters: z.number().int().nonnegative(),
      outputCharacters: z.number().int().nonnegative(),
      tokens: z.literal("unavailable"),
      cost: z.literal("unavailable"),
    })
    .optional(),
  people: z.array(BenchmarkPersonResultSchema).max(200),
  collection: z.array(BenchmarkCollectionResultSchema).max(100).optional(),
  groups: z.array(BenchmarkGroupSummarySchema).max(400),
  /** Reference facts nobody recovered: the concrete follow-up target list. */
  remainingMisses: z
    .array(
      z.object({
        slug: z.string().max(80),
        factId: z.string().max(80),
        statement: z.string().max(2000),
        acquisition: BenchmarkAcquisitionSchema,
        requirements: z.array(BenchmarkDossierRequirementSchema).max(6),
        explanation: z.string().max(2000),
      }),
    )
    .max(2000),
  /** Run-time aggregation over the run's research operation records (#281):
   *  how every recorded lead resolved — with each disposition's share of the
   *  denominator — and how much planned coverage stays open. Reports written
   *  before the fields existed omit them, and a reassessment assembles no
   *  research operations of its own. */
  leadDispositions: z
    .object({
      totalLeads: z.number().int().nonnegative(),
      dispositions: z
        .array(
          z.object({
            disposition: PersonResearchLeadSchema.shape.disposition,
            count: z.number().int().nonnegative(),
            /** count / totalLeads, as a fraction. */
            share: z.number().min(0).max(1),
          }),
        )
        .max(6),
    })
    .optional(),
  /** People carried from a prior run by --retry/--reuse-extraction, beside
     the people this run actually researched. */
  resume: z
    .object({
      carriedPeople: z.array(z.string().max(80)).max(200),
      retriedPeople: z.array(z.string().max(80)).max(200),
    })
    .optional(),
  coverageGaps: z
    .object({
      areas: z.number().int().nonnegative(),
      areasWithOpenGaps: z.number().int().nonnegative(),
      areaGaps: z.number().int().nonnegative(),
      explicitGaps: z.number().int().nonnegative(),
    })
    .optional(),
});
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;

/** Two reports compared under a fixed reference and judge configuration. */
export const BenchmarkComparisonSchema = z.object({
  schemaVersion: z.literal(1),
  baselineRunId: z.string().max(80),
  candidateRunId: z.string().max(80),
  /** Conditions that differed; disclosed research allowances can remain comparable. */
  conditionChanges: z.array(z.string().max(1000)).max(40),
  comparable: z.boolean(),
  /** Per-side absence remains explicit when an older report did not measure this. */
  sourceContributions: z
    .array(
      z.object({
        family: z.enum([
          "unclassified",
          ...(Object.keys(PERSON_SOURCE_FAMILIES) as PersonSourceFamily[]),
        ]),
        baseline: SourceContributionTotalsSchema.nullable(),
        candidate: SourceContributionTotalsSchema.nullable(),
      }),
    )
    .max(20)
    .optional(),
  operational: z.object({
    baselineStatus: z.enum(["completed", "failed", "interrupted"]),
    candidateStatus: z.enum(["completed", "failed", "interrupted"]),
    baseline: z.object({
      completed: z.number().int().nonnegative(),
      bounded: z.number().int().nonnegative(),
      interrupted: z.number().int().nonnegative(),
    }),
    candidate: z.object({
      completed: z.number().int().nonnegative(),
      bounded: z.number().int().nonnegative(),
      interrupted: z.number().int().nonnegative(),
    }),
    regressedPeople: z.array(z.string().max(80)).max(200),
  }),
  totals: z.object({
    referenceFacts: z.number().int().nonnegative(),
    baselineRecovered: z.number().int().nonnegative(),
    candidateRecovered: z.number().int().nonnegative(),
    baselineCriticalFindings: z.number().int().nonnegative(),
    candidateCriticalFindings: z.number().int().nonnegative(),
    baselineOverclaims: z.number().int().nonnegative(),
    candidateOverclaims: z.number().int().nonnegative(),
  }),
  perPerson: z
    .array(
      z.object({
        slug: z.string().max(80),
        referenceFacts: z.number().int().nonnegative(),
        baselineRecovered: z.number().int().nonnegative(),
        candidateRecovered: z.number().int().nonnegative(),
        baselineConclusion: z.enum(["completed", "bounded", "interrupted"]),
        candidateConclusion: z.enum(["completed", "bounded", "interrupted"]),
        /* Recovery credit is withheld while the assessment phases are
           incomplete, so the rendered comparison needs to know which sides
           were actually measured rather than reading zeros as evidence. */
        baselineAssessed: z.boolean(),
        candidateAssessed: z.boolean(),
        newCriticalFindings: z.number().int().nonnegative(),
        newWrongPersonAttributions: z.number().int().nonnegative().optional(),
        newOverclaims: z.number().int().nonnegative(),
      }),
    )
    .max(200),
  /** The acceptance question: more recovery, no new critical failures. */
  verdict: z.enum(["improved", "regressed", "unchanged", "not-comparable"]),
  verdictDetail: z.string().max(2000),
});
export type BenchmarkComparison = z.infer<typeof BenchmarkComparisonSchema>;

/** One arm's interval over per-person mean recovery, from K repeat reports. */
export const BenchmarkArmStatsSchema = z.object({
  schemaVersion: z.literal(1),
  /** One run id per repeat report the arm was built from. */
  runIds: z.array(z.string().max(80)).min(1).max(20),
  mode: BenchmarkModeSchema,
  pipeline: z.enum(["incumbent", "expanded"]),
  repeats: z.number().int().positive().max(20),
  people: z
    .array(
      z.object({
        slug: z.string().max(80),
        /** recovered/referenceFacts, once per repeat. */
        scores: z.array(z.number().min(0).max(1)).min(1).max(20),
        mean: z.number().min(0).max(1),
      }),
    )
    .min(2)
    .max(200),
  /** Across-person interval over the per-person means. */
  ci: z.object({
    mean: z.number(),
    se: z.number().nonnegative(),
    lo: z.number(),
    hi: z.number(),
  }),
  totals: z.object({
    referenceFacts: z.number().int().nonnegative(),
    recoveredMean: z.number().nonnegative(),
    rate: z.number().min(0).max(1),
  }),
  /** Included repeat reports whose top-level status recorded person-level
   *  failures: measured samples, but not clean ones. */
  partialRepeats: z.number().int().nonnegative().max(20).default(0),
});
export type BenchmarkArmStats = z.infer<typeof BenchmarkArmStatsSchema>;
/** Two arms compared on paired per-person differences, with the noise verdict. */
export const BenchmarkStatsComparisonSchema = z.object({
  schemaVersion: z.literal(1),
  baseline: z.object({
    runIds: z.array(z.string().max(80)).min(1).max(20),
    ci: z.object({ mean: z.number(), lo: z.number(), hi: z.number() }),
  }),
  candidate: z.object({
    runIds: z.array(z.string().max(80)).min(1).max(20),
    ci: z.object({ mean: z.number(), lo: z.number(), hi: z.number() }),
  }),
  sharedPeople: z.number().int().nonnegative(),
  paired: z.object({
    mean: z.number(),
    sd: z.number().nonnegative(),
    se: z.number().nonnegative(),
    /** Null when the differences have no spread or the mean is exactly zero —
     *  JSON cannot carry an infinite z, and a deterministic separation is a
     *  verdict, not a test statistic. */
    z: z.number().nullable(),
    corr: z.number().nullable(),
  }),
  /** The smallest true difference this comparison could have distinguished. */
  mde: z.number().nullable(),
  verdict: z.enum(["distinguishable", "noise"]),
  verdictDetail: z.string().max(2000),
});
export type BenchmarkStatsComparison = z.infer<typeof BenchmarkStatsComparisonSchema>;
