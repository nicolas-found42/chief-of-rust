import type { RunMeta } from "@chief-of-staff-demo/shared";
import type { NewRun, RunHandle, Runs } from "../runs.js";
import { modelDiagnosticEventDetail } from "../llm/failure.js";
import { errorMessage } from "./failure.js";
import {
  OutsideStageError,
  StageFailure,
  type RecoveryState,
  type RunContext,
  type ShellModule,
} from "./module.js";

/** What a Module's host knows about a new Run that the Shell does not. */
export type RunRecord = Omit<NewRun, "module" | "moduleVersion">;

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export class RunNotRetryableError extends Error {
  constructor(
    runId: string,
    readonly condition: "status_not_failed" | "failed_stage_missing" | "module_declined",
    detail: string,
  ) {
    super(`Run is not retryable because ${detail}: ${runId}`);
    this.name = "RunNotRetryableError";
  }
}

export class RunNotResumableError extends Error {
  constructor(runId: string) {
    super(`Run is not resumable: ${runId}`);
    this.name = "RunNotResumableError";
  }
}

export interface RunnerDeps<Input> {
  /** Constructed once by the Shell: the run directory has one owner. */
  runs: Runs;
  module: ShellModule<Input>;
  /** Absent and `undefined` both mean: do not log. */
  log?: ((message: string) => void) | undefined;
  /** Clock used for durable wait records and recovery decisions. */
  now?: (() => Date) | undefined;
}

const TERMINAL = new Set(["done", "skipped", "failed"]);

/** Internal control flow: a durable wait is neither a failure nor an outcome. */
class RunBlocked extends Error {
  constructor() {
    super("Run blocked");
    this.name = "RunBlocked";
  }
}

/**
 * The generic Run engine: it creates Runs, hands a Module its context, records
 * every Stage, and carries out a retry the Module planned. It holds no
 * knowledge of any Module's Stages, Intakes, event names or result — one
 * Runner per Module, and adding a Module needs no change here (ADR-0003).
 *
 * Work is serialised through one promise chain, so two Runs never interleave a
 * model call or a batch of Google writes.
 */
export class Runner<Input> {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RunnerDeps<Input>) {}

  /** Resolves when every enqueued Run has settled (test seam). */
  async idle(): Promise<void> {
    await this.queue;
  }

  /** Create the Run and enqueue the Module's work. The id is available at once. */
  async startRun(record: RunRecord, input: Input): Promise<string> {
    const run = this.deps.runs.create({
      module: this.deps.module.id,
      moduleVersion: this.deps.module.version,
      ...record,
    });
    this.enqueue(run, input);
    return run.id;
  }

  /**
   * Re-run a failed Run in place, the way its Module says to. The plan is the
   * Module's; carrying it out — the reset, the discards, the reopen — is the
   * Shell's, because none of it happens inside a Stage.
   */
  async retryRun(id: string): Promise<RunMeta> {
    const run = this.deps.runs.open(id);
    if (!run) {
      throw new RunNotFoundError(id);
    }
    const meta = run.read();
    if (meta.status !== "failed") {
      run.appendEvent("retry_refused", {
        condition: "status_not_failed",
        status: meta.status,
        module: meta.module,
      });
      throw new RunNotRetryableError(id, "status_not_failed", `its status is ${meta.status}`);
    }
    if (!meta.failedStage) {
      run.appendEvent("retry_refused", {
        condition: "failed_stage_missing",
        status: meta.status,
        module: meta.module,
      });
      throw new RunNotRetryableError(id, "failed_stage_missing", "no failed Stage was recorded");
    }
    const plan = this.deps.module.planRetry(meta);
    if (!plan) {
      run.appendEvent("retry_refused", {
        condition: "module_declined",
        status: meta.status,
        failedStage: meta.failedStage,
        module: meta.module,
      });
      throw new RunNotRetryableError(id, "module_declined", "its Module declined the retry");
    }
    if (plan.resetAttempts) {
      run.resetAttempts();
    }
    for (const name of plan.discard ?? []) {
      run.deleteArtifact(name);
    }
    const reopened = run.reopen(plan.fromStage, plan.reason);
    this.enqueue(run, plan.input);
    return reopened;
  }

  /**
   * Re-enter a finished Run at a named Stage, for owner-initiated work that
   * belongs to a Run that has already ended (issue: review gates removed).
   *
   * A Debrief now finishes as soon as it has extracted, rather than sitting
   * blocked against an owner it may never hear from. The two things the owner
   * can still ask of it afterwards — regenerate a field, publish the gated
   * outward writes — are real Stage work on that same Run, so they reopen it
   * rather than starting a second one. Terminal Runs only: a live Run is
   * already going somewhere, and retry/resume own those paths.
   */
  async reenterRun(id: string, fromStage: string, reason: string, input: Input): Promise<RunMeta> {
    const run = this.deps.runs.open(id);
    if (!run) {
      throw new RunNotFoundError(id);
    }
    const meta = run.read();
    if (meta.status !== "done" && meta.status !== "skipped") {
      throw new RunNotResumableError(id);
    }
    const reopened = run.reopen(fromStage, reason);
    this.enqueue(run, input);
    return reopened;
  }

  /** Continue a blocked Run in place using the owning Module's durable plan. */
  async resumeRun(id: string): Promise<RunMeta> {
    const run = this.deps.runs.open(id);
    if (!run) {
      throw new RunNotFoundError(id);
    }
    const meta = run.read();
    if (meta.status !== "blocked" || !meta.wait) {
      throw new RunNotResumableError(id);
    }
    const plan = this.deps.module.planResume?.(meta) ?? null;
    if (!plan) {
      throw new RunNotResumableError(id);
    }
    const resumed = run.resumed(plan.fromStage, "module", plan.reason);
    this.enqueue(run, plan.input);
    return resumed;
  }

  /**
   * Reconstruct work whose in-memory queue vanished. Future and indefinite
   * waits remain blocked; due clock waits and Module-planned pending/running
   * Runs are returned to the same queue in place.
   */
  async recoverRuns(): Promise<number> {
    let recovered = 0;
    const now = this.deps.now?.() ?? new Date();
    for (const summary of this.deps.runs.list({ module: this.deps.module.id }).runs) {
      if (this.active.has(summary.id)) {
        continue;
      }
      const run = this.deps.runs.open(summary.id);
      if (!run) {
        continue;
      }
      const meta = run.read();
      if (meta.status === "blocked" && meta.wait?.timeout.kind === "at") {
        if (Date.parse(meta.wait.timeout.at) > now.getTime()) {
          continue;
        }
        const plan = this.deps.module.planResume?.(meta) ?? null;
        if (plan) {
          run.resumed(plan.fromStage, "clock", plan.reason);
          if (this.enqueue(run, plan.input)) {
            recovered += 1;
          }
        }
        continue;
      }
      if (meta.status !== "pending" && meta.status !== "running") {
        continue;
      }
      const detail = this.deps.runs.detail(meta.id);
      const state: RecoveryState = {
        ...meta,
        events: detail?.events ?? [],
        files: detail?.files ?? [],
      };
      const plan = this.deps.module.planRecovery?.(state) ?? null;
      if (!plan) {
        continue;
      }
      run.recovered(plan.fromStage, plan.reason);
      if (this.enqueue(run, plan.input)) {
        recovered += 1;
      }
    }
    return recovered;
  }

  /** Keep clock waits live after boot; the durable record remains the source of truth. */
  startRecoveryLoop(intervalMs = 30_000): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    void this.recoverRuns();
    this.recoveryTimer = setInterval(() => void this.recoverRuns(), intervalMs);
    this.recoveryTimer.unref();
  }

  stopRecoveryLoop(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private enqueue(run: RunHandle, input: Input): boolean {
    if (this.active.has(run.id)) {
      return false;
    }
    this.active.add(run.id);
    this.queue = this.queue.then(() => this.execute(run, input));
    return true;
  }

  private async execute(run: RunHandle, input: Input): Promise<void> {
    try {
      run.finished(await this.deps.module.run(this.context(run), input));
    } catch (error) {
      /* A Stage failure is already on the Run, so the log stays quiet about it.
         Anything else escaped a Stage — a Module bug, or durable work refused
         outside one — and leaves the Run where it stood, which is the restart
         hole's shape and is fixed with it.

         The one state where nothing can be read is a Run whose record was
         deleted under the engine — the one-time reset removes runs/ while an
         execute is still in flight (issue #144). The Run is gone, so there is
         nothing to mark: the queue stays settled instead of crashing the
         process with an unhandled rejection. */
      let status: string;
      try {
        status = run.read().status;
      } catch {
        this.deps.log?.(`Run ${run.id} record is gone; nothing to mark: ${errorMessage(error)}`);
        return;
      }
      if (!TERMINAL.has(status)) {
        this.deps.log?.(`Run ${run.id} stopped outside a Stage: ${errorMessage(error)}`);
      }
    } finally {
      this.active.delete(run.id);
    }
  }

  /**
   * One Run's context. Every durable capability is refused while no Stage is
   * open, which is what stops a Run's status and its timeline disagreeing.
   */
  private context(run: RunHandle): RunContext {
    const mod = this.deps.module;
    const stack: string[] = [];
    const inStage = (what: string): void => {
      if (stack.length === 0) {
        throw new OutsideStageError(what);
      }
    };
    return {
      runId: run.id,
      meta: () => run.read(),
      async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
        stack.push(name);
        run.started(name);
        try {
          return await fn();
        } catch (error) {
          if (error instanceof RunBlocked) {
            throw error;
          }
          const failure = error instanceof StageFailure ? error : null;
          const reason = errorMessage(error);
          const diagnosticDetail = modelDiagnosticEventDetail(error);
          const flags =
            failure?.flags || Object.keys(diagnosticDetail).length > 0
              ? {
                  ...failure?.flags,
                  eventDetail: {
                    ...failure?.flags?.eventDetail,
                    ...diagnosticDetail,
                  },
                }
              : undefined;
          run.failed(name, reason, failure?.hint ?? mod.failureHint(name, reason), flags);
          throw error;
        } finally {
          stack.pop();
        }
      },
      event: (type, detail) => {
        inStage(`event ${type}`);
        run.appendEvent(type, detail);
      },
      attempt: () => {
        inStage("attempt");
        return run.attemptStarted();
      },
      wait: ({ reason, timeout }) => {
        inStage("wait");
        const stage = stack.at(-1)!;
        run.blocked({
          requestedAt: (this.deps.now?.() ?? new Date()).toISOString(),
          stage,
          reason,
          timeout,
        });
        throw new RunBlocked();
      },
      readFile: (name) => run.readArtifact(name),
      writeFile: (name, text) => {
        inStage(`write ${name}`);
        run.writeArtifact(name, text);
      },
    };
  }
}
