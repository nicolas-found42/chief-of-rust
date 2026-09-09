import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MeetingDebriefActionItem, Task, TaskOverview } from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";

/**
 * The compact rollup Home and the Meeting Wizard read (issue #192). Counts and
 * capped lists over the canonical stores — the point of the test is that
 * finished work never inflates an active count, and that a cap never hides a
 * total.
 */
let app: FastifyInstance;
let tasks: WorkspaceTasks;
let actionItems: WorkspaceActionItems;
const clock = new Date("2026-09-04T09:00:00.000Z");

function proposal(
  title: string,
  overrides: Partial<MeetingDebriefActionItem> = {},
): MeetingDebriefActionItem {
  return {
    title,
    owner: null,
    ownerMentionId: null,
    ownerProfileId: null,
    dueDate: null,
    ...overrides,
  };
}

beforeEach(() => {
  const store = new TaskStore(mkdtempSync(join(tmpdir(), "cos-task-overview-")));
  tasks = new WorkspaceTasks({ store, now: () => clock, timezone: () => "UTC" });
  actionItems = new WorkspaceActionItems({ store, now: () => clock });
  app = fastify();
  registerTasksApi(app, { tasks, actionItems });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function overview(): Promise<TaskOverview> {
  const response = await app.inject({ method: "GET", url: "/api/tasks/overview" });
  expect(response.statusCode).toBe(200);
  return response.json<TaskOverview>();
}

describe("the compact Tasks overview", () => {
  it("counts active work only, and never the finished, dismissed or trashed", async () => {
    const overdue = tasks.create({ title: "Overdue", dueDate: "2026-09-01" });
    tasks.create({ title: "Due today", dueDate: "2026-09-04" });
    tasks.create({ title: "Later", dueDate: "2026-09-30" });
    const done = tasks.create({ title: "Finished", dueDate: "2026-09-01" });
    tasks.complete(done.id);
    const gone = tasks.create({ title: "Trashed", dueDate: "2026-09-01" });
    tasks.trash(gone.id);
    const [pending, decided] = actionItems.materialize({
      debriefRunId: "run_1",
      transcriptId: "t_1",
      meetingId: null,
      actionItems: [proposal("Still proposed"), proposal("Already dismissed")],
    });
    actionItems.dismiss(decided.id);

    const view = await overview();

    expect(view.today).toBe("2026-09-04");
    expect(view.counts).toEqual({
      open: 3,
      overdue: 1,
      dueToday: 1,
      pendingActionItems: 1,
      failedLinks: 0,
      conflictedLinks: 0,
    });
    expect(view.tasks[0].id).toBe(overdue.id);
    expect(view.actionItems.map((item) => item.id)).toEqual([pending.id]);
  });

  it("caps both compact lists at eight while the counts keep the totals", async () => {
    for (let index = 0; index < 11; index += 1) {
      tasks.create({ title: `Task ${index}`, dueDate: "2026-09-10" });
    }
    actionItems.materialize({
      debriefRunId: "run_1",
      transcriptId: "t_1",
      meetingId: null,
      actionItems: Array.from({ length: 9 }, (_, index) => proposal(`Proposal ${index}`)),
    });

    const view = await overview();

    expect(view.tasks).toHaveLength(8);
    expect(view.actionItems).toHaveLength(8);
    expect(view.counts.open).toBe(11);
    expect(view.counts.pendingActionItems).toBe(9);
  });

  it("separates a link that failed from one waiting on an owner decision", async () => {
    const destination = {
      provider: "google-tasks",
      googleTaskListId: "list",
      googleTaskListTitle: "Work",
    } as const;
    const link = (task: Task, state: "failed" | "conflicted" | "changed-externally") =>
      tasks.recordExternalLink(task.id, {
        destination,
        remoteId: "remote",
        url: null,
        state,
        baseline: null,
        external: null,
        failure: null,
      });
    link(tasks.create({ title: "Write failed" }), "failed");
    link(tasks.create({ title: "Both completed" }), "conflicted");
    link(tasks.create({ title: "Edited outside" }), "changed-externally");
    /* A failed link on finished work is still an unsettled write. */
    const completed = tasks.create({ title: "Done but unsynchronized" });
    link(completed, "failed");
    tasks.complete(completed.id);

    const view = await overview();

    expect(view.counts.failedLinks).toBe(2);
    expect(view.counts.conflictedLinks).toBe(2);
    expect(view.counts.open).toBe(3);
  });
});
