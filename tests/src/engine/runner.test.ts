import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunMeta } from "@chief-of-staff-demo/shared";
import {
  StageFailure,
  type RetryPlan,
  type RunContext,
  type ShellModule,
} from "../../../apps/server/src/engine/module";
import {
  Runner,
  RunNotFoundError,
  RunNotResumableError,
} from "../../../apps/server/src/engine/runner";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

/**
 * The Module context is this spec's principal seam: a Module is tested by
 * driving its `run` with a context over a temporary Workspace, which is what
 * ADR-0003 said a Module would be, and now is. Nothing here goes through HTTP,
 * Google, or a model.
 */
interface FakeInput {
  /** What the Module does inside its one Stage. */
  work?: (ctx: RunContext) => Promise<void>;
  /** What it tries before opening a Stage at all. */
  before?: (ctx: RunContext) => void;
}

let workspaceDir: string;
let runs: Runs;
/** What the fake Module refused to do outside a Stage, as it saw it. */
let refusal: string | null;

function fakeModule(overrides: Partial<ShellModule<FakeInput>> = {}): ShellModule<FakeInput> {
  return {
    id: "fake",
    version: 2,
    failureHint: (stage) => `${stage} did not work.`,
    planRetry: () => null,
    async run(ctx, input) {
      if (input.before) {
        try {
          input.before(ctx);
        } catch (error) {
          refusal = error instanceof Error ? error.name : String(error);
        }
      }
      return await ctx.stage("only", async () => {
        await input.work?.(ctx);
        return { status: "done" };
      });
    },
    ...overrides,
  };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-runner-"));
  runs = openRuns(workspaceDir);
  refusal = null;
});

const record = { intake: "manual", sourceUrl: null, externalId: null };

describe("driving a Module with a context", () => {
  it("stamps the Module's identity on the Run and records the Stage it opened", async () => {
    const runner = new Runner({ runs, module: fakeModule() });
    const id = await runner.startRun(record, {
      work: async (ctx) => {
        ctx.writeFile("counted.json", JSON.stringify({ seen: 3 }));
        ctx.event("counted", { seen: 3 });
      },
    });
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    expect(runs.open(id)!.read().module).toBe("fake");
    expect(runs.open(id)!.read().moduleVersion).toBe(2);
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "counted",
      "run_done",
    ]);
    expect(runs.open(id)!.readArtifact("counted.json")).toBe('{"seen":3}');
  });

  it("carries the Module's own outcome, including a Run that ends without doing the work", async () => {
    const runner = new Runner({
      runs,
      module: fakeModule({
        async run(ctx) {
          return await ctx.stage("only", async () => ({
            status: "skipped",
            reason: "nothing to do",
          }));
        },
      }),
    });
    const id = await runner.startRun(record, {});
    await runner.idle();

    expect(runs.detail(id)!.status).toBe("skipped");
    expect(runs.detail(id)!.skipReason).toBe("nothing to do");
  });

  it("durably blocks inside a Stage without recording a failure or terminal outcome", async () => {
    const runner = new Runner({
      runs,
      module: fakeModule(),
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const id = await runner.startRun(record, {
      work: async (ctx) => {
        ctx.wait({
          reason: "Choose at least one opportunity or skip this shortlist.",
          timeout: { kind: "none" },
        });
      },
    });
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("blocked");
    expect(detail.wait).toMatchObject({
      requestedAt: "2026-08-25T12:00:00.000Z",
      stage: "only",
      timeout: { kind: "none" },
    });
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "run_blocked",
    ]);
  });
});

describe("a Module cannot do durable work outside a Stage", () => {
  it("refuses a file, an event and an attempt, and records none of them", async () => {
    const runner = new Runner({ runs, module: fakeModule() });
    const id = await runner.startRun(record, {
      before: (ctx) => ctx.writeFile("early.json", "{}"),
    });
    await runner.idle();

    expect(refusal).toBe("OutsideStageError");
    expect(existsSync(join(workspaceDir, "runs", id, "early.json"))).toBe(false);
    /* The Run still finished: the refusal is the Shell declining to record
       something, not a failure of the Module's work. */
    expect(runs.detail(id)!.status).toBe("done");

    const events = new Runner({ runs, module: fakeModule() });
    const second = await events.startRun(record, { before: (ctx) => ctx.event("early") });
    await events.idle();
    expect(refusal).toBe("OutsideStageError");
    expect(runs.detail(second)!.events.map((e) => e.type)).not.toContain("early");

    const attempts = new Runner({ runs, module: fakeModule() });
    const third = await attempts.startRun(record, { before: (ctx) => void ctx.attempt() });
    await attempts.idle();
    expect(refusal).toBe("OutsideStageError");
    expect(runs.detail(third)!.attempts).toBe(0);
  });

  it("leaves a Run alone when the refusal escapes the Module, rather than claiming it ended", async () => {
    const logged: string[] = [];
    const runner = new Runner({
      runs,
      module: fakeModule({
        async run(ctx) {
          ctx.writeFile("early.json", "{}");
          return { status: "done" };
        },
      }),
      log: (message) => logged.push(message),
    });
    const id = await runner.startRun(record, {});
    await runner.idle();

    expect(runs.detail(id)!.status).toBe("pending");
    expect(logged.join("\n")).toContain("outside a Stage");
  });
});

describe("a failure inside a Stage", () => {
  it("records the Stage and the Module's default hint", async () => {
    const runner = new Runner({ runs, module: fakeModule() });
    const id = await runner.startRun(record, {
      work: async () => {
        throw new Error("the model said no");
      },
    });
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("failed");
    expect(detail.failedStage).toBe("only");
    expect(detail.failureHint).toBe("only did not work.");
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "stage_failed",
      "run_failed",
    ]);
    expect(detail.events.find((e) => e.type === "run_failed")?.detail).toEqual({
      stage: "only",
      reason: "the model said no",
    });
  });

  it("prefers the wording the Module supplied, and its verdict on the connection", async () => {
    const runner = new Runner({ runs, module: fakeModule() });
    const id = await runner.startRun(record, {
      work: async () => {
        throw new StageFailure("google_expired", "Sign in again.", {
          connectionState: "expired",
        });
      },
    });
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.failureHint).toBe("Sign in again.");
    expect(detail.connectionState).toBe("expired");
  });
});

describe("retry", () => {
  const failing = (): ShellModule<FakeInput> =>
    fakeModule({
      planRetry(meta: Readonly<RunMeta>): RetryPlan<FakeInput> | null {
        return meta.status === "failed"
          ? {
              fromStage: "only",
              reason: "failed_stage_is_safe_to_repeat",
              input: {},
              resetAttempts: true,
              discard: ["scratch.json"],
            }
          : null;
      },
    });

  it("carries out the plan the Module wrote, in place", async () => {
    const runner = new Runner({ runs, module: failing() });
    const id = await runner.startRun(record, {
      work: async (ctx) => {
        ctx.attempt();
        ctx.writeFile("scratch.json", "{}");
        throw new Error("boom");
      },
    });
    await runner.idle();
    expect(runs.detail(id)!.attempts).toBe(1);

    const reopened = await runner.retryRun(id);
    expect(reopened.status).toBe("pending");
    expect(reopened.failureHint).toBeNull();
    await runner.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    expect(detail.attempts).toBe(0);
    expect(runs.open(id)!.readArtifact("scratch.json")).toBeNull();
    expect(detail.events.find((event) => event.type === "run_reopened")?.detail).toEqual({
      fromStage: "only",
      reason: "failed_stage_is_safe_to_repeat",
    });
    /* Retried in place: one Run, not two. */
    expect(runs.list().runs).toHaveLength(1);
  });

  it("refuses a Run its Module will not re-run, and one that is not there", async () => {
    const runner = new Runner({ runs, module: failing() });
    const id = await runner.startRun(record, {});
    await runner.idle();

    await expect(runner.retryRun(id)).rejects.toThrow(
      "Run is not retryable because its status is done",
    );
    expect(runs.detail(id)!.events.at(-1)).toMatchObject({
      type: "retry_refused",
      detail: { condition: "status_not_failed", status: "done" },
    });
    await expect(runner.retryRun("run_20260101-000000_deadbeef")).rejects.toThrow(RunNotFoundError);
  });
});

describe("durable resume", () => {
  it("resumes a blocked Run after reconstructing the Runner and refuses a duplicate resume", async () => {
    const module = fakeModule({
      planResume(meta) {
        return meta.status === "blocked"
          ? {
              fromStage: "only",
              reason: "person_wait_was_resolved",
              input: { work: async () => undefined },
            }
          : null;
      },
    });
    const beforeRestart = new Runner({
      runs,
      module,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const id = await beforeRestart.startRun(record, {
      work: async (ctx) => {
        ctx.wait({ reason: "Waiting for a person.", timeout: { kind: "none" } });
      },
    });
    await beforeRestart.idle();

    const afterRestart = new Runner({ runs: openRuns(workspaceDir), module });
    const resumed = await afterRestart.resumeRun(id);
    expect(resumed.status).toBe("pending");
    expect(resumed.wait).toBeNull();
    await afterRestart.idle();

    const detail = runs.detail(id)!;
    expect(detail.status).toBe("done");
    expect(detail.events.map((event) => event.type)).toEqual([
      "created",
      "stage_started",
      "run_blocked",
      "run_resumed",
      "stage_started",
      "run_done",
    ]);
    expect(detail.events.find((event) => event.type === "run_resumed")?.detail).toEqual({
      fromStage: "only",
      requestedBy: "module",
      reason: "person_wait_was_resolved",
    });
    await expect(afterRestart.resumeRun(id)).rejects.toThrow(RunNotResumableError);
  });

  it("recovers only due clock waits and leaves future or indefinite waits blocked", async () => {
    const module = fakeModule({
      planResume(meta) {
        return meta.status === "blocked"
          ? { fromStage: "only", reason: "clock_wait_elapsed", input: {} }
          : null;
      },
    });
    const beforeRestart = new Runner({
      runs,
      module,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const due = await beforeRestart.startRun(record, {
      work: async (ctx) => {
        ctx.wait({
          reason: "Wait until lunch.",
          timeout: { kind: "at", at: "2026-08-25T12:30:00.000Z" },
        });
      },
    });
    const indefinite = await beforeRestart.startRun(record, {
      work: async (ctx) => {
        ctx.wait({ reason: "Wait for a person.", timeout: { kind: "none" } });
      },
    });
    await beforeRestart.idle();

    const tooEarly = new Runner({
      runs: openRuns(workspaceDir),
      module,
      now: () => new Date("2026-08-25T12:29:59.000Z"),
    });
    expect(await tooEarly.recoverRuns()).toBe(0);

    const afterRestart = new Runner({
      runs: openRuns(workspaceDir),
      module,
      now: () => new Date("2026-08-25T12:30:00.000Z"),
    });
    expect(await afterRestart.recoverRuns()).toBe(1);
    await afterRestart.idle();

    expect(runs.detail(due)!.status).toBe("done");
    expect(runs.detail(due)!.events.find((event) => event.type === "run_resumed")?.detail).toEqual({
      fromStage: "only",
      requestedBy: "clock",
      reason: "clock_wait_elapsed",
    });
    expect(runs.detail(indefinite)!.status).toBe("blocked");
  });

  it("recovers orphaned pending and running Runs from Module plans", async () => {
    const pending = runs.create({
      module: "fake",
      moduleVersion: 2,
      ...record,
    });
    const running = runs.create({
      module: "fake",
      moduleVersion: 2,
      ...record,
    });
    running.started("only");
    const runner = new Runner({
      runs: openRuns(workspaceDir),
      module: fakeModule({
        planRecovery(meta) {
          return meta.status === "pending" || meta.status === "running"
            ? { fromStage: "only", reason: "orphaned_fake_run", input: {} }
            : null;
        },
      }),
    });

    expect(await runner.recoverRuns()).toBe(2);
    await runner.idle();

    expect(runs.detail(pending.id)!.status).toBe("done");
    expect(runs.detail(running.id)!.status).toBe("done");
    expect(
      runs.detail(running.id)!.events.find((event) => event.type === "run_recovered")?.detail,
    ).toEqual({
      fromStage: "only",
      previousStatus: "running",
      reason: "orphaned_fake_run",
    });
  });

  it("does not enqueue the same recovered Run twice while it is active", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orphan = runs.create({ module: "fake", moduleVersion: 2, ...record });
    orphan.started("only");
    const runner = new Runner({
      runs,
      module: fakeModule({
        planRecovery: () => ({
          fromStage: "only",
          reason: "orphaned_fake_run",
          input: { work: async () => await hold },
        }),
      }),
    });

    expect(await runner.recoverRuns()).toBe(1);
    expect(await runner.recoverRuns()).toBe(0);
    release();
    await runner.idle();

    expect(
      runs.detail(orphan.id)?.events.filter((event) => event.type === "run_recovered"),
    ).toHaveLength(1);
  });

  it("leaves terminal Runs unchanged during recovery", async () => {
    const done = runs.create({ module: "fake", moduleVersion: 2, ...record });
    done.finished({ status: "done" });
    const skipped = runs.create({ module: "fake", moduleVersion: 2, ...record });
    skipped.finished({ status: "skipped", reason: "nothing to do" });
    const failed = runs.create({ module: "fake", moduleVersion: 2, ...record });
    failed.started("only");
    failed.failed("only", "boom", "Only did not work.");
    const before = [done.id, skipped.id, failed.id].map((id) => runs.detail(id)?.events);
    const runner = new Runner({
      runs,
      module: fakeModule({
        planRecovery: () => ({ fromStage: "only", reason: "orphaned_fake_run", input: {} }),
      }),
    });

    expect(await runner.recoverRuns()).toBe(0);
    expect([done.id, skipped.id, failed.id].map((id) => runs.detail(id)?.events)).toEqual(before);
  });
});
