import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BenchmarkPersonArtifactSchema,
  type BenchmarkMode,
  type BenchmarkPersonArtifact,
} from "@chief-of-staff-demo/shared";

/**
 * The resume half of outage-proof arms: read a benchmark output directory and
 * classify every person artifact as carriable into a new run, refusable, or
 * unstamped. A completed, fully assessed person carried under a provably
 * identical run recipe is money already spent; everything else re-runs.
 * The reuse contract is strict by design — a confirmed recipe mismatch
 * refuses the whole directory, because arms under different conditions are
 * exactly the confound the conditions stamp exists to prevent.
 */

/** The run recipe a reuse candidate must prove it was produced under. */
export interface ResumeConditions {
  mode: BenchmarkMode;
  researchProvider: string;
  researchModel: string;
  promptVersion: string;
  reasoningEffort: string;
  judgeReasoningEffort: string;
  seed?: number | undefined;
  /** Arm-defining conditions stamped beside the artifact's own fields. */
  corpusVersion: string;
  pipeline: "incumbent" | "expanded";
  judgeProvider: string;
  judgeModel: string;
  judgeVersion: string;
  /** Per-person reference versions, by slug. */
  referenceVersions: Record<string, string>;
}

interface MismatchedConditions {
  slug: string;
  field: string;
  prior: unknown;
  current: unknown;
}

export interface ReusableDirectory {
  /** slug → artifact, ready to carry into the new run's report. */
  eligible: Map<string, BenchmarkPersonArtifact>;
  /** Artifacts that would qualify but predate conditions stamping. */
  unstamped: string[];
  /** Artifacts stamped under a different recipe: the caller refuses. */
  mismatched: MismatchedConditions[];
}

const CONDITION_FIELDS = [
  "mode",
  "researchProvider",
  "researchModel",
  "promptVersion",
  "reasoningEffort",
  "judgeReasoningEffort",
  "seed",
] as const;

/** Research finished and both assessments completed: nothing left to buy. */
function fullyAssessed(artifact: BenchmarkPersonArtifact): boolean {
  return (
    artifact.result.failure === null &&
    artifact.result.operational.conclusion === "completed" &&
    artifact.result.assessment?.integrity === "completed" &&
    artifact.result.assessment.judge === "completed"
  );
}

function classify(
  artifact: BenchmarkPersonArtifact,
  current: ResumeConditions,
  reuse: ReusableDirectory,
): void {
  /* A reassessment re-judges immutable evidence from an earlier run; the
     original run's own artifact is the reuse source. */
  if (artifact.reassessmentOf !== undefined) return;
  if (!fullyAssessed(artifact)) return;
  /* The artifact's own top-level fields are conditions too: corpus, pipeline
     and judge identity are stamped on every artifact, stamped era or not. */
  const structural: Record<string, unknown> = {
    corpusVersion: artifact.corpusVersion,
    pipeline: artifact.pipeline,
    judgeProvider: artifact.judgeProvider,
    judgeModel: artifact.judgeModel,
    judgeVersion: artifact.judgeVersion,
  };
  const mismatch = (field: string, prior: unknown, current_: unknown): void => {
    reuse.mismatched.push({ slug: artifact.result.slug, field, prior, current: current_ });
  };
  for (const [field, prior] of Object.entries(structural)) {
    if (prior !== current[field as keyof ResumeConditions]) {
      mismatch(field, prior, current[field as keyof ResumeConditions]);
      return;
    }
  }
  const reference = current.referenceVersions[artifact.result.slug];
  if (reference !== undefined && artifact.result.referenceVersion !== reference) {
    mismatch("referenceVersion", artifact.result.referenceVersion, reference);
    return;
  }
  if (artifact.conditions === undefined) {
    reuse.unstamped.push(artifact.result.slug);
    return;
  }
  for (const field of CONDITION_FIELDS) {
    if (artifact.conditions[field] !== current[field]) {
      mismatch(field, artifact.conditions[field], current[field]);
      return;
    }
  }
  reuse.eligible.set(artifact.result.slug, artifact);
}

/** Read every person artifact in the directory and sort it into the three
 *  buckets. Several runs in one directory are fine; the latest assessment of
 *  a slug wins, by the recorded assessment time. */
export function loadReusable(directory: string, current: ResumeConditions): ReusableDirectory {
  const reuse: ReusableDirectory = { eligible: new Map(), unstamped: [], mismatched: [] };
  const found = readdirSync(directory)
    .filter((name) => name.endsWith(".person.json"))
    .map((name) => {
      try {
        return BenchmarkPersonArtifactSchema.parse(
          JSON.parse(readFileSync(join(directory, name), "utf8")),
        );
      } catch {
        /* Not a readable person artifact — nothing to reuse from it. */
        return null;
      }
    })
    .filter((artifact): artifact is BenchmarkPersonArtifact => artifact !== null)
    .sort((a, b) => a.assessedAt.localeCompare(b.assessedAt));
  /* A reassessment re-judges immutable evidence from an earlier run and is
     never a reuse source — the original run's own artifact is. Exclude them
     before the latest-per-slug selection, so a newer reassessment cannot
     shadow an eligible original. */
  const reusable = found.filter((artifact) => artifact.reassessmentOf === undefined);
  /* Latest reusable assessment of a slug wins: an older artifact must not
     refuse the resume for conditions its successor already satisfies. */
  const latestBySlug = new Map<string, BenchmarkPersonArtifact>();
  for (const artifact of reusable) latestBySlug.set(artifact.result.slug, artifact);
  for (const artifact of latestBySlug.values()) classify(artifact, current, reuse);
  return reuse;
}
