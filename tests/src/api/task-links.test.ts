import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Task } from "@chief-of-staff-demo/shared";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import {
  TaskLinking,
  type GoogleTasksDestination,
  type GoogleTasksDestinationSettings,
  type RemoteTaskConnector,
} from "../../../apps/server/src/tasks/external-link";

/**
 * Google Tasks as an optional Task Destination (issue #184, ADR-0056).
 *
 * The Google client is a double here on purpose: what is under test is that
 * the Workspace commits first, that at most one link exists, and that a Google
 * failure costs a link rather than a Task.
 */
let app: FastifyInstance;
let settings: GoogleTasksDestinationSettings;
let remoteLists: { id: string; title: string }[];
let createRemote: Mock<RemoteTaskConnector<GoogleTasksDestination>["create"]>;

beforeEach(() => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-task-links-"));
  const store = new TaskStore(workspaceDir);
  settings = { enabled: false, taskListId: "", taskListTitle: "" };
  remoteLists = [{ id: "list_work", title: "Work" }];
  createRemote = vi.fn(async () => ({ remoteId: "google_1", url: "https://tasks.google.com/1" }));
  const tasks = new WorkspaceTasks({
    store,
    now: () => new Date("2026-09-04T09:00:00.000Z"),
    isGoogleTasksEnabled: () => settings.enabled,
  });
  app = fastify();
  registerTasksApi(app, {
    tasks,
    actionItems: new WorkspaceActionItems({ store }),
    linking: new TaskLinking({
      tasks,
      settings: () => settings,
      save: (next) => {
        settings = next;
      },
      listRemoteLists: async () => remoteLists,
      google: {
        create: createRemote,
        read: async () => ({ title: "", notes: "", dueDate: null, status: "open" as const }),
        updateContent: async () => {},
        delete: async () => {},
        updateStatus: async () => {},
      },
    }),
  });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function enable(): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: "/api/tasks/google-destination",
    payload: { enabled: true, taskListId: "list_work" },
  });
  expect(response.statusCode).toBe(200);
}

async function captureToGoogle(title: string): Promise<Task> {
  const response = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      title,
      destination: {
        provider: "google-tasks",
        googleTaskListId: "list_work",
        googleTaskListTitle: "Work",
      },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Task>();
}

describe("choosing a Google Task List destination", () => {
  it("is disabled until the owner enables it, and refuses a destination until then", async () => {
    const read = await app.inject({ method: "GET", url: "/api/tasks/google-destination" });
    expect(read.json()).toMatchObject({ enabled: false, available: true });

    const refused = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Not yet",
        destination: {
          provider: "google-tasks",
          googleTaskListId: "list_work",
          googleTaskListTitle: "Work",
        },
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe("invalid-destination");
  });

  it("validates the chosen list against the account's own lists", async () => {
    const refused = await app.inject({
      method: "PUT",
      url: "/api/tasks/google-destination",
      payload: { enabled: true, taskListId: "list_nope" },
    });
    expect(refused.statusCode).toBe(400);
    expect(settings.enabled).toBe(false);

    await enable();
    expect(settings).toEqual({ enabled: true, taskListId: "list_work", taskListTitle: "Work" });
  });

  it("offers the account's lists without reading a single Google Task", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tasks/google-lists" });
    expect(response.json<{ lists: unknown[] }>().lists).toEqual(remoteLists);
    expect(createRemote).not.toHaveBeenCalled();
  });

  it("leaves local Tasks working when the destination is disabled again", async () => {
    await enable();
    await app.inject({
      method: "PUT",
      url: "/api/tasks/google-destination",
      payload: { enabled: false },
    });

    expect(settings.enabled).toBe(false);
    const local = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Still fine" },
    });
    expect(local.statusCode).toBe(201);
    expect(local.json<Task>().destination).toEqual({ provider: "local" });
  });
});

describe("creating one External Task Link", () => {
  it("commits the Task locally before Google is asked at all", async () => {
    await enable();
    const task = await captureToGoogle("Send the pricing sheet");

    /* Created, usable, and not yet linked: the outward write is a second step
       over a Task that already exists. */
    expect(task.externalLink).toBeNull();
    expect(createRemote).not.toHaveBeenCalled();

    const linked = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
    expect(linked.json<Task>().externalLink).toMatchObject({
      state: "synchronized",
      remoteId: "google_1",
      url: "https://tasks.google.com/1",
      destination: { provider: "google-tasks", googleTaskListId: "list_work" },
      baseline: { title: "Send the pricing sheet", notes: "", dueDate: null, status: "open" },
    });
  });

  it("records a waiting link before Google is called, and keeps it if the call never returns", async () => {
    await enable();
    const task = await captureToGoogle("Never answers");
    /* A call that never returns is the case the local commit exists for: the
       Task is already written, and the link says what is outstanding. */
    let seen: Task | null = null;
    createRemote.mockImplementationOnce(async () => {
      seen = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json<Task>();
      return { remoteId: "google_1", url: null };
    });

    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });

    expect(seen).not.toBeNull();
    expect(seen!.externalLink).toMatchObject({ state: "waiting", remoteId: null });
  });

  it("keeps the Task and records a failed link when Google refuses", async () => {
    await enable();
    createRemote.mockRejectedValueOnce(new Error("Google is unreachable"));
    const task = await captureToGoogle("Book the room");

    const attempted = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
    expect(attempted.statusCode).toBe(200);
    expect(attempted.json<Task>()).toMatchObject({
      title: "Book the room",
      status: "open",
      externalLink: {
        state: "failed",
        remoteId: null,
        failure: { kind: "unavailable", message: "Google is unreachable" },
      },
    });
  });

  it("gives one Task at most one link", async () => {
    await enable();
    const task = await captureToGoogle("Only once");
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });

    const second = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe("task-already-linked");
    expect(createRemote).toHaveBeenCalledTimes(1);
  });

  it("has nothing to link for a Task filed locally", async () => {
    const local = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Local" },
    });
    const refused = await app.inject({
      method: "POST",
      url: `/api/tasks/${local.json<Task>().id}/link`,
    });

    expect(refused.statusCode).toBe(400);
    expect(createRemote).not.toHaveBeenCalled();
  });
});
