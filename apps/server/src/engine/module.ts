import type {
  RunEvent,
  RunFailureFlags,
  RunMeta,
  RunWaitTimeout,
} from "@chief-of-staff-demo/shared";
import type { RunOutcome } from "../runs.js";

/**
 * The Module contract (ADR-0003), as built.
 *
 * A Module exports `run(ctx, input)` and owns its own control flow. The Shell
 * hands it one context object and records what happened; it never holds a list
 * of a Module's Stages, its Intakes or its event names, and it never reads
 * inside a Module's result.
 */
export interface ShellModule<Input> {
  /** Stable identity, stored on every Run this Module makes. */
  readonly id: string;
  /** The Module's own version when a Run is created, so a Module can recognise
   *  a Run its older self wrote. */
  readonly version: number;
  /** The Module's work. Returns how the Run ended; a throw is a failure the
   *  Stage wrapper has already recorded. */
  run(ctx: RunContext, input: Input): Promise<RunOutcome>;
  /**
   * The hint a person reads when a Stage failed without wording its own. The
   * Shell records the failure; the Module words it, because only the Module
   * knows what its Stages were for.
   */
  failureHint(stage: string, reason: string): string;
  /**
   * What re-running this failed Run means, or null to refuse it. Declarative
   * rather than performed, because a plan is decided outside any Stage and a
   * Module may not write durably there — the Runner carries it out.
   */
  planRetry(meta: Readonly<RunMeta>): RetryPlan<Input> | null;
  /** What continuing one of this Module's blocked Runs means. */
  planResume?(meta: Readonly<RunMeta>): ResumePlan<Input> | null;
  /** What reconstructing process-orphaned pending/running work means. */
  planRecovery?(state: RecoveryState): ResumePlan<Input> | null;
}

/** The durable facts a Module may use to choose a safe recovery Stage. */
export type RecoveryState = Readonly<RunMeta> & {
  readonly events: readonly RunEvent[];
  readonly files: readonly string[];
};

/** How a Module continues after the Shell clears its durable wait. */
interface ResumePlan<Input> {
  fromStage: string;
  /** Shape-only reason this Stage is the safe restart point. */
  reason: string;
  input: Input;
}

/** How a Module re-runs one of its failed Runs. */
export interface RetryPlan<Input> {
  /** The Stage the Run resumes from; recorded on the reopen. */
  fromStage: string;
  /** Shape-only reason this Stage is the safe restart point. */
  reason: string;
  /** What to hand `run` this time. */
  input: Input;
  /** Start counting attempts again, for a Stage re-run from scratch. */
  resetAttempts?: boolean;
  /** The Run's own files this retry invalidates. */
  discard?: string[];
}

/**
 * Everything a Module may do that outlives the process. Every method below is
 * refused outside a Stage, so a Run's status and its timeline cannot disagree:
 * whatever the Shell recorded, it recorded inside a named span.
 *
 * A Module's own collaborators — a model, a Google surface, its configuration —
 * are not here. They belong to the Module and are closed over by it; what the
 * Shell gates is the Shell's own durable machinery.
 */
export interface RunContext {
  readonly runId: string;
  /** The Run record as stored. A snapshot: the Shell is the only writer. */
  meta(): Readonly<RunMeta>;
  /**
   * The whole of the uniformity (ADR-0003). The Shell writes the Stage events,
   * records the Stage on the Run for retry, and catches failures; the Module
   * chooses the names and the order.
   */
  stage<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** A Module-named event on the Run's timeline. */
  event(type: string, detail?: Record<string, unknown>): void;
  /** Count one attempt at the open Stage; returns the new count. */
  attempt(): number;
  /**
   * Stop the Run inside the open Stage with a Shell-owned durable wait. This
   * call does not return; later work begins from a Module-supplied resume plan.
   */
  wait(request: { reason: string; timeout: RunWaitTimeout }): never;
  /** The Run's own files. The Shell stores and serves them and never reads inside one. */
  readFile(name: string): string | null;
  writeFile(name: string, text: string): void;
}

/**
 * A failure a Module wants worded its own way: the reason for the timeline, and
 * the hint the person reads. Anything else a Stage throws gets the Module's
 * default hint for that Stage.
 */
export class StageFailure extends Error {
  constructor(
    reason: string,
    readonly hint: string,
    readonly flags?: RunFailureFlags,
  ) {
    super(reason);
    this.name = "StageFailure";
  }
}

export class OutsideStageError extends Error {
  constructor(what: string) {
    super(`${what} outside a Stage`);
    this.name = "OutsideStageError";
  }
}
