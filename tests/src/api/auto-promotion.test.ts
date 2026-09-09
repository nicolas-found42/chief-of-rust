import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionItem,
  ActionItemPolicy,
  MeetingDebriefActionItem,
  Task,
} from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { materializeUnderPolicy } from "../../../apps/server/src/tasks/auto-promotion";

/**
 * Automatic promotion of the owner's own commitments (issue #181). The
 * Workspace default stages everything; the exception the owner may turn on is
 * narrow by construction, and these are the cases it declines.
 */
const OWNER_PROFILE = "profile_owner";
const NOW = new Date("2026-09-04T09:00:00.000Z");

let workspaceDir: string;
let store: TaskStore;
let tasks: WorkspaceTasks;
let actionItems: WorkspaceActionItems;
let policy: ActionItemPolicy;
/** Whether Google Tasks is enabled as a destination; set per test. */
let googleTasksEnabled: boolean;
/** The Task ids automatic promotion asked to be delivered outward. */
let delivered: string[];

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-auto-promotion-"));
  store = new TaskStore(workspaceDir);
  policy = "stage-all";
  delivered = [];
  googleTasksEnabled = false;
  tasks = new WorkspaceTasks({
    store,
    now: () => NOW,
    isGoogleTasksEnabled: () => googleTasksEnabled,
  });
  actionItems = new WorkspaceActionItems({
    store,
    now: () => NOW,
    ownerProfileId: () => OWNER_PROFILE,
  });
});

afterEach(() => {
  workspaceDir = "";
});

function proposal(overrides: Partial<MeetingDebriefActionItem> = {}): MeetingDebriefActionItem {
  return {
    title: "Follow up on the billing fix",
    owner: "Alice",
    ownerMentionId: "m_alice",
    ownerProfileId: OWNER_PROFILE,
    dueDate: "2026-08-22",
    ...overrides,
  };
}

function materialize(
  proposals: MeetingDebriefActionItem[],
  source: { debriefRunId?: string; transcriptId?: string } = {},
  deliver?: (taskId: string) => Promise<Task>,
): ActionItem[] {
  return materializeUnderPolicy(
    {
      tasks,
      actionItems,
      policy: () => policy,
      ...(deliver ? { deliver } : {}),
    },
    {
      debriefRunId: source.debriefRunId ?? "run_1",
      transcriptId: source.transcriptId ?? "drive_fileA_r1",
      meetingId: "meeting_1",
      actionItems: proposals,
    },
  );
}

describe("the Stage all default", () => {
  it("leaves every proposal pending, however obviously it is the owner's", () => {
    const [item] = materialize([proposal()]);

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toEqual([]);
  });
});

describe("Automatically create my Tasks", () => {
  beforeEach(() => {
    policy = "auto-create-mine";
  });

  it("creates one open Task from a first extraction's confidently owned commitment", () => {
    const [item] = materialize([proposal()]);

    expect(item.state).toBe("promoted");
    const created = tasks.list({});
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: "Follow up on the billing fix",
      status: "open",
      dueDate: "2026-08-22",
      responsiblePerson: { kind: "owner" },
      source: { actionItemId: item.id },
    });
    expect(created[0]?.completedAt).toBeNull();
  });

  it("leaves an unassigned or another person's commitment pending", () => {
    const items = materialize([
      proposal({ title: "Nobody's job", ownerProfileId: null }),
      proposal({ title: "Bob's job", owner: "Bob", ownerProfileId: "profile_bob" }),
    ]);

    expect(items.map((item) => item.state)).toEqual(["pending", "pending"]);
    expect(tasks.list({})).toEqual([]);
  });

  it("leaves a possible duplicate pending rather than creating a second Task", () => {
    tasks.create({
      title: "Follow up on the billing fix",
      dueDate: "2026-08-22",
      responsiblePerson: { kind: "owner" },
    });

    const [item] = materialize([proposal()]);

    expect(item.state).toBe("pending");
    expect(tasks.list({})).toHaveLength(1);
  });

  it("stages a regenerated proposal, because the owner has reviewed this Transcript once", () => {
    materialize([proposal()]);

    const items = materialize([proposal(), proposal({ title: "Book the follow-up session" })], {
      debriefRunId: "run_2",
    });

    expect(items.find((item) => item.proposal.title === "Book the follow-up session")?.state).toBe(
      "pending",
    );
    expect(tasks.list({}).map((task) => task.title)).toEqual(["Follow up on the billing fix"]);
  });

  it("creates one Task however many times the same extraction is materialized", () => {
    const first = materialize([proposal()]);

    const again = materialize([proposal()]);

    expect(again.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(again[0]?.promotedTaskId).toBe(first[0]?.promotedTaskId);
    expect(tasks.list({})).toHaveLength(1);
  });

  it("creates no second Task when the same extraction is materialized after a restart", () => {
    const first = materialize([proposal()]);
    expect(first[0]?.state).toBe("promoted");

    /* A second Workspace over the same directory — the shape a restart has.
       Nothing is carried in memory, so the store alone has to say this
       proposal already became a Task. */
    const restartedStore = new TaskStore(workspaceDir);
    const restartedTasks = new WorkspaceTasks({
      store: restartedStore,
      now: () => NOW,
      isGoogleTasksEnabled: () => googleTasksEnabled,
    });
    const restartedActionItems = new WorkspaceActionItems({
      store: restartedStore,
      now: () => NOW,
      ownerProfileId: () => OWNER_PROFILE,
    });
    const again = materializeUnderPolicy(
      { tasks: restartedTasks, actionItems: restartedActionItems, policy: () => policy },
      {
        debriefRunId: "run_1",
        transcriptId: "drive_fileA_r1",
        meetingId: "meeting_1",
        actionItems: [proposal()],
      },
    );

    expect(again.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(again[0]?.promotedTaskId).toBe(first[0]?.promotedTaskId);
    expect(restartedTasks.list({})).toHaveLength(1);
    expect(restartedActionItems.list()).toHaveLength(1);
  });

  it("commits the Task before delivering it, and keeps it when delivery fails", async () => {
    googleTasksEnabled = true;
    tasks.updateList("inbox", {
      defaultDestination: {
        provider: "google-tasks",
        googleTaskListId: "list_1",
        googleTaskListTitle: "Meeting Followups",
      },
    });
    const failures: string[] = [];

    const [item] = materialize([proposal()], {}, (taskId) => {
      delivered.push(taskId);
      failures.push(taskId);
      return Promise.reject(new Error("Google is unavailable"));
    });
    await Promise.resolve();

    expect(item.state).toBe("promoted");
    expect(delivered).toEqual([item.promotedTaskId]);
    expect(failures).toHaveLength(1);
    expect(tasks.list({})).toHaveLength(1);
    expect(tasks.get(item.promotedTaskId ?? "")?.title).toBe("Follow up on the billing fix");
  });

  it("delivers nothing outward for a locally filed Task", () => {
    materialize([proposal()], {}, (taskId) => {
      delivered.push(taskId);
      return Promise.resolve(tasks.get(taskId) as Task);
    });

    expect(delivered).toEqual([]);
  });
});

describe("selecting the policy", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    registerTasksApi(app, {
      tasks,
      actionItems,
      actionItemPolicy: {
        get: () => policy,
        set: (next) => {
          policy = next;
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function put(body: Record<string, unknown>) {
    return app.inject({ method: "PUT", url: "/api/action-item-policy", payload: body });
  }

  it("answers with Stage all until the owner chooses otherwise", async () => {
    const response = await app.inject({ method: "GET", url: "/api/action-item-policy" });

    expect(response.json()).toEqual({ policy: "stage-all", externalDestination: null });
  });

  it("turns automatic promotion on for a locally filed Workspace without ceremony", async () => {
    const response = await put({ policy: "auto-create-mine" });

    expect(response.statusCode).toBe(200);
    expect(policy).toBe("auto-create-mine");
  });

  it("refuses automatic promotion into a provider until the outbound write is confirmed", async () => {
    googleTasksEnabled = true;
    tasks.updateList("inbox", {
      defaultDestination: {
        provider: "google-tasks",
        googleTaskListId: "list_1",
        googleTaskListTitle: "Meeting Followups",
      },
    });

    const refused = await put({ policy: "auto-create-mine" });

    expect(refused.statusCode).toBe(428);
    expect(refused.json()).toMatchObject({ error: "confirmation-required" });
    expect(refused.json<{ message: string }>().message).toContain("Google Tasks");
    expect(policy).toBe("stage-all");

    const confirmed = await put({ policy: "auto-create-mine", confirmedExternalWrites: true });

    expect(confirmed.statusCode).toBe(200);
    expect(policy).toBe("auto-create-mine");
  });

  it("refuses a policy it does not have", async () => {
    const response = await put({ policy: "create-everything" });

    expect(response.statusCode).toBe(400);
    expect(policy).toBe("stage-all");
  });
});
