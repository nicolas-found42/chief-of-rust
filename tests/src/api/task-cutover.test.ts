import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskCutover } from "../../../apps/server/src/tasks/cutover";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { openRuns } from "../../../apps/server/src/runs";

describe("canonical Task cutover", () => {
  it("previews without writes, requires exact authorization, atomically preserves canonical work and credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-cutover-"));
    const config = JSON.stringify({
      google: { refreshToken: "fixture-secret" },
      tasklistName: "Historical",
    });
    writeFileSync(join(dir, "config.json"), config);
    const store = new TaskStore(dir);
    const tasks = new WorkspaceTasks({ store });
    const original = tasks.create({ title: "Existing canonical work" });
    const run = openRuns(dir).create({
      module: "meeting-debrief",
      moduleVersion: 1,
      intake: "transcript",
      sourceUrl: null,
      externalId: null,
    });
    run.writeArtifact(
      "result.json",
      JSON.stringify({
        transcriptId: "transcript",
        debrief: {
          actionItems: [
            {
              title: "Legacy work",
              owner: null,
              ownerMentionId: null,
              ownerProfileId: null,
              dueDate: null,
            },
          ],
        },
      }),
    );
    run.writeArtifact(
      "tasks.json",
      JSON.stringify({
        tasks: [{ index: 0, taskId: "old-remote", taskListId: "historical-list" }],
      }),
    );
    const cutover = new TaskCutover({ workspaceDir: dir });
    const preview = await cutover.preview();
    expect(preview.counts).toMatchObject({ tasks: 2, actionItems: 1, receipts: 1 });
    expect(tasks.list()).toEqual([original]);
    expect(store.cutoverReceipt()).toBeNull();
    expect(JSON.stringify(preview)).not.toContain("fixture-secret");
    await expect(
      cutover.execute({ ...preview, workspace: "/wrong", typedConfirmation: "MIGRATE TASKS" }),
    ).rejects.toThrow("authorization");
    expect(tasks.list()).toEqual([original]);
    const receipt = await cutover.execute({ ...preview, typedConfirmation: "MIGRATE TASKS" });
    expect(receipt.authenticationPreserved).toBe(true);
    const reopened = new WorkspaceTasks({ store: new TaskStore(dir) });
    expect(reopened.get(original.id)).toEqual(original);
    expect(reopened.list()).toHaveLength(2);
    expect(
      reopened.list().find((task) => task.title === "Legacy work")?.externalLink,
    ).toMatchObject({
      remoteId: "old-remote",
      destination: { googleTaskListId: "historical-list" },
    });
    expect(await cutover.execute({ ...preview, typedConfirmation: "MIGRATE TASKS" })).toEqual(
      receipt,
    );
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(config);
    reopened.complete(original.id);
    expect(new WorkspaceTasks({ store: new TaskStore(dir) }).get(original.id)?.status).toBe(
      "completed",
    );
  });

  it("rejects a stale preview without publishing migrated records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-cutover-stale-"));
    const cutover = new TaskCutover({ workspaceDir: dir });
    const preview = await cutover.preview();
    const tasks = new WorkspaceTasks({ store: new TaskStore(dir) });
    tasks.create({ title: "New work after preview" });
    await expect(
      cutover.execute({ ...preview, typedConfirmation: "MIGRATE TASKS" }),
    ).rejects.toThrow("changed");
    expect(new TaskStore(dir).cutoverReceipt()).toBeNull();
  });
  it("a failed atomic publication leaves old records authoritative and a restarted retry commits once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-cutover-failure-"));
    const store = new TaskStore(dir);
    const tasks = new WorkspaceTasks({ store });
    const task = tasks.create({ title: "Preserved during failed publication" });
    // A directory at the temporary-file path forces the actual atomic writer to fail.
    mkdirSync(join(dir, "tasks", "state.json.tmp"));
    const cutover = new TaskCutover({ workspaceDir: dir });
    const preview = await cutover.preview();
    await expect(
      cutover.execute({ ...preview, typedConfirmation: "MIGRATE TASKS" }),
    ).rejects.toThrow();
    expect(new TaskStore(dir).cutoverReceipt()).toBeNull();
    expect(new WorkspaceTasks({ store: new TaskStore(dir) }).list()).toEqual([task]);
    rmSync(join(dir, "tasks", "state.json.tmp"), { recursive: true });
    const restarted = new TaskCutover({ workspaceDir: dir });
    const fresh = await restarted.preview();
    const receipt = await restarted.execute({ ...fresh, typedConfirmation: "MIGRATE TASKS" });
    expect(new TaskStore(dir).cutoverReceipt()).toEqual(receipt);
    expect(new WorkspaceTasks({ store: new TaskStore(dir) }).list()).toEqual([task]);
  });
  it("refuses a syntactically valid bundle with a corrupt completion receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-cutover-corrupt-"));
    const cutover = new TaskCutover({ workspaceDir: dir });
    await cutover.execute({ ...(await cutover.preview()), typedConfirmation: "MIGRATE TASKS" });
    const path = join(dir, "tasks", "state.json");
    const bundle = JSON.parse(readFileSync(path, "utf8"));
    bundle.receipt = { kind: "canonical-tasks" };
    writeFileSync(path, JSON.stringify(bundle));
    expect(() => new TaskStore(dir).readTasks()).toThrow("snapshot is unreadable");
    expect(() => new TaskCutover({ workspaceDir: dir }).state()).toThrow("snapshot is unreadable");
  });
});
