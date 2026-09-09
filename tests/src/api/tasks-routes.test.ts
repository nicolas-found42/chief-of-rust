import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionItem, Task, TaskIndex, TaskList } from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore, TaskStoreCorruptionError } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";

/**
 * The Tasks product namespace `/api/tasks` and `/api/task-lists` (issues #173,
 * #174) over a real server and a temporary Workspace. No provider is reachable
 * here at all — which is the point: the whole product has to work with nothing
 * connected.
 */
let app: FastifyInstance;
let workspaceDir: string;
/** Profile ids this Workspace treats as confirmed; set per test. */
let confirmedProfiles: Set<string>;
let clock: Date;
let store: TaskStore;

function compose(): FastifyInstance {
  store = new TaskStore(workspaceDir);
  const instance = fastify();
  registerTasksApi(instance, {
    tasks: new WorkspaceTasks({
      store,
      now: () => clock,
      isConfirmedPerson: (profileId) => confirmedProfiles.has(profileId),
      /* Auckland, deliberately: a Workspace whose local date is ahead of UTC
         is where a date-only due date is easiest to get wrong. */
      timezone: () => "Pacific/Auckland",
    }),
    actionItems: new WorkspaceActionItems({ store, now: () => clock }),
  });
  return instance;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-tasks-routes-"));
  confirmedProfiles = new Set<string>();
  clock = new Date("2026-09-04T09:00:00.000Z");
  app = compose();
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function quickAdd(title: string): Promise<Task> {
  const response = await app.inject({ method: "POST", url: "/api/tasks", payload: { title } });
  expect(response.statusCode).toBe(201);
  return response.json<Task>();
}

async function index(query = ""): Promise<TaskIndex> {
  const response = await app.inject({ method: "GET", url: `/api/tasks${query}` });
  expect(response.statusCode).toBe(200);
  return response.json<TaskIndex>();
}

describe("capturing a Task", () => {
  it("takes a title alone and fills every other field with a defensible default", async () => {
    const task = await quickAdd("  Send the billing follow-up  ");

    expect(task).toMatchObject({
      title: "Send the billing follow-up",
      notes: "",
      status: "open",
      dueDate: null,
      priority: "none",
      listId: "inbox",
      responsiblePerson: { kind: "owner" },
      destination: { provider: "local" },
      source: null,
      createdAt: "2026-09-04T09:00:00.000Z",
      updatedAt: "2026-09-04T09:00:00.000Z",
      completedAt: null,
    });
    expect(task.id).toMatch(/^task_/);
  });

  it("lists the Task at /api/tasks beside the Task Lists it can be filed into", async () => {
    const created = await quickAdd("Draft the recap");

    const payload = await index();
    expect(payload.tasks.map((task) => task.id)).toEqual([created.id]);
    expect(payload.lists).toEqual([
      { id: "inbox", name: "Inbox", defaultDestination: { provider: "local" } },
    ]);
  });

  it("keeps the Task and its identity across a restart of the application", async () => {
    const created = await quickAdd("Survives a restart");

    await app.close();
    app = compose();
    await app.ready();

    const payload = await index();
    expect(payload.tasks).toEqual([created]);
  });

  it("refuses a blank title and persists nothing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: " " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("invalid-title");
    expect((await index()).tasks).toEqual([]);
  });
});

describe("completing and reopening", () => {
  it("is idempotent in both directions and keeps the first completion time", async () => {
    const task = await quickAdd("Close the loop");

    clock = new Date("2026-09-04T10:00:00.000Z");
    const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(completed.json<Task>()).toMatchObject({
      status: "completed",
      completedAt: "2026-09-04T10:00:00.000Z",
    });

    clock = new Date("2026-09-04T11:00:00.000Z");
    const again = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(again.json<Task>()).toEqual(completed.json<Task>());

    const reopened = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });
    expect(reopened.json<Task>()).toMatchObject({ status: "open", completedAt: null });

    const stillOpen = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });
    expect(stillOpen.json<Task>()).toEqual(reopened.json<Task>());
  });

  it("separates completed work from open work in the listing", async () => {
    const open = await quickAdd("Still to do");
    const done = await quickAdd("Already done");
    await app.inject({ method: "POST", url: `/api/tasks/${done.id}/complete` });

    expect((await index("?status=open")).tasks.map((task) => task.id)).toEqual([open.id]);
    expect((await index("?status=completed")).tasks.map((task) => task.id)).toEqual([done.id]);
  });

  it("answers 404 for a Task that does not exist", async () => {
    const response = await app.inject({ method: "POST", url: "/api/tasks/task_nope/complete" });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("task-not-found");
  });
});

describe("editing Task details", () => {
  it("edits every mutable field while identity, source and creation time stand", async () => {
    confirmedProfiles.add("profile_alice");
    const task = await quickAdd("Rough title");
    const list = await createList("Billing");

    clock = new Date("2026-09-05T09:00:00.000Z");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: {
        title: "Send the billing follow-up",
        notes: "Include the Q3 numbers.",
        dueDate: "2026-09-11",
        priority: "high",
        listId: list.id,
        responsiblePerson: { kind: "person-profile", profileId: "profile_alice" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Task>()).toMatchObject({
      id: task.id,
      source: null,
      createdAt: task.createdAt,
      updatedAt: "2026-09-05T09:00:00.000Z",
      title: "Send the billing follow-up",
      notes: "Include the Q3 numbers.",
      dueDate: "2026-09-11",
      priority: "high",
      listId: list.id,
      responsiblePerson: { kind: "person-profile", profileId: "profile_alice" },
    });
  });

  it("holds Task Priority to none, low, medium and high", async () => {
    const task = await quickAdd("Priority");

    for (const priority of ["none", "low", "medium", "high"] as const) {
      const accepted = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: { priority },
      });
      expect(accepted.json<Task>().priority).toBe(priority);
    }

    const refused = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { priority: "urgent" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-priority");
  });

  it("keeps a due date a calendar date and refuses anything that is not one", async () => {
    const task = await quickAdd("Due");

    for (const dueDate of ["2026-09-11T00:00:00.000Z", "2026-02-30", "11/09/2026"]) {
      const refused = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: { dueDate },
      });
      expect(refused.statusCode, dueDate).toBe(400);
      expect(refused.json<{ error: string }>().error).toBe("invalid-due-date");
    }

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { dueDate: null },
    });
    expect(cleared.json<Task>().dueDate).toBeNull();
  });

  it("records responsibility only against the owner or a confirmed Person Profile", async () => {
    const task = await quickAdd("Responsibility");

    const refused = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { responsiblePerson: { kind: "person-profile", profileId: "profile_unknown" } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-responsible-person");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { responsiblePerson: null },
    });
    expect(cleared.json<Task>().responsiblePerson).toBeNull();
  });
});

async function createList(name: string): Promise<TaskList> {
  const response = await app.inject({ method: "POST", url: "/api/task-lists", payload: { name } });
  expect(response.statusCode).toBe(201);
  return response.json<TaskList>();
}

describe("organizing Task Lists", () => {
  it("always has Inbox, and adds and renames the owner's own lists beside it", async () => {
    const before = await app.inject({ method: "GET", url: "/api/task-lists" });
    expect(before.json<{ lists: TaskList[] }>().lists).toEqual([
      { id: "inbox", name: "Inbox", defaultDestination: { provider: "local" } },
    ]);

    const list = await createList("Billing");
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/task-lists/${list.id}`,
      payload: { name: "Billing and finance" },
    });
    expect(renamed.json<TaskList>()).toMatchObject({ id: list.id, name: "Billing and finance" });

    const after = await app.inject({ method: "GET", url: "/api/task-lists" });
    expect(after.json<{ lists: TaskList[] }>().lists.map((entry) => entry.name)).toEqual([
      "Inbox",
      "Billing and finance",
    ]);
  });

  it("refuses a rename that leaves the list nameless, and persists nothing of it", async () => {
    const list = await createList("Billing");

    const refused = await app.inject({
      method: "PATCH",
      url: `/api/task-lists/${list.id}`,
      payload: { name: "  ", defaultDestination: { provider: "local" } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-list-name");

    const after = await app.inject({ method: "GET", url: "/api/task-lists" });
    expect(after.json<{ lists: TaskList[] }>().lists).toContainEqual(list);
  });

  it("refuses to rename or delete Inbox", async () => {
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/task-lists/inbox",
      payload: { name: "Everything" },
    });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json<{ error: string }>().error).toBe("inbox-is-permanent");

    const deleted = await app.inject({ method: "DELETE", url: "/api/task-lists/inbox" });
    expect(deleted.statusCode).toBe(409);
  });

  it("refuses to delete a list that still holds Tasks, and accepts it once emptied", async () => {
    const list = await createList("Billing");
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Filed here", listId: list.id },
    });

    const refused = await app.inject({ method: "DELETE", url: `/api/task-lists/${list.id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe("task-list-not-empty");

    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.json<Task>().id}`,
      payload: { listId: "inbox" },
    });
    const accepted = await app.inject({ method: "DELETE", url: `/api/task-lists/${list.id}` });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ lists: TaskList[] }>().lists.map((entry) => entry.id)).toEqual([
      "inbox",
    ]);
  });

  it("applies the list's default Task Destination and lets one Task override it", async () => {
    const list = await createList("Billing");
    expect(list.defaultDestination).toEqual({ provider: "local" });

    const filed = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Uses the list default", listId: list.id },
    });
    expect(filed.json<Task>().destination).toEqual({ provider: "local" });

    const overridden = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Names its own destination",
        listId: list.id,
        destination: { provider: "local" },
      },
    });
    expect(overridden.json<Task>().destination).toEqual({ provider: "local" });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Nowhere", destination: { provider: "carrier-pigeon" } },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toBe("invalid-destination");
  });

  it("accepts a default Task Destination on any list, including Inbox", async () => {
    const set = await app.inject({
      method: "PATCH",
      url: "/api/task-lists/inbox",
      payload: { defaultDestination: { provider: "local" } },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<TaskList>().defaultDestination).toEqual({ provider: "local" });

    const refused = await app.inject({
      method: "PATCH",
      url: "/api/task-lists/inbox",
      payload: { defaultDestination: { provider: "carrier-pigeon" } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-destination");
  });

  it("files a Task into a list that does not exist nowhere at all", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Homeless", listId: "list_nope" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("task-list-not-found");
    expect((await index()).tasks).toEqual([]);
  });
});

/**
 * A damaged Workspace has to say so. Every write persists the whole list, so a
 * read that quietly dropped what it could not recognize would delete those
 * records for good on the very next Quick Add.
 */
describe("a Workspace whose Task file cannot be read", () => {
  function writeTaskFile(content: string): TaskStore {
    mkdirSync(join(workspaceDir, "tasks"), { recursive: true });
    writeFileSync(join(workspaceDir, "tasks", "tasks.json"), content, "utf8");
    return new TaskStore(workspaceDir);
  }

  it("reports corruption rather than an empty store", () => {
    expect(() => writeTaskFile("{ not json").readTasks()).toThrow(TaskStoreCorruptionError);
    expect(() => writeTaskFile('{"tasks":[]}').readTasks()).toThrow(TaskStoreCorruptionError);
    expect(() => writeTaskFile('[{"id":"task_1"}]').readTasks()).toThrow(TaskStoreCorruptionError);
  });

  it("reads a Workspace that has simply never written one as empty", () => {
    expect(new TaskStore(workspaceDir).readTasks()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reading the open Tasks (issue #175)
// ---------------------------------------------------------------------------

/** Capture a Task and immediately give it the fields the query is about. */
async function capture(fields: {
  title: string;
  dueDate?: string | null;
  priority?: string;
  notes?: string;
  listId?: string;
  responsiblePerson?: unknown;
}): Promise<Task> {
  const response = await app.inject({ method: "POST", url: "/api/tasks", payload: fields });
  expect(response.statusCode).toBe(201);
  return response.json<Task>();
}

describe("grouping, searching and filtering open Tasks", () => {
  it("serves today as a calendar date in the Workspace timezone", async () => {
    /* 09:00 UTC on the 4th is already the 4th in Auckland; 21:00 UTC is the
       5th there while UTC still says the 4th. The group a date-only Task lands
       in follows the owner's day, not the server's. */
    expect((await index()).today).toBe("2026-09-04");

    clock = new Date("2026-09-04T21:00:00.000Z");
    expect((await index()).today).toBe("2026-09-05");
  });

  it("orders by due date, then priority, then oldest first", async () => {
    await capture({ title: "Someday", priority: "high" });
    await capture({ title: "Later", dueDate: "2026-09-09" });
    clock = new Date("2026-09-04T09:00:01.000Z");
    await capture({ title: "Today low", dueDate: "2026-09-04", priority: "low" });
    await capture({ title: "Today high", dueDate: "2026-09-04", priority: "high" });

    expect((await index()).tasks.map((task) => task.title)).toEqual([
      "Today high",
      "Today low",
      "Later",
      "Someday",
    ]);
  });

  it("matches a search over title and notes", async () => {
    await capture({ title: "Send the billing follow-up" });
    await capture({ title: "Draft the agenda", notes: "Mention BILLING before the demo" });
    await capture({ title: "Book the room" });

    const found = await index("?search=billing");
    expect(found.tasks.map((task) => task.title).sort()).toEqual([
      "Draft the agenda",
      "Send the billing follow-up",
    ]);
  });

  it("combines the Task List, priority, Responsible Person and link filters", async () => {
    confirmedProfiles.add("profile_dana");
    const listed = await app.inject({
      method: "POST",
      url: "/api/task-lists",
      payload: { name: "Client work" },
    });
    const listId = listed.json<TaskList>().id;

    await capture({ title: "Inbox high owner", priority: "high" });
    await capture({ title: "Client high owner", priority: "high", listId });
    await capture({ title: "Client low owner", priority: "low", listId });
    await capture({
      title: "Client high Dana",
      priority: "high",
      listId,
      responsiblePerson: { kind: "person-profile", profileId: "profile_dana" },
    });

    /* Each filter alone, then all three together: combining them narrows,
       rather than one quietly replacing another. */
    expect((await index(`?listId=${listId}`)).tasks).toHaveLength(3);
    expect((await index("?priority=high")).tasks).toHaveLength(3);
    expect((await index("?responsible=profile_dana")).tasks).toHaveLength(1);
    expect(
      (await index(`?listId=${listId}&priority=high&responsible=owner`)).tasks.map((t) => t.title),
    ).toEqual(["Client high owner"]);
    /* Nothing here has been sent anywhere, so the link filter answers with
       every Task on one side and none on the other. */
    expect((await index("?linked=false")).tasks).toHaveLength(4);
    expect((await index("?linked=true")).tasks).toEqual([]);
  });

  it("keeps completed and trashed Tasks out of the open groups", async () => {
    const completed = await capture({ title: "Already done" });
    const trashed = await capture({ title: "Never mind" });
    await capture({ title: "Still open" });
    await app.inject({ method: "POST", url: `/api/tasks/${completed.id}/complete` });
    await app.inject({ method: "POST", url: `/api/tasks/${trashed.id}/trash` });

    expect((await index("?status=open")).tasks.map((task) => task.title)).toEqual(["Still open"]);
    expect((await index()).tasks.map((task) => task.title).sort()).toEqual([
      "Already done",
      "Still open",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Trash (issue #176)
// ---------------------------------------------------------------------------

describe("trashing, restoring and permanently deleting a Task", () => {
  it("keeps a trashed Task out of ordinary results and in Trash", async () => {
    const task = await quickAdd("Cancel the venue");

    const trashed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/trash` });
    expect(trashed.statusCode).toBe(200);
    expect(trashed.json<Task>().deletedAt).toBe("2026-09-04T09:00:00.000Z");

    expect((await index()).tasks).toEqual([]);
    expect((await index("?status=completed")).tasks).toEqual([]);
    expect((await index("?trashed=true")).tasks.map((entry) => entry.id)).toEqual([task.id]);
  });

  it("restores a Task with its prior open or completed state intact", async () => {
    const task = await quickAdd("Sign the contract");
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/trash` });

    const restored = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/restore` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<Task>()).toMatchObject({ status: "completed", deletedAt: null });
    expect(restored.json<Task>().completedAt).not.toBeNull();
    expect((await index("?trashed=true")).tasks).toEqual([]);
  });

  it("permanently deletes only from Trash, and only when confirmed", async () => {
    const task = await quickAdd("A mistake");

    const notTrashed = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${task.id}?confirm=true`,
    });
    expect(notTrashed.statusCode).toBe(409);
    expect(notTrashed.json<{ error: string }>().error).toBe("task-not-in-trash");

    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/trash` });
    const unconfirmed = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}` });
    expect(unconfirmed.statusCode).toBe(428);
    expect(unconfirmed.json<{ error: string }>().error).toBe("confirmation-required");
    expect((await index("?trashed=true")).tasks).toHaveLength(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${task.id}?confirm=true`,
    });
    expect(deleted.statusCode).toBe(200);
    expect((await index("?trashed=true")).tasks).toEqual([]);
  });

  it("keeps a Task whose Meeting, Debrief and Transcript are gone, and reports the source honestly", async () => {
    /* A Task is a snapshot (ADR-0054). Everything it came from is removed here
       — the harshest version of "the Meeting, Debrief and Transcript were
       deleted" — and the Task has to survive intact, still naming what it came
       from so a surface can say that source is unavailable rather than
       pretending the Task was captured by hand. */
    const promoted = new WorkspaceTasks({ store, now: () => clock }).create(
      { title: "Send the pricing sheet" },
      {
        kind: "action-item",
        actionItemId: "action_item_gone",
        debriefRunId: "run_gone",
        transcriptId: "transcript_gone",
        meetingId: "meeting_gone",
      },
    );
    store.writeActionItems([]);

    const read = await app.inject({ method: "GET", url: `/api/tasks/${promoted.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json<Task>()).toMatchObject({
      title: "Send the pricing sheet",
      source: { kind: "action-item", actionItemId: "action_item_gone" },
    });
    const queue = await app.inject({ method: "GET", url: "/api/action-items" });
    expect(queue.json<{ items: ActionItem[] }>().items).toEqual([]);
  });

  it("reports an unavailable source rather than deleting or corrupting the Task", async () => {
    const items = new WorkspaceActionItems({ store, now: () => clock });
    const item = items.materialize({
      debriefRunId: "run_1",
      transcriptId: "transcript_1",
      meetingId: "meeting_1",
      actionItems: [
        {
          title: "Send the pricing sheet",
          owner: null,
          ownerMentionId: null,
          ownerProfileId: null,
          dueDate: null,
        },
      ],
    })[0];
    const promoted = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });
    const taskId = promoted.json<{ task: Task }>().task.id;
    expect((await index()).unavailableSources).toEqual([]);

    /* Everything the Task came from is deleted underneath it. */
    store.writeActionItems([]);

    const after = await index();
    expect(after.tasks.map((task) => task.id)).toEqual([taskId]);
    expect(after.unavailableSources).toEqual([taskId]);
  });

  it("keeps the previous valid Task store when a write is interrupted", async () => {
    const kept = await quickAdd("Survives the crash");
    /* Writes are atomic (ADR-0058): a torn temporary file is not the store,
       and the store is whatever the last completed write left behind. */
    writeFileSync(join(workspaceDir, "tasks", "tasks.json.tmp"), '[{"id":', "utf8");

    expect(new TaskStore(workspaceDir).readTasks().map((task) => task.id)).toEqual([kept.id]);
    expect((await index()).tasks.map((task) => task.id)).toEqual([kept.id]);
  });
});

// ---------------------------------------------------------------------------
// Promotion (issue #178)
// ---------------------------------------------------------------------------

describe("promoting one reviewed Action Item", () => {
  const PROPOSED = {
    debriefRunId: "run_1",
    transcriptId: "transcript_1",
    meetingId: "meeting_1",
    actionItems: [
      {
        title: "Send the pricing sheet",
        owner: "Dana",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: "2026-09-10",
      },
    ],
  };

  function materialize(): ActionItem {
    const items = new WorkspaceActionItems({ store, now: () => clock });
    return items.materialize(PROPOSED)[0];
  }

  it("creates one open canonical Task that snapshots the accepted proposal", async () => {
    const item = materialize();

    const response = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: { title: "Send the pricing sheet to Dana", priority: "high" },
    });
    expect(response.statusCode).toBe(201);

    const { task, actionItem } = response.json<{ task: Task; actionItem: ActionItem }>();
    expect(task).toMatchObject({
      title: "Send the pricing sheet to Dana",
      status: "open",
      priority: "high",
      dueDate: "2026-09-10",
      source: {
        kind: "action-item",
        actionItemId: item.id,
        debriefRunId: "run_1",
        transcriptId: "transcript_1",
        meetingId: "meeting_1",
      },
    });
    expect(actionItem).toMatchObject({ state: "promoted", promotedTaskId: task.id });
    /* The proposal is what the meeting said, and stays that way however the
       Task is edited afterwards. */
    expect(actionItem.proposal.title).toBe("Send the pricing sheet");
  });

  it("creates a completed Task when the review says the work is already done", async () => {
    const item = materialize();

    const response = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: { completed: true },
    });

    expect(response.json<{ task: Task }>().task).toMatchObject({
      status: "completed",
      completedAt: "2026-09-04T09:00:00.000Z",
    });
  });

  it("cannot promote the same Action Item twice, however often it is retried", async () => {
    const item = materialize();
    const first = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: { title: "A different title entirely" },
    });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ task: Task }>().task.id).toBe(first.json<{ task: Task }>().task.id);
    expect((await index()).tasks).toHaveLength(1);
  });

  it("adopts the Task an interrupted promotion left behind rather than making a second", async () => {
    const item = materialize();
    /* Exactly what an interruption between the two writes leaves: the Task
       written and the relationship not. The two files cannot commit as one, so
       the retry has to recognize the half that did. */
    const orphan = new WorkspaceTasks({ store, now: () => clock }).create(
      { title: "Send the pricing sheet" },
      {
        kind: "action-item",
        actionItemId: item.id,
        debriefRunId: item.source.debriefRunId,
        transcriptId: item.source.transcriptId,
        meetingId: item.source.meetingId,
      },
    );

    const retry = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ task: Task }>().task.id).toBe(orphan.id);
    expect(retry.json<{ actionItem: ActionItem }>().actionItem).toMatchObject({
      state: "promoted",
      promotedTaskId: orphan.id,
    });
    expect((await index()).tasks).toHaveLength(1);
  });

  it("keeps the Action Item promoted after its Task is trashed and deleted", async () => {
    const item = materialize();
    const promoted = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });
    const taskId = promoted.json<{ task: Task }>().task.id;

    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/trash` });
    await app.inject({ method: "DELETE", url: `/api/tasks/${taskId}?confirm=true` });

    const queue = await app.inject({ method: "GET", url: "/api/action-items?state=promoted" });
    expect(queue.json<{ items: ActionItem[] }>().items).toHaveLength(1);
    /* And promotion stays unavailable: the decision is history, not a slot
       that opens up again because the work went away. */
    const again = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });
    expect(again.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Possible duplicates (issue #180)
// ---------------------------------------------------------------------------

describe("warning about a possible duplicate", () => {
  async function duplicatesOf(payload: Record<string, unknown>): Promise<Task[]> {
    const response = await app.inject({ method: "POST", url: "/api/tasks/duplicates", payload });
    expect(response.statusCode).toBe(200);
    return response.json<{ duplicates: Task[] }>().duplicates;
  }

  async function capture(payload: Record<string, unknown>): Promise<Task> {
    const response = await app.inject({ method: "POST", url: "/api/tasks", payload });
    expect(response.statusCode).toBe(201);
    return response.json<Task>();
  }

  function materialize(title: string): ActionItem {
    return new WorkspaceActionItems({ store, now: () => clock }).materialize({
      debriefRunId: "run_dup",
      transcriptId: "transcript_dup",
      meetingId: "meeting_dup",
      actionItems: [
        { title, owner: "Dana", ownerMentionId: null, ownerProfileId: null, dueDate: null },
      ],
    })[0];
  }

  it("warns when the normalized title, Responsible Person, and due date all match", async () => {
    const existing = await capture({
      title: "Send the pricing sheet",
      dueDate: "2026-09-10",
      responsiblePerson: { kind: "owner" },
    });

    /* Case and whitespace differences are not difference: the comparison is
       of the normalized tuple. The Responsible Person left out is the owner,
       the same default creation applies. */
    const found = await duplicatesOf({
      title: "  send   THE pricing sheet  ",
      dueDate: "2026-09-10",
    });
    expect(found.map((task) => task.id)).toEqual([existing.id]);
  });

  it("does not warn when any part of the tuple differs", async () => {
    await capture({
      title: "Send the pricing sheet",
      dueDate: "2026-09-10",
      responsiblePerson: { kind: "owner" },
    });

    expect(await duplicatesOf({ title: "Send the pricing sheet", dueDate: "2026-09-11" })).toEqual(
      [],
    );
    expect(await duplicatesOf({ title: "Send the pricing sheet", dueDate: null })).toEqual([]);
    expect(await duplicatesOf({ title: "Reply to the pricing question" })).toEqual([]);
  });

  it("treats Responsible Person as part of the tuple, Nobody included", async () => {
    confirmedProfiles.add("p1");
    await capture({
      title: "Draft the offsite agenda",
      responsiblePerson: { kind: "person-profile", profileId: "p1" },
    });

    const byProfile = await duplicatesOf({
      title: "draft the offsite agenda",
      responsiblePerson: { kind: "person-profile", profileId: "p1" },
    });
    expect(byProfile).toHaveLength(1);
    expect(
      await duplicatesOf({
        title: "draft the offsite agenda",
        responsiblePerson: { kind: "owner" },
      }),
    ).toEqual([]);

    const nobody = await capture({
      title: "Water the office plants",
      responsiblePerson: null,
    });
    const nobodyMatches = await duplicatesOf({
      title: "Water the office plants",
      responsiblePerson: null,
    });
    expect(nobodyMatches.map((task) => task.id)).toEqual([nobody.id]);
  });
  it("warns only about open work: completed and trashed Tasks are history", async () => {
    const done = await capture({ title: "File the expense report" });
    await app.inject({ method: "POST", url: `/api/tasks/${done.id}/complete` });
    const gone = await capture({ title: "Shred the draft contracts" });
    await app.inject({ method: "POST", url: `/api/tasks/${gone.id}/trash` });

    expect(await duplicatesOf({ title: "File the expense report" })).toEqual([]);
    expect(await duplicatesOf({ title: "Shred the draft contracts" })).toEqual([]);
  });

  it("refuses to compare a candidate with no title or an impossible date", async () => {
    const blank = await app.inject({
      method: "POST",
      url: "/api/tasks/duplicates",
      payload: { title: "   " },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ error: "invalid-title" });

    const impossible = await app.inject({
      method: "POST",
      url: "/api/tasks/duplicates",
      payload: { title: "Send the pricing sheet", dueDate: "2026-02-30" },
    });
    expect(impossible.statusCode).toBe(400);
    expect(impossible.json()).toMatchObject({ error: "invalid-due-date" });
  });

  it("never blocks: the owner can still create the duplicate, by hand or by promotion", async () => {
    await capture({ title: "Send the pricing sheet", dueDate: "2026-09-10" });
    expect(
      await duplicatesOf({ title: "Send the pricing sheet", dueDate: "2026-09-10" }),
    ).toHaveLength(1);

    /* The check is a warning's input and nothing more: neither creation route
       gained a confirmation token or a gate. */
    const byHand = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "send the pricing sheet", dueDate: "2026-09-10" },
    });
    expect(byHand.statusCode).toBe(201);

    const item = materialize("Send the pricing sheet");
    const promoted = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: { title: "Send the pricing sheet", dueDate: "2026-09-10" },
    });
    expect(promoted.statusCode).toBe(201);
    expect((await index()).tasks).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Dismissal (issue #179)
// ---------------------------------------------------------------------------

describe("dismissing and restoring a reviewed Action Item", () => {
  const PROPOSED = {
    debriefRunId: "run_1",
    transcriptId: "transcript_1",
    meetingId: "meeting_1",
    actionItems: [
      {
        title: "Send the pricing sheet",
        owner: "Dana",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: "2026-09-10",
      },
    ],
  };

  function materialize(): ActionItem {
    const items = new WorkspaceActionItems({ store, now: () => clock });
    return items.materialize(PROPOSED)[0];
  }

  async function actionQueue(query = ""): Promise<ActionItem[]> {
    const response = await app.inject({ method: "GET", url: `/api/action-items${query}` });
    expect(response.statusCode).toBe(200);
    return response.json<{ items: ActionItem[] }>().items;
  }

  it("dismisses a pending Action Item without creating a Task", async () => {
    const item = materialize();

    const dismissed = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/dismiss`,
    });

    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json<{ actionItem: ActionItem }>().actionItem).toMatchObject({
      id: item.id,
      state: "dismissed",
      promotedTaskId: null,
    });
    expect(dismissed.json<{ actionItem: ActionItem }>().actionItem.decidedAt).not.toBeNull();
    expect((await index()).tasks).toEqual([]);
    expect(await actionQueue("?state=pending")).toEqual([]);
    expect(await actionQueue("?state=dismissed")).toHaveLength(1);
  });

  it("restores a dismissed Action Item to pending", async () => {
    const item = materialize();
    await app.inject({ method: "POST", url: `/api/action-items/${item.id}/dismiss` });

    const restored = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/restore`,
    });

    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ actionItem: ActionItem }>().actionItem).toMatchObject({
      id: item.id,
      state: "pending",
      promotedTaskId: null,
      decidedAt: null,
    });
    expect(await actionQueue("?state=pending")).toHaveLength(1);
    expect(await actionQueue("?state=dismissed")).toEqual([]);
  });

  it("refuses to dismiss a promoted Action Item", async () => {
    const item = materialize();
    await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });

    const dismissed = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/dismiss`,
    });

    expect(dismissed.statusCode).toBe(409);
    expect(await actionQueue("?state=promoted")).toHaveLength(1);
  });

  it("refuses to promote a dismissed Action Item until it is restored", async () => {
    const item = materialize();
    await app.inject({ method: "POST", url: `/api/action-items/${item.id}/dismiss` });

    const promoted = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });

    expect(promoted.statusCode).toBe(409);
    expect((await index()).tasks).toEqual([]);

    await app.inject({ method: "POST", url: `/api/action-items/${item.id}/restore` });
    const retry = await app.inject({
      method: "POST",
      url: `/api/action-items/${item.id}/promote`,
      payload: {},
    });
    expect(retry.statusCode).toBe(201);
  });

  it("answers 404 when dismissing or restoring an unknown Action Item", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/action-items/no_such_item/dismiss" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/api/action-items/no_such_item/restore" }))
        .statusCode,
    ).toBe(404);
  });
});
