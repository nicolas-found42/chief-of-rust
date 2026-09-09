import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MeetingDebriefActionItem,
  MeetingDebriefReviewState,
  MeetingDebriefRunResult,
} from "@chief-of-staff-demo/shared";
import {
  MEETING_DEBRIEF_INTAKE,
  MEETING_DEBRIEF_MODULE_ID,
  MEETING_DEBRIEF_MODULE_VERSION,
} from "@chief-of-staff-demo/shared";
import { openRuns, type RunHandle, type Runs } from "../../../apps/server/src/runs";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import {
  migrateLegacyActionReview,
  migrateLegacyTaskReceipts,
} from "../../../apps/server/src/tasks/legacy-migration";

/**
 * Legacy Debrief review carried into canonical records (issue #183). The
 * decisions were arrays of positions in a Run file; the work they represent is
 * real, and the Run files that recorded it are evidence the migration never
 * rewrites.
 */
const NOW = new Date("2026-09-04T09:00:00.000Z");

let workspaceDir: string;
let runs: Runs;
let tasks: WorkspaceTasks;
let actionItems: WorkspaceActionItems;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-legacy-actions-"));
  runs = openRuns(workspaceDir);
  const store = new TaskStore(workspaceDir);
  tasks = new WorkspaceTasks({ store, now: () => NOW });
  actionItems = new WorkspaceActionItems({ store, now: () => NOW });
});

function proposal(overrides: Partial<MeetingDebriefActionItem> = {}): MeetingDebriefActionItem {
  return {
    title: "Follow up on the billing fix",
    owner: "Alice",
    ownerMentionId: "m_alice",
    ownerProfileId: null,
    dueDate: "2026-08-22",
    ...overrides,
  };
}

/** One legacy Debrief Run: its stored extraction, and the review it carried. */
function legacyRun(options: {
  actionItems: MeetingDebriefActionItem[];
  dropped?: number[];
  completed?: number[];
  taskReceipts?: number[];
  withReview?: boolean;
}): RunHandle {
  const run = runs.create({
    module: MEETING_DEBRIEF_MODULE_ID,
    moduleVersion: MEETING_DEBRIEF_MODULE_VERSION,
    intake: MEETING_DEBRIEF_INTAKE,
    sourceUrl: null,
    externalId: "drive_fileA_r1",
  });
  const result: MeetingDebriefRunResult = {
    version: 1,
    transcriptId: "drive_fileA_r1",
    extractedAt: NOW.toISOString(),
    debrief: {
      version: 1,
      summary: "Review of the weekly sync",
      decisions: [],
      actionItems: options.actionItems,
      openQuestions: [],
      effectivenessEvidence: "",
      coachingAdvice: "",
      suggestedRecipients: [],
    },
  };
  run.writeArtifact("result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (options.withReview !== false) {
    const review: MeetingDebriefReviewState = {
      version: 1,
      runId: run.id,
      roster: { status: "confirmed", confirmedAt: NOW.toISOString(), entries: [] },
      recipients: { additional: [] },
      review: {
        droppedActionItems: options.dropped ?? [],
        completedActionItems: options.completed ?? [],
      },
      request: null,
      approval: null,
    };
    run.writeArtifact("review.json", `${JSON.stringify(review, null, 2)}\n`);
  }
  if (options.taskReceipts) {
    run.writeArtifact(
      "tasks.json",
      `${JSON.stringify(
        {
          version: 1,
          tasks: options.taskReceipts.map((index) => ({ index, taskId: `google_${index}` })),
        },
        null,
        2,
      )}\n`,
    );
  }
  return run;
}

function migrate() {
  return migrateLegacyActionReview({ runs, tasks, actionItems });
}

describe("migrating legacy Debrief review", () => {
  it("adopts only app receipts, refreshes their status, and never creates remote records on restart", async () => {
    const run = legacyRun({ actionItems: [proposal()], taskReceipts: [0] });
    const receiptBefore = run.readArtifact("tasks.json");
    const reads: string[] = [];
    const deps = {
      runs,
      tasks,
      actionItems,
      destination: {
        provider: "google-tasks" as const,
        googleTaskListId: "legacy_list",
        googleTaskListTitle: "Meeting actions",
      },
      read: async (_destination: unknown, remoteId: string) => {
        reads.push(remoteId);
        return {
          title: "Follow up on the billing fix",
          notes: "",
          dueDate: "2026-08-22",
          status: "completed" as const,
        };
      },
    };
    await migrateLegacyTaskReceipts(deps);
    await migrateLegacyTaskReceipts(deps);
    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]).toMatchObject({
      status: "completed",
      externalLink: { remoteId: "google_0", state: "synchronized" },
    });
    expect(actionItems.list()[0].state).toBe("promoted");
    expect(reads).toEqual(["google_0"]);
    expect(run.readArtifact("tasks.json")).toBe(receiptBefore);
  });
  it.each([
    {
      name: "a provider that no longer holds the record",
      read: async () => null,
      state: "missing",
      failure: { kind: "not-found" },
    },
    {
      name: "a provider that refuses the saved credential",
      read: async () => {
        throw Object.assign(new Error("unauthorized"), { code: 401 });
      },
      state: "failed",
      failure: { kind: "authorization" },
    },
    {
      name: "a provider that cannot be reached at all",
      read: async () => {
        throw Object.assign(new Error("offline"), { code: 503 });
      },
      state: "failed",
      failure: { kind: "network" },
    },
  ])("still yields a usable Task and a recoverable link against $name", async (scenario) => {
    const run = legacyRun({ actionItems: [proposal()], taskReceipts: [0] });
    const receiptBefore = run.readArtifact("tasks.json");
    const deps = {
      runs,
      tasks,
      actionItems,
      destination: {
        provider: "google-tasks" as const,
        googleTaskListId: "legacy_list",
        googleTaskListTitle: "Meeting actions",
      },
      read: scenario.read,
    };

    await migrateLegacyTaskReceipts(deps);

    /* The Task is the point of the migration; the provider is not. */
    const [task] = tasks.list({});
    expect(task).toMatchObject({
      title: "Follow up on the billing fix",
      status: "open",
      externalLink: {
        remoteId: "google_0",
        state: scenario.state,
        failure: scenario.failure,
        /* Recoverable: the identity to retry against is still on the link. */
        baseline: { title: "Follow up on the billing fix", status: "open" },
      },
    });
    expect(actionItems.list()[0]).toMatchObject({ state: "promoted", promotedTaskId: task.id });

    /* And resuming against the same unavailable provider duplicates nothing. */
    await migrateLegacyTaskReceipts(deps);
    expect(tasks.list({})).toHaveLength(1);
    expect(actionItems.list()).toHaveLength(1);
    expect(run.readArtifact("tasks.json")).toBe(receiptBefore);
  });

  it("materializes every undecided proposal as a pending Action Item", () => {
    legacyRun({ actionItems: [proposal(), proposal({ title: "Book the follow-up" })] });

    const result = migrate();

    expect(result).toMatchObject({ runs: 1, actionItems: 2, dismissed: 0, completedTasks: 0 });
    expect(actionItems.list().map((item) => item.state)).toEqual(["pending", "pending"]);
    expect(tasks.list({})).toEqual([]);
  });

  it("carries a dismissed position across as dismissed history", () => {
    legacyRun({
      actionItems: [proposal(), proposal({ title: "Book the follow-up" })],
      dropped: [1],
    });

    expect(migrate()).toMatchObject({ dismissed: 1 });

    const items = actionItems.list();
    expect(items[0]?.state).toBe("pending");
    expect(items[1]).toMatchObject({ state: "dismissed", promotedTaskId: null });
    /* Dismissal creates nothing: it is a decision not to accept work. */
    expect(tasks.list({ trashed: false })).toEqual([]);
  });

  it("carries a locally done position across as a completed Task", () => {
    legacyRun({ actionItems: [proposal()], completed: [0] });

    expect(migrate()).toMatchObject({ completedTasks: 1 });

    const [item] = actionItems.list();
    expect(item.state).toBe("promoted");
    const [task] = tasks.list({ status: "completed" });
    expect(task).toMatchObject({
      title: "Follow up on the billing fix",
      status: "completed",
      source: { actionItemId: item.id },
    });
    expect(task.completedAt).not.toBeNull();
  });

  it("resumes a crash after Task creation before applying legacy Done", () => {
    legacyRun({ actionItems: [proposal()], completed: [0] });
    const crash = vi.spyOn(tasks, "complete").mockImplementationOnce(() => {
      throw new Error("power loss");
    });
    expect(migrate).toThrow("power loss");
    crash.mockRestore();
    const store = new TaskStore(workspaceDir);
    tasks = new WorkspaceTasks({ store, now: () => NOW });
    actionItems = new WorkspaceActionItems({ store, now: () => NOW });
    runs = openRuns(workspaceDir);
    migrate();
    migrate();
    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0].status).toBe("completed");
    expect(actionItems.list()[0].promotedTaskId).toBe(tasks.list()[0].id);
  });

  it("keeps legacy positions when identical proposals precede Done and dismissal", () => {
    legacyRun({
      actionItems: [
        proposal(),
        proposal(),
        proposal({ title: "Done work" }),
        proposal({ title: "Dismissed work" }),
      ],
      completed: [2],
      dropped: [3],
    });
    migrate();
    expect(tasks.list().map((task) => [task.title, task.status])).toEqual([
      ["Done work", "completed"],
    ]);
    expect(actionItems.list().find((item) => item.proposal.title === "Dismissed work")?.state).toBe(
      "dismissed",
    );
    const before = actionItems.list();
    migrate();
    expect(actionItems.list()).toEqual(before);
    expect(tasks.list()).toHaveLength(1);
  });

  it("leaves a Google-backed done decision for the provider migration", () => {
    legacyRun({ actionItems: [proposal()], completed: [0], taskReceipts: [0] });

    expect(migrate()).toMatchObject({ completedTasks: 0 });

    /* Pending, not promoted: this one needs the External Task Link that
       issue #188 creates, and a Task with no link would lose the connection
       to the record Google still holds. */
    expect(actionItems.list()[0]?.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });

  it("migrates a Run that stored an extraction but never a review", () => {
    legacyRun({ actionItems: [proposal()], withReview: false });

    expect(migrate()).toMatchObject({ runs: 1, actionItems: 1 });
    expect(actionItems.list()[0]?.state).toBe("pending");
  });

  it("carries nothing across from a Run that never extracted anything", () => {
    runs.create({
      module: MEETING_DEBRIEF_MODULE_ID,
      moduleVersion: MEETING_DEBRIEF_MODULE_VERSION,
      intake: MEETING_DEBRIEF_INTAKE,
      sourceUrl: null,
      externalId: "drive_fileB_r1",
    });

    expect(migrate()).toMatchObject({ runs: 0, actionItems: 0 });
    expect(actionItems.list()).toEqual([]);
  });

  it("reaches the same state however many times it runs", () => {
    legacyRun({
      actionItems: [
        proposal(),
        proposal({ title: "Book the follow-up" }),
        proposal({ title: "Send the note" }),
      ],
      dropped: [1],
      completed: [2],
    });

    const first = migrate();
    const before = { items: actionItems.list(), tasks: tasks.list({}) };

    const second = migrate();

    expect(first).toMatchObject({ actionItems: 3, dismissed: 1, completedTasks: 1 });
    expect(second).toMatchObject({ actionItems: 0, dismissed: 0, completedTasks: 0 });
    expect(actionItems.list()).toEqual(before.items);
    expect(tasks.list({})).toEqual(before.tasks);
  });

  it("resumes a pass that stopped after part of one Run", () => {
    legacyRun({ actionItems: [proposal(), proposal({ title: "Send the note" })], completed: [1] });
    /* The interrupted state: the queue materialized, no decision applied. */
    const partial = actionItems.materialize({
      debriefRunId: runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id,
      transcriptId: "drive_fileA_r1",
      meetingId: null,
      actionItems: [proposal(), proposal({ title: "Send the note" })],
    });
    expect(partial.every((item) => item.state === "pending")).toBe(true);

    expect(migrate()).toMatchObject({ actionItems: 0, completedTasks: 1 });
    expect(tasks.list({ status: "completed" }).map((task) => task.title)).toEqual([
      "Send the note",
    ]);
  });

  it("leaves the old Run files exactly as it found them", () => {
    const run = legacyRun({ actionItems: [proposal()], dropped: [0] });
    const dir = join(workspaceDir, "runs", run.id);
    const before = ["result.json", "review.json"].map((name) =>
      readFileSync(join(dir, name), "utf8"),
    );

    migrate();

    expect(
      ["result.json", "review.json"].map((name) => readFileSync(join(dir, name), "utf8")),
    ).toEqual(before);
  });
});
