import { z } from "zod/v3";
import { ModelBoundaryDiagnosticSchema } from "./llm.js";

/**
 * The Person Research Failure contract (issue #228).
 *
 * Production research and the benchmark evaluator record the same records, so
 * a developer debugging a benchmark miss reads the pipeline's own account of
 * what happened rather than an evaluation-side imitation of it.
 *
 * Three separations are load-bearing and are enforced by the shape rather
 * than by convention:
 *
 * - **Stage** (where the work stopped) is not **code** (what was observed).
 *   A 403 during retrieval is `stage: "access"`, `code: "http-error"`; it is
 *   not evidence that the page needs a login.
 * - **Observed** facts are not **hypotheses**. `cause` says which one this
 *   record is, and an unclassified failure stays `"unknown"` rather than
 *   receiving an invented explanation.
 * - An **attempt** is one try; `attemptOf` links a retry or a fallback to the
 *   attempt it is recovering, so a summary that shows the last line can never
 *   erase how the pipeline got there.
 */
export const PersonResearchStageSchema = z.enum([
  "discovery",
  "selection",
  "transport",
  "access",
  "rendering",
  "document-parsing",
  "caption-acquisition",
  "transcription",
  "identity",
  "extraction",
  "validation",
  "publication",
  "planning",
]);
export type PersonResearchStage = z.infer<typeof PersonResearchStageSchema>;

/**
 * Stable reason codes. They are the vocabulary a follow-up issue can name, so
 * they are added to rather than renamed. `unknown-cause` is deliberately
 * present: a failure the pipeline could not classify says so.
 */
export const PersonResearchFailureCodeSchema = z.enum([
  // Discovery and selection
  "discovery-refused",
  "discovery-empty",
  "selection-deferred",
  "duplicate-suppressed",
  "lead-rejected",
  // Transport and access
  "connectivity-failed",
  "dns-failed",
  "tls-failed",
  "request-timeout",
  "transport-failed",
  "http-error",
  "rate-limited",
  "quota-exhausted",
  "login-required",
  "challenge-page",
  "resource-unavailable",
  /**
   * An archive answered with its own error or technical-difficulty page rather
   * than the capture, whatever status it used to do it (issue #253). Separate
   * from `resource-unavailable`, which is the archive saying it holds no
   * capture: one is a service fault to retry, the other a fact about coverage.
   */
  "archive-error-page",
  /**
   * A public record index answered HTTP 2xx with its own error or refusal
   * envelope rather than a record (issue #250). Like `archive-error-page`,
   * this is the index declining to serve the read — not a fact about
   * coverage, which stays `resource-unavailable`. The envelope is never
   * retained as text: it can echo the requested name, and no rights basis,
   * version or attribution would cover it.
   */
  "registry-error-envelope",
  "robots-excluded",
  // Rendering, parsing and media
  "rendering-failed",
  "unsupported-format",
  "parser-failed",
  "document-empty",
  "captions-missing",
  "transcription-failed",
  "runtime-unavailable",
  "subprocess-failed",
  // Downstream
  "ambiguous-attribution",
  "identity-unmatched",
  "invalid-result-shape",
  "model-boundary-failed",
  "model-response-received",
  "unsupported-citation",
  "stale-result-rejected",
  "lifecycle-invalidated",
  "publication-conflict",
  // Recovery bookkeeping
  "retrieval-recovered",
  "model-call-metrics",
  "unknown-cause",
]);
export type PersonResearchFailureCode = z.infer<typeof PersonResearchFailureCodeSchema>;

/** What the record's stated cause rests on. Never upgraded by a summary. */
export const PersonResearchCauseSchema = z.enum(["observed", "hypothesis", "unknown"]);

/**
 * Observations kept only where they were actually measured. Every field is
 * optional because inventing one (a token count the model boundary never
 * supplied, a status a thrown transport never produced) is the failure mode
 * this contract exists to prevent.
 */
export const PersonResearchObservationSchema = z.object({
  /** Upstream HTTP status, when a response was received at all. */
  status: z.number().int().optional(),
  /** The sanitized final URL after redirects. Never carries credentials. */
  finalUrl: z.string().max(4000).optional(),
  contentType: z.string().max(400).nullable().optional(),
  bytes: z.number().nonnegative().optional(),
  /** SHA-256 of the response or document body actually seen. */
  bodyHash: z.string().max(64).optional(),
  elapsedMilliseconds: z.number().nonnegative().optional(),
  /** Which deadline expired: the request, the render, or the subprocess. */
  timeoutStage: z.enum(["request", "render", "subprocess", "model"]).optional(),
  /** Where a parser gave up — a page number, an XPath-ish hint, a field path. */
  parserLocation: z.string().max(400).optional(),
  subprocessExitStatus: z.number().int().optional(),
  /** Readable model failure summary; never a response payload. */
  modelDiagnostic: z.string().max(2000).optional(),
  /** Classified, bounded shape observations supplied by the production model seam. */
  modelBoundary: ModelBoundaryDiagnosticSchema.optional(),
  retryAfterMilliseconds: z.number().nonnegative().optional(),
  /** A bounded, sanitized excerpt of what was actually received. */
  excerpt: z.string().max(2000).optional(),
  /** Wall time of one logical model call, measured by its caller. */
  modelCallDurationMilliseconds: z.number().nonnegative().optional(),
  /** Request text characters of one logical model call, measured by its caller. */
  modelInputCharacters: z.number().nonnegative().optional(),
  /** Answer characters of one logical model call, measured by its caller. */
  modelOutputCharacters: z.number().nonnegative().optional(),
  /** Tokens the wire reported for the succeeded attempt, when it named any. */
  modelUsageTokens: z
    .object({
      input: z.number().nonnegative().nullable(),
      output: z.number().nonnegative().nullable(),
    })
    .optional(),
});
export type PersonResearchObservation = z.infer<typeof PersonResearchObservationSchema>;

/**
 * One attempt at one piece of research work.
 *
 * `attemptOf` is the correlation key: the first attempt at a target sets it to
 * its own id, and every retry, alternative route and fallback repeats it. That
 * is what makes "which recovery worked" answerable from the stored history
 * instead of from log archaeology.
 */
export const PersonResearchAttemptSchema = z.object({
  id: z.string().max(64),
  /** The operation this attempt belongs to; stable for its whole lifetime. */
  operationId: z.string().max(64),
  /** Correlation id shared by an original attempt and all of its recoveries. */
  attemptOf: z.string().max(64),
  attempt: z.number().int().positive(),
  stage: PersonResearchStageSchema,
  code: PersonResearchFailureCodeSchema,
  outcome: z.enum(["failed", "recovered", "succeeded", "skipped"]),
  /** What further recovery, if any, this attempt led to. */
  recovery: z.enum(["retry", "alternative-route", "stopped", "recovered", "none"]),
  /** Why recovery stopped, when it did. Absent while recovery continues. */
  recoveryStopped: z.string().max(1000).optional(),
  cause: PersonResearchCauseSchema,
  /** The URL, query or record identity this attempt addressed. Sanitized. */
  target: z.string().max(4000),
  targetKind: z.enum(["query", "url", "record", "media", "document", "model", "profile"]),
  /** Which collector ran, and the version of it that produced this record. */
  collector: z.string().max(200),
  collectorVersion: z.string().max(80),
  /** Nonsecret configuration that changes the collector's behavior. */
  configuration: z.record(z.string().max(80), z.string().max(400)).optional(),
  observed: PersonResearchObservationSchema.optional(),
  /** One sentence naming what happened. Never asserts an unobserved cause. */
  reason: z.string().max(1000),
  /** What the failure cost: which source material or coverage went missing. */
  impact: z.string().max(1000).optional(),
  /** What a developer should do next. Concrete, not "investigate further". */
  remediation: z.string().max(1000).optional(),
  /** A suspected explanation, explicitly labeled as not established. */
  hypothesis: z.string().max(1000).optional(),
  occurredAt: z.string().max(40),
  /** The Person Profile revision live when this attempt ran. */
  profileRevision: z.number().int().nonnegative().optional(),
});
export type PersonResearchAttempt = z.infer<typeof PersonResearchAttemptSchema>;

/**
 * A lead: something the operation learned it could investigate.
 *
 * Completion is defined against this list, so a lead that was dropped has to
 * say why. "Finished the query list" is not a disposition; `deduplicated`,
 * `inaccessible` and `rejected` are, and each carries its reason.
 */
export const PersonResearchLeadSchema = z.object({
  id: z.string().max(64),
  kind: z.enum(["query", "url", "record", "media", "document"]),
  target: z.string().max(4000),
  resolvedUrl: z.string().max(4000).optional(),
  discoveryUrls: z.array(z.string().max(4000)).max(100).optional(),
  upstreamIndex: z.string().max(200).optional(),
  /** Where the lead came from: seed, a read document, or the planner. */
  origin: z.enum(["seed", "discovery", "document-link", "planner", "expansion"]),
  /** The source family this lead would exercise, when known. */
  family: z.string().max(120).optional(),
  /** Which coverage areas this lead was expected to serve. */
  coverage: z.array(z.string().max(80)).max(20).default([]),
  disposition: z.enum([
    "pending",
    "investigated",
    "rejected",
    "deduplicated",
    "inaccessible",
    "interrupted",
  ]),
  /** Why the lead has the disposition it has. Always populated once resolved. */
  reason: z.string().max(1000),
  /** Whether the investigation produced evidence retained in the dossier. */
  yieldedEvidence: z.boolean().default(false),
  /** Ranked selection score and the inputs that produced it. */
  selection: z
    .object({
      score: z.number().finite(),
      relevance: z.number().finite(),
      independence: z.number().finite(),
      coverageGap: z.number().finite(),
      efficiency: z.number().finite().optional(),
    })
    .optional(),
});
export type PersonResearchLead = z.infer<typeof PersonResearchLeadSchema>;

/**
 * One coverage area the operation planned to investigate. Areas are the
 * dossier's own sections plus the source families the spec names, so a
 * completion report says what was looked for, not only what was found.
 */
export const PersonResearchCoverageAreaSchema = z.object({
  key: z.string().max(80),
  label: z.string().max(200),
  kind: z.enum(["dossier-section", "source-family"]),
  state: z.enum(["planned", "investigated", "satisfied", "inaccessible", "interrupted"]),
  /** How many retained sources contributed evidence to this area. */
  sources: z.number().int().nonnegative(),
  /** How many published claims rest on it. */
  claims: z.number().int().nonnegative(),
  /** What remains unknown here. Explicit gaps, never an implied completeness. */
  gaps: z.array(z.string().max(1000)).max(20).default([]),
});
export type PersonResearchCoverageArea = z.infer<typeof PersonResearchCoverageAreaSchema>;

/** Why one continuous research operation stopped. */
export const PersonResearchConclusionSchema = z.enum([
  /** Coverage investigated, leads accounted for, expansion found nothing new. */
  "completed",
  /** A model outage, shutdown, cancellation or lifecycle change stopped it. */
  "interrupted",
  /** A hard bound (request ceiling, wall clock) stopped it with work pending. */
  "bounded",
]);

/**
 * The outcome of one continuous research operation: what it covered, what it
 * could not reach, and every attempt behind both.
 */
export const PersonResearchOperationOutcomeSchema = z.object({
  operationId: z.string().max(64),
  profileId: z.string().max(160),
  conclusion: PersonResearchConclusionSchema,
  /** The interruption's own cause, when the conclusion is `interrupted`. */
  interruption: z
    .object({
      code: PersonResearchFailureCodeSchema,
      reason: z.string().max(1000),
    })
    .optional(),
  startedAt: z.string().max(40),
  finishedAt: z.string().max(40),
  /** Discovery passes, reading batches, and expansion rounds actually run. */
  rounds: z.number().int().nonnegative(),
  /** Logical model invocations; opted-in wire attempts are recorded in attempts. */
  modelCalls: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  /** Distinct source versions retained or reused by this operation, including unattempted versions. */
  sourcesRetained: z.number().int().nonnegative(),
  /** Absent on legacy outcomes whose exact retained-version identities were not recorded. */
  retainedSourceIds: z.array(z.string().length(64)).max(10000).optional(),
  claimsPublished: z.number().int().nonnegative(),
  /** The last dossier revision this operation published. */
  publishedDossierRevision: z.number().int().nonnegative().optional(),
  coverage: z.array(PersonResearchCoverageAreaSchema).max(80),
  leads: z.array(PersonResearchLeadSchema),
  attempts: z.array(PersonResearchAttemptSchema),
  /** Explicit remaining gaps. A completed operation still has these. */
  gaps: z.array(z.string().max(1000)).max(60),
  /** One sentence for the Profile reader. Never claims exhaustive search. */
  detail: z.string().max(2000),
});
export type PersonResearchOperationOutcome = z.infer<typeof PersonResearchOperationOutcomeSchema>;

/**
 * The compact view a Profile reader gets. It is derived, and it names how many
 * attempts it summarized, so a display limit is visibly a display limit rather
 * than the end of the record.
 */
export interface PersonResearchDiagnosticSummary {
  shown: PersonResearchAttempt[];
  totalAttempts: number;
  /** Attempt counts by code, across the whole history rather than the slice. */
  byCode: Record<string, number>;
}

export function summarizeResearchAttempts(
  attempts: PersonResearchAttempt[],
  limit = 20,
): PersonResearchDiagnosticSummary {
  const byCode: Record<string, number> = {};
  for (const attempt of attempts) byCode[attempt.code] = (byCode[attempt.code] ?? 0) + 1;
  /* Failures first, then the most recent: a summary that dropped the failure
     and kept the recovery would report a clean run that did not happen. */
  const ranked = [...attempts].sort((a, b) => {
    const weight = (entry: PersonResearchAttempt) => (entry.outcome === "failed" ? 0 : 1);
    return weight(a) - weight(b) || b.occurredAt.localeCompare(a.occurredAt);
  });
  return { shown: ranked.slice(0, limit), totalAttempts: attempts.length, byCode };
}

/** The source families the expanded pipeline can exercise (issue #228). */
export const PERSON_SOURCE_FAMILIES = {
  "general-discovery": "General web discovery",
  "spoken-evidence": "Video, podcast and broadcast material",
  "public-social": "Public social posts and pages",
  "documents-publishers": "Documents, publisher sites and structured records",
  "published-work": "Published and deposited work",
  "professional-records": "Professional and institutional records",
  "creative-records": "Creative and cultural catalogue records",
  "identity-affiliation": "Identity and affiliation records",
  "historical-evidence": "Archived and historical evidence",
  workspace: "Workspace Transcripts confirmed for this person",
} as const;
export type PersonSourceFamily = keyof typeof PERSON_SOURCE_FAMILIES;
