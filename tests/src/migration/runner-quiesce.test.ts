import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runner } from "../../../apps/server/src/engine/runner.js";
import type { ShellModule } from "../../../apps/server/src/engine/module.js";
import { openRuns } from "../../../apps/server/src/runs.js";

/**
 * Focused spec for the migration-gate quiesce seam (issue #144), on throwaway
 * fixtures. Pins:
 *  1. Runner.idle() (the HostedModule drain) resolves only after an in-flight
 *     Run's work settles — arm can wait on it before confirm deletes runs/.
 *  2. Deleting a Run's record under the engine while its execute is in flight
 *     does NOT crash the process: the queue stays settled and idle() resolves.
 */
describe("the migration gate's Runner quiesce seam", () => {
  const workspaces: string[] = [];

  function throwawayWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), "runner-quiesce-"));
    workspaces.push(workspace);
    return workspace;
  }

  afterAll(() => {
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
  });

  it("holds idle() until an in-flight Run's work settles", async () => {
    const runs = openRuns(throwawayWorkspace());
    /* The Run's work is gated on this test's own promise, so the settle order
       is deterministic — no wall-clock guess at "long enough". */
    const gate = Promise.withResolvers<void>();
    const module: ShellModule<Record<string, never>> = {
      id: "quiesce-probe",
      version: 1,
      planRetry: () => null,
      failureHint: () => "probe failure",
      async run() {
        await gate.promise;
        return { status: "done", summary: "probe" };
      },
    };
    const runner = new Runner({ runs, module });

    const runId = await runner.startRun(
      { intake: "drive", fileName: "probe-1.md", sourceUrl: null, externalId: null },
      {},
    );
    let settled = false;
    const drained = runner.idle().then(() => {
      settled = true;
    });
    /* A pre-settled sentinel races the drain: if idle() were already resolved
       the drain would win; while the Run is in flight the sentinel wins. */
    const raced = await Promise.race([drained.then(() => "settled"), Promise.resolve("in-flight")]);
    expect(raced, "idle() resolved while the Run was still in flight").toBe("in-flight");

    gate.resolve();
    await drained;
    expect(settled, "idle() did not resolve after the Run settled").toBe(true);
    expect(runId).toBeTruthy();
  });

  it("settles the queue when a Run's record is deleted under the engine mid-execute", async () => {
    const workspace = throwawayWorkspace();
    mkdirSync(workspace, { recursive: true });
    const runs = openRuns(workspace);
    const module: ShellModule<Record<string, never>> = {
      id: "quiesce-probe",
      version: 1,
      planRetry: () => null,
      failureHint: () => "probe failure",
      async run(ctx) {
        rmSync(join(workspace, "runs", ctx.runId), { recursive: true, force: true });
        return { status: "done", summary: "probe" };
      },
    };
    const runner = new Runner({ runs, module });

    const runId = await runner.startRun(
      { intake: "drive", fileName: "probe-2.md", sourceUrl: null, externalId: null },
      {},
    );
    await expect(runner.idle()).resolves.toBeUndefined();
    expect(runId).toBeTruthy();
  });
});
