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
  type GoogleTasksDestinationSettings,
  type RemoteTaskConnector,
} from "../../../apps/server/src/tasks/external-link";

/**
 * Google completion and missing-record synchronization (issue #185, ADR-0056).
 *
 * The Workspace commits first and the link says what happened after: a local
 * completion is pushed outward, an unopposed external completion is applied
 * locally, and a remote record Google no longer holds leaves the Task intact
 * with a missing link the owner can recreate or remove.
 */
/** The Google destination the fake Task carries, as the connector now receives it. */
describe.each([
  { provider: "google-tasks", googleTaskListId: "list_work", googleTaskListTitle: "Work" },
  {
    provider: "asana",
    workspaceGid: "workspace",
    workspaceName: "Workspace",
    projectGid: "project",
    projectName: "Project",
    sectionGid: null,
    sectionName: null,
  },
] as const)("$provider connector behavior", (G_LIST) => {
  const providerLabel = G_LIST.provider === "asana" ? "Asana" : "Google Tasks";

  let app: FastifyInstance;
  let settings: GoogleTasksDestinationSettings;
  let tasks: WorkspaceTasks;
  let workspaceDir: string;
  let createRemote: Mock<RemoteTaskConnector["create"]>;
  let readRemote: Mock<RemoteTaskConnector["read"]>;
  let updateRemoteStatus: Mock<RemoteTaskConnector["updateStatus"]>;
  let updateRemoteContent: Mock<RemoteTaskConnector["updateContent"]>;
  let deleteRemote: Mock<RemoteTaskConnector["delete"]>;

  /**
   * The linking dependencies this suite composes, built fresh from the current
   * mocks. Both providers dispatch to the same connector double, which is what
   * makes `describe.each` above one shared contract rather than two suites.
   */
  function linkingDeps() {
    const connector = {
      create: createRemote,
      read: readRemote,
      updateStatus: updateRemoteStatus,
      updateContent: updateRemoteContent,
      delete: deleteRemote,
    };
    return {
      tasks,
      settings: () => settings,
      save: (next: GoogleTasksDestinationSettings) => {
        settings = next;
      },
      listRemoteLists: async () => [{ id: "list_work", title: "Work" }],
      asana: connector,
      google: connector,
    };
  }

  /** One provider projection, in the four fields a linked record has. */
  function snapshot(title: string, status: Task["status"] = "open", overrides = {}) {
    return { title, notes: "", dueDate: null, status, ...overrides };
  }

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "cos-task-sync-"));
    const store = new TaskStore(workspaceDir);
    settings = { enabled: false, taskListId: "", taskListTitle: "" };
    createRemote = vi.fn(async () => ({ remoteId: "google_1", url: "https://tasks.google.com/1" }));
    /* Google agreeing with what the Workspace last sent it, which is the
     ordinary case: the tests that want a drift or an outside completion say
     so with a mockResolvedValueOnce of their own. */
    readRemote = vi.fn(async (_destination, remoteId) => {
      const linked = tasks
        .list({})
        .concat(tasks.list({ trashed: true }))
        .find((task) => task.externalLink?.remoteId === remoteId);
      return linked?.externalLink?.baseline ?? snapshot("");
    });
    updateRemoteStatus = vi.fn(async () => {});
    updateRemoteContent = vi.fn(async () => {});
    deleteRemote = vi.fn(async () => {});
    tasks = new WorkspaceTasks({
      store,
      now: () => new Date("2026-09-04T09:00:00.000Z"),
      isGoogleTasksEnabled: () => settings.enabled,
      isAsanaEnabled: () => true,
    });
    app = fastify();
    registerTasksApi(app, {
      tasks,
      actionItems: new WorkspaceActionItems({ store }),
      linking: new TaskLinking(linkingDeps()),
    });
    return app.ready();
  });

  afterEach(async () => {
    /* Restored here rather than only where they are installed: a test that
       installs fake timers and then hangs never reaches its own cleanup, and
       the leaked clock times out every sibling after it. */
    vi.useRealTimers();
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
        destination: G_LIST,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<Task>();
  }

  async function link(taskId: string): Promise<Task> {
    const response = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/link` });
    expect(response.statusCode).toBe(200);
    return response.json<Task>();
  }

  describe("pushing local completion outward", () => {
    it("requires a linked Trash choice and keeps failed external deletion retryable in Trash", async () => {
      await enable();
      const task = await captureToGoogle("Delete deliberately");
      await link(task.id);
      const refused = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/trash` });
      expect(refused.statusCode).toBe(428);
      deleteRemote.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: 503 }));
      const trashed = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/trash`,
        payload: { external: "delete" },
      });
      expect(trashed.json<Task>().deletedAt).not.toBeNull();
      expect(trashed.json<Task>().externalLink).toMatchObject({
        state: "failed",
        remoteId: "google_1",
      });
      const retried = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(retried.json<Task>().externalLink).toBeNull();
      expect(deleteRemote).toHaveBeenCalledTimes(2);
      expect(createRemote).toHaveBeenCalledTimes(1);
    });
    it("pushes edited content after the local commit and retries a failed content write", async () => {
      await enable();
      const task = await captureToGoogle("Original title");
      await link(task.id);
      updateRemoteContent.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: 503 }));
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: { title: "Accepted revision" },
      });
      expect(edited.json<Task>()).toMatchObject({
        title: "Accepted revision",
        externalLink: { state: "failed", baseline: { title: "Original title" } },
      });
      const retried = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(retried.json<Task>().externalLink).toMatchObject({
        state: "synchronized",
        baseline: { title: "Accepted revision" },
      });
      expect(createRemote).toHaveBeenCalledTimes(1);
    });
    it("refresh pauses authorization failures while retry-all isolates transient failures", async () => {
      await enable();
      const auth = await captureToGoogle("Reconnect first");
      await link(auth.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("unauthorized"), { code: 401 }),
      );
      await app.inject({ method: "POST", url: `/api/tasks/${auth.id}/complete` });
      const transient = await captureToGoogle("Retry later");
      createRemote.mockResolvedValueOnce({ remoteId: "google_2", url: null });
      await link(transient.id);
      updateRemoteStatus.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: 503 }));
      await app.inject({ method: "POST", url: `/api/tasks/${transient.id}/complete` });
      readRemote.mockClear();

      const refresh = await app.inject({ method: "POST", url: "/api/tasks/refresh" });
      expect(refresh.statusCode).toBe(200);
      expect(readRemote.mock.calls.map((call) => call[1])).toEqual(["google_2"]);
      const result = await app.inject({ method: "GET", url: `/api/tasks/${transient.id}` });
      expect(result.json<Task>().externalLink).toMatchObject({ state: "synchronized" });

      readRemote.mockClear();
      const retried = await app.inject({ method: "POST", url: "/api/tasks/retry-failed" });
      expect(retried.statusCode).toBe(200);
      expect(readRemote.mock.calls.map((call) => call[1])).toEqual(["google_1"]);
    });
    it("resumes authorization-paused links on the next automatic refresh after reconnection", async () => {
      await enable();
      const task = await captureToGoogle("Resume me");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("unauthorized"), { code: 401 }),
      );
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      let revision = "original";
      const runtime = new TaskLinking({ ...linkingDeps(), authorizationRevision: () => revision });
      // Establish the current credential while the provider still rejects it.
      readRemote.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { code: 401 }));
      await runtime.refresh({ manual: true });
      readRemote.mockClear();
      await runtime.refresh();
      expect(readRemote).not.toHaveBeenCalled();
      const restarted = new TaskLinking({
        ...linkingDeps(),
        authorizationRevision: () => revision,
      });
      await restarted.refresh();
      expect(readRemote).not.toHaveBeenCalled();
      revision = "reconnected";
      await runtime.refresh();
      expect(tasks.get(task.id)?.externalLink?.state).toBe("synchronized");
      expect(createRemote).toHaveBeenCalledTimes(1);
    });

    it.each(["open", "completed"] as const)(
      "recovers uncertain %s creation after restart without duplicating or losing local completion",
      async (status) => {
        await enable();
        const task = await captureToGoogle("Lost create response");
        if (status === "completed") tasks.complete(task.id);
        createRemote.mockRejectedValueOnce(new Error("response lost after remote commit"));
        await link(task.id);
        const restarted = new TaskLinking(linkingDeps());
        await restarted.retry(task.id);
        await restarted.refresh({ manual: true });
        expect(createRemote).toHaveBeenCalledTimes(1);
        expect(tasks.get(task.id)?.externalLink?.creationUncertain).toBe(true);
        readRemote.mockResolvedValue(snapshot("Lost create response"));
        await restarted.recoverCreation(task.id, "remote-that-already-exists");
        expect(tasks.get(task.id)?.status).toBe(status);
        if (status === "completed")
          expect(updateRemoteStatus).toHaveBeenCalledWith(
            expect.anything(),
            "remote-that-already-exists",
            true,
          );
        expect(tasks.get(task.id)?.externalLink).toMatchObject({
          remoteId: "remote-that-already-exists",
          state: "synchronized",
          creationUncertain: false,
        });
        expect(createRemote).toHaveBeenCalledTimes(1);
      },
    );

    it("retries a failed status write against the existing remote record", async () => {
      await enable();
      const task = await captureToGoogle("Retry accepted work");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: 503 }));
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });

      const retried = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(retried.statusCode).toBe(200);
      expect(retried.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: {
          state: "synchronized",
          remoteId: "google_1",
          baseline: { status: "completed" },
        },
      });
      expect(createRemote).toHaveBeenCalledTimes(1);
    });
    it("pushes a local completion to the linked Google Task", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);

      const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      expect(completed.statusCode).toBe(200);
      expect(updateRemoteStatus).toHaveBeenCalledWith(G_LIST, "google_1", true);
      expect(completed.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "synchronized", baseline: { status: "completed" } },
      });
    });

    it("pushes a local reopening to the linked Google Task", async () => {
      await enable();
      const task = await captureToGoogle("Book the room");
      await link(task.id);
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      updateRemoteStatus.mockClear();

      const reopened = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });
      expect(reopened.statusCode).toBe(200);
      expect(updateRemoteStatus).toHaveBeenCalledWith(G_LIST, "google_1", false);
      expect(reopened.json<Task>()).toMatchObject({
        status: "open",
        externalLink: { state: "synchronized", baseline: { status: "open" } },
      });
    });

    it("repeats a completion without a second provider call", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);

      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      expect(updateRemoteStatus).toHaveBeenCalledTimes(1);

      const repeated = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      expect(repeated.statusCode).toBe(200);
      expect(updateRemoteStatus).toHaveBeenCalledTimes(1);
      expect(repeated.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "synchronized", baseline: { status: "completed" } },
      });
    });
  });

  describe("applying an unopposed external completion", () => {
    it("updates the canonical Task when only Google completed", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      readRemote.mockResolvedValueOnce(snapshot("Send the pricing sheet", "completed"));

      const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(synced.statusCode).toBe(200);
      expect(synced.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "synchronized", baseline: { status: "completed" } },
      });
      /* Nothing to push: Google already holds the completion. */
      expect(updateRemoteStatus).not.toHaveBeenCalled();
    });

    it("applies an unopposed external reopening locally", async () => {
      await enable();
      const task = await captureToGoogle("Book the room");
      await link(task.id);
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      readRemote.mockResolvedValueOnce(snapshot("Book the room", "open"));

      const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(synced.statusCode).toBe(200);
      expect(synced.json<Task>()).toMatchObject({
        status: "open",
        completedAt: null,
        externalLink: { state: "synchronized", baseline: { status: "open" } },
      });
      expect(updateRemoteStatus).toHaveBeenCalledTimes(1);
    });

    it("leaves an agreeing Task untouched, including its timestamps", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      const linked = await link(task.id);

      const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(synced.statusCode).toBe(200);
      expect(synced.json<Task>().updatedAt).toBe(linked.updatedAt);
      expect(updateRemoteStatus).not.toHaveBeenCalled();
    });
  });

  describe("a Google Task that went missing", () => {
    it("leaves the local Task intact and marks the link missing", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      readRemote.mockResolvedValueOnce(null);

      const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(synced.statusCode).toBe(200);
      expect(synced.json<Task>()).toMatchObject({
        title: "Send the pricing sheet",
        status: "open",
        externalLink: { state: "missing", remoteId: "google_1" },
      });
    });

    it("marks the link missing when a push finds the record gone", async () => {
      await enable();
      const task = await captureToGoogle("Book the room");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("Not Found"), { code: 404 }),
      );

      const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      expect(completed.statusCode).toBe(200);
      expect(completed.json<Task>()).toMatchObject({
        title: "Book the room",
        status: "completed",
        externalLink: { state: "missing", remoteId: "google_1" },
      });
    });

    it("recreates the remote record and stores its replacement identity", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      readRemote.mockResolvedValue(null);
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      createRemote.mockResolvedValueOnce({
        remoteId: "google_2",
        url: "https://tasks.google.com/2",
      });

      const recreated = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/recreate` });
      expect(recreated.statusCode).toBe(200);
      expect(recreated.json<Task>()).toMatchObject({
        title: "Send the pricing sheet",
        status: "open",
        externalLink: {
          state: "synchronized",
          remoteId: "google_2",
          url: "https://tasks.google.com/2",
          baseline: { title: "Send the pricing sheet", status: "open" },
        },
      });
    });

    it("does not duplicate a recreated remote record after losing its acknowledgement", async () => {
      await enable();
      const task = await captureToGoogle("Replacement recovery");
      await link(task.id);
      readRemote.mockResolvedValueOnce(null);
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      createRemote.mockRejectedValueOnce(
        new Error("Response lost after provider accepted replacement"),
      );
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/recreate` });
      const restarted = new TaskLinking(linkingDeps());
      await restarted.retry(task.id);
      expect(createRemote).toHaveBeenCalledTimes(2);
      expect(tasks.get(task.id)?.externalLink?.creationUncertain).toBe(true);
    });

    it("removes the link while preserving the local Task", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      readRemote.mockResolvedValueOnce(null);
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });

      const removed = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/link` });
      expect(removed.statusCode).toBe(200);
      expect(removed.json<Task>()).toMatchObject({
        title: "Send the pricing sheet",
        status: "open",
        externalLink: null,
      });
    });
  });

  describe("classified provider failures", () => {
    it("records an authentication failure without failing the local Task", async () => {
      await enable();
      const task = await captureToGoogle("Book the room");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("Request had invalid authentication credentials"), { code: 401 }),
      );

      const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      expect(completed.statusCode).toBe(200);
      expect(completed.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: {
          state: "failed",
          remoteId: "google_1",
          failure: {
            kind: "authorization",
            message: `${providerLabel} refused the saved credential. Reconnect ${providerLabel}.`,
          },
        },
      });
    });

    it("names rate-limit and validation failures in fixed sentences", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("quotaExceeded"), { code: 429 }),
      );

      const first = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      expect(first.json<Task>().externalLink).toMatchObject({
        state: "failed",
        failure: {
          kind: "rate-limit",
          message: `${providerLabel} is rate-limited. Retry shortly.`,
        },
      });
    });
    it("reads Google's 403 quota exhaustion as a rate limit, not a sign-in problem", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("rateLimitExceeded"), { code: 403 }),
      );

      const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      expect(completed.json<Task>().externalLink).toMatchObject({
        state: "failed",
        failure: {
          kind: "rate-limit",
          message: `${providerLabel} is rate-limited. Retry shortly.`,
        },
      });
    });

    it("redacts credential-shaped detail from an unclassified failure", async () => {
      await enable();
      const task = await captureToGoogle("Book the room");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(
        new Error("transport failed with Bearer ya29.secret-token-value"),
      );

      const completed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      const failure = completed.json<Task>().externalLink?.failure;
      expect(failure?.kind).toBe("unavailable");
      expect(failure?.message ?? "").not.toContain("ya29.secret-token-value");
      expect(completed.json<Task>().externalLink).toMatchObject({ state: "failed" });
    });
  });

  describe("completed Tasks stay completed", () => {
    it("completes the remote record when a completed Task is linked", async () => {
      await enable();
      const task = await captureToGoogle("Already done");
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      updateRemoteStatus.mockClear();

      const linked = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
      expect(linked.statusCode).toBe(200);
      expect(updateRemoteStatus).toHaveBeenCalledWith(G_LIST, "google_1", true);
      expect(linked.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "synchronized", baseline: { status: "completed" } },
      });

      /* And the next read agrees, writing nothing: the fake Google now holds
       the completion the linking just sent, so the read converges for free. */
      readRemote.mockResolvedValueOnce(snapshot("Already done", "completed"));
      const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(synced.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "synchronized", baseline: { status: "completed" } },
      });
    });

    it("completes the replacement record when a completed Task is recreated", async () => {
      await enable();
      const task = await captureToGoogle("Done while missing");
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      await link(task.id);
      /* Google loses the record; the sync discovers it and marks the link
       missing with the Task still completed. */
      readRemote.mockResolvedValueOnce(null);
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      createRemote.mockResolvedValueOnce({
        remoteId: "google_2",
        url: "https://tasks.google.com/2",
      });

      const recreated = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/recreate` });
      expect(recreated.statusCode).toBe(200);
      expect(updateRemoteStatus).toHaveBeenLastCalledWith(G_LIST, "google_2", true);
      expect(recreated.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: {
          state: "synchronized",
          remoteId: "google_2",
          baseline: { status: "completed" },
        },
      });
    });

    it("never reverts a completed Task whose outward write failed", async () => {
      await enable();
      const task = await captureToGoogle("Push failed");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("backend error"), { code: 500 }),
      );
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });

      /* The read finds Google still open while the Task is completed and the
       baseline is open: only the Workspace moved, so applying Google would
       revert accepted work. The read refuses, and the Task stays completed. */
      readRemote.mockResolvedValueOnce(snapshot("Push failed", "open"));
      const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(synced.statusCode).toBe(200);
      expect(synced.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "failed", remoteId: "google_1" },
      });

      /* Repeating the status write retries the interrupted push. */
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      const converged = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(converged.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "synchronized", baseline: { status: "completed" } },
      });
    });

    it("refuses a second link once a record exists, even after a failed push", async () => {
      await enable();
      const task = await captureToGoogle("One record only");
      await link(task.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("backend error"), { code: 500 }),
      );
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });

      const second = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
      expect(second.statusCode).toBe(409);
      expect(second.json<{ error: string }>().error).toBe("task-already-linked");
      expect(createRemote).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * External Task Drift and Task Link Conflict (issue #186). Three readings
   * meet at a link — the Task, the baseline, and the provider — and the whole
   * point of these states is that when both sides moved, the app refuses to
   * pick a winner.
   */
  describe("content changed outside the Workspace", () => {
    async function drifted(): Promise<Task> {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      readRemote.mockResolvedValueOnce(snapshot("Send the pricing deck", "open"));
      const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(synced.statusCode).toBe(200);
      return synced.json<Task>();
    }

    it("never overwrites canonical content, and keeps both projections", async () => {
      const task = await drifted();

      /* The Task still says what the Workspace means. The link says what the
       Workspace sent and what Google holds now — three readings, one of
       which is the owner's to choose. */
      expect(task.title).toBe("Send the pricing sheet");
      expect(task.externalLink).toMatchObject({
        state: "changed-externally",
        baseline: { title: "Send the pricing sheet" },
        external: { title: "Send the pricing deck" },
      });
    });

    it("reads nothing further while the owner is comparing", async () => {
      const task = await drifted();
      readRemote.mockClear();

      const again = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(again.json<Task>().externalLink).toMatchObject({ state: "changed-externally" });
      expect(readRemote).not.toHaveBeenCalled();
    });

    it("keeps a drift decision standing when local content is edited", async () => {
      const task = await drifted();
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: { title: "My revised plan" },
      });
      expect(edited.json<Task>()).toMatchObject({
        title: "My revised plan",
        externalLink: { state: "changed-externally", external: { title: "Send the pricing deck" } },
      });
      expect(updateRemoteContent).not.toHaveBeenCalled();
    });

    it("restores the app version by pushing canonical content", async () => {
      const task = await drifted();

      const resolved = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/drift`,
        payload: { keep: "app" },
      });
      expect(resolved.statusCode).toBe(200);
      expect(updateRemoteContent).toHaveBeenCalledWith(G_LIST, "google_1", {
        title: "Send the pricing sheet",
        notes: "",
        dueDate: null,
      });
      expect(resolved.json<Task>()).toMatchObject({
        title: "Send the pricing sheet",
        externalLink: { state: "synchronized", external: null },
      });
    });

    it("leaves the drift standing when restoring the app version fails", async () => {
      const task = await drifted();
      updateRemoteContent.mockRejectedValueOnce(
        Object.assign(new Error("backend error"), { code: 500 }),
      );

      const resolved = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/drift`,
        payload: { keep: "app" },
      });
      expect(resolved.json<Task>().externalLink).toMatchObject({
        state: "changed-externally",
        external: { title: "Send the pricing deck" },
        failure: { kind: "network" },
      });
    });

    it("accepts the external values as canonical when the owner says so", async () => {
      const task = await drifted();

      const resolved = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/drift`,
        payload: { keep: "external" },
      });
      expect(resolved.statusCode).toBe(200);
      /* No outward call: Google already holds these values. */
      expect(updateRemoteContent).not.toHaveBeenCalled();
      expect(resolved.json<Task>()).toMatchObject({
        title: "Send the pricing deck",
        externalLink: {
          state: "synchronized",
          baseline: { title: "Send the pricing deck" },
          external: null,
        },
      });
    });

    it("removes the link and preserves both records", async () => {
      const task = await drifted();

      const removed = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/link` });
      expect(removed.statusCode).toBe(200);
      expect(removed.json<Task>()).toMatchObject({
        title: "Send the pricing sheet",
        externalLink: null,
      });
    });

    it("refuses a drift resolution on a link that has not drifted", async () => {
      await enable();
      const task = await captureToGoogle("Nothing drifted");
      await link(task.id);

      const refused = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/drift`,
        payload: { keep: "app" },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ error: string }>().error).toBe("link-not-drifted");
    });
  });

  describe("both sides changed completion", () => {
    async function conflicted(): Promise<Task> {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      /* The Workspace completes, and the outward write never lands — so the
       baseline still says open while the Task says completed. */
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("backend error"), { code: 500 }),
      );
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
      /* Meanwhile somebody completed it in Google too — no, reopened it: the
       provider moved away from the baseline on its own. */
      readRemote.mockResolvedValueOnce(snapshot("Send the pricing sheet", "completed"));
      const synced = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync` });
      expect(synced.statusCode).toBe(200);
      return synced.json<Task>();
    }

    it("enters the conflicted state without either side winning", async () => {
      const task = await conflicted();

      expect(task).toMatchObject({
        status: "completed",
        externalLink: { state: "conflicted", external: { status: "completed" } },
      });
    });

    it("resolves to the app status only after the provider write succeeds", async () => {
      const task = await conflicted();
      updateRemoteStatus.mockClear();
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("backend error"), { code: 500 }),
      );

      const failed = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/conflict`,
        payload: { keep: "app" },
      });
      expect(failed.json<Task>().externalLink).toMatchObject({ state: "conflicted" });

      const resolved = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/conflict`,
        payload: { keep: "app" },
      });
      expect(updateRemoteStatus).toHaveBeenLastCalledWith(G_LIST, "google_1", true);
      expect(resolved.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "synchronized", baseline: { status: "completed" }, external: null },
      });
    });

    it("resolves to the external status by applying it locally", async () => {
      const task = await conflicted();
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/reopen` });

      const resolved = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/conflict`,
        payload: { keep: "external" },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json<Task>()).toMatchObject({
        status: "completed",
        externalLink: { state: "synchronized", baseline: { status: "completed" }, external: null },
      });
    });

    it("refuses a request that names neither side", async () => {
      const task = await conflicted();

      const refused = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/conflict`,
        payload: {},
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ error: string }>().error).toBe("invalid-resolution");
    });
  });

  describe("triggers other than the Refresh button", () => {
    it("runs the same idempotent path at startup and on the five-minute tick", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);
      vi.useFakeTimers();
      const runtime = new TaskLinking(linkingDeps());
      readRemote.mockClear();
      createRemote.mockClear();

      /* Startup: the same reconciliation the Refresh button asks for. */
      runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(readRemote.mock.calls.map((call) => call[1])).toEqual(["google_1"]);

      /* And again on the tick, five minutes later. */
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(readRemote.mock.calls.map((call) => call[1])).toEqual(["google_1", "google_1"]);

      /* Idempotent throughout: no second remote record, no rewrites of an
         agreeing one. */
      expect(createRemote).not.toHaveBeenCalled();
      expect(updateRemoteContent).not.toHaveBeenCalled();
      runtime.stop();
      expect(tasks.get(task.id)?.externalLink).toMatchObject({ state: "synchronized" });
    });

    it("leaves missing, conflicted and changed-externally links alone when retrying all failures", async () => {
      await enable();

      const missing = await captureToGoogle("Gone from the provider");
      await link(missing.id);
      readRemote.mockResolvedValueOnce(null);
      await app.inject({ method: "POST", url: `/api/tasks/${missing.id}/sync` });

      const drifted = await captureToGoogle("Changed outside");
      createRemote.mockResolvedValueOnce({ remoteId: "google_2", url: null });
      await link(drifted.id);
      readRemote.mockResolvedValueOnce(snapshot("Changed outside, elsewhere", "open"));
      await app.inject({ method: "POST", url: `/api/tasks/${drifted.id}/sync` });

      const conflicted = await captureToGoogle("Both sides moved");
      createRemote.mockResolvedValueOnce({ remoteId: "google_3", url: null });
      await link(conflicted.id);
      updateRemoteStatus.mockRejectedValueOnce(
        Object.assign(new Error("backend error"), { code: 500 }),
      );
      await app.inject({ method: "POST", url: `/api/tasks/${conflicted.id}/complete` });
      readRemote.mockResolvedValueOnce(snapshot("Both sides moved", "completed"));
      await app.inject({ method: "POST", url: `/api/tasks/${conflicted.id}/sync` });

      const failed = await captureToGoogle("Transient failure");
      createRemote.mockResolvedValueOnce({ remoteId: "google_4", url: null });
      await link(failed.id);
      updateRemoteStatus.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: 503 }));
      await app.inject({ method: "POST", url: `/api/tasks/${failed.id}/complete` });

      const before = await Promise.all(
        [missing, drifted, conflicted].map(async (task) =>
          (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json<Task>(),
        ),
      );
      expect(before.map((task) => task.externalLink?.state)).toEqual([
        "missing",
        "changed-externally",
        "conflicted",
      ]);
      readRemote.mockClear();
      updateRemoteStatus.mockClear();

      const retried = await app.inject({ method: "POST", url: "/api/tasks/retry-failed" });
      expect(retried.statusCode).toBe(200);

      /* Only the failed link is touched at all. */
      expect(readRemote.mock.calls.map((call) => call[1])).toEqual(["google_4"]);
      expect(updateRemoteStatus.mock.calls.map((call) => call[1])).toEqual(["google_4"]);
      const after = await Promise.all(
        [missing, drifted, conflicted].map(async (task) =>
          (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json<Task>(),
        ),
      );
      /* The three owner decisions still stand, unresolved and unchanged. */
      expect(after.map((task) => task.externalLink)).toEqual(
        before.map((task) => task.externalLink),
      );
      expect(
        (await app.inject({ method: "GET", url: `/api/tasks/${failed.id}` })).json<Task>()
          .externalLink,
      ).toMatchObject({ state: "synchronized" });
    });
  });

  describe("the synchronization baseline", () => {
    it("survives a restart, because it lives on the Task the Workspace stored", async () => {
      await enable();
      const task = await captureToGoogle("Send the pricing sheet");
      await link(task.id);

      /* A second Workspace over the same directory — the shape a restart has.
       The baseline it reads is what drift is measured against. */
      const reopened = new WorkspaceTasks({
        store: new TaskStore(workspaceDir),
        now: () => new Date("2026-09-05T09:00:00.000Z"),
        isGoogleTasksEnabled: () => true,
      });
      expect(reopened.get(task.id)?.externalLink?.baseline).toEqual({
        title: "Send the pricing sheet",
        notes: "",
        dueDate: null,
        status: "open",
      });
    });
  });
});

/**
 * Cross-provider isolation (issue #190). The parameterized suite above proves
 * the shared contract one provider at a time; this one enables Google Tasks
 * and Asana together, because "one failing link never blocks another Task **or
 * provider**" is only provable while both are live at once.
 */
describe("Google Tasks and Asana enabled together", () => {
  const GOOGLE = {
    provider: "google-tasks",
    googleTaskListId: "list_work",
    googleTaskListTitle: "Work",
  } as const;
  const ASANA = {
    provider: "asana",
    workspaceGid: "workspace",
    workspaceName: "Workspace",
    projectGid: "project",
    projectName: "Project",
    sectionGid: null,
    sectionName: null,
  } as const;

  let app: FastifyInstance;
  let tasks: WorkspaceTasks;
  let google: {
    [K in keyof Omit<RemoteTaskConnector, "resolveDestination">]: Mock<RemoteTaskConnector[K]>;
  };
  let asana: {
    [K in keyof Omit<RemoteTaskConnector, "resolveDestination">]: Mock<RemoteTaskConnector[K]>;
  };

  /** A connector double that answers with whatever the Workspace last sent it. */
  function connector(prefix: string) {
    let issued = 0;
    return {
      create: vi.fn(async () => ({ remoteId: `${prefix}_${++issued}`, url: null })),
      read: vi.fn(async (_destination, remoteId: string) => {
        const linked = tasks.list({}).find((task) => task.externalLink?.remoteId === remoteId);
        return linked?.externalLink?.baseline ?? null;
      }),
      updateStatus: vi.fn(async () => {}),
      updateContent: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
  }

  beforeEach(async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-task-sync-both-"));
    const store = new TaskStore(workspaceDir);
    let settings: GoogleTasksDestinationSettings = {
      enabled: true,
      taskListId: "list_work",
      taskListTitle: "Work",
    };
    google = connector("google");
    asana = connector("asana");
    tasks = new WorkspaceTasks({
      store,
      now: () => new Date("2026-09-04T09:00:00.000Z"),
      isGoogleTasksEnabled: () => settings.enabled,
      isAsanaEnabled: () => true,
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
        listRemoteLists: async () => [{ id: "list_work", title: "Work" }],
        google,
        asana,
      }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function capture(title: string, destination: object): Promise<Task> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title, destination },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json<Task>();
    const linked = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
    expect(linked.statusCode).toBe(200);
    return linked.json<Task>();
  }

  it("never lets a failing Google link block an Asana Task, or the reverse", async () => {
    const googleTask = await capture("Send the pricing sheet", GOOGLE);
    const asanaTask = await capture("Book the room", ASANA);
    expect(googleTask.externalLink?.remoteId).toBe("google_1");
    expect(asanaTask.externalLink?.remoteId).toBe("asana_1");

    /* Google refuses the saved credential — the failure that pauses automatic
       retry for its own links and must not reach Asana's. */
    google.updateStatus.mockRejectedValueOnce(
      Object.assign(new Error("unauthorized"), { code: 401 }),
    );
    await app.inject({ method: "POST", url: `/api/tasks/${googleTask.id}/complete` });
    expect(
      (await app.inject({ method: "GET", url: `/api/tasks/${googleTask.id}` })).json<Task>()
        .externalLink,
    ).toMatchObject({ state: "failed", failure: { kind: "authorization" } });

    /* Asana carries on, in the same refresh, over the same shared path. */
    const refreshed = await app.inject({ method: "POST", url: "/api/tasks/refresh" });
    expect(refreshed.statusCode).toBe(200);
    expect(asana.read).toHaveBeenCalledWith(ASANA, "asana_1");
    expect(
      (await app.inject({ method: "GET", url: `/api/tasks/${asanaTask.id}` })).json<Task>()
        .externalLink,
    ).toMatchObject({ state: "synchronized" });

    /* And a completion on the Asana Task still reaches Asana. */
    const completed = await app.inject({
      method: "POST",
      url: `/api/tasks/${asanaTask.id}/complete`,
    });
    expect(completed.json<Task>()).toMatchObject({
      status: "completed",
      externalLink: { state: "synchronized" },
    });
    expect(asana.updateStatus).toHaveBeenCalledWith(ASANA, "asana_1", true);

    /* Neither provider was ever handed the other's record. */
    expect(google.read.mock.calls.every((call) => call[1].startsWith("google_"))).toBe(true);
    expect(asana.read.mock.calls.every((call) => call[1].startsWith("asana_"))).toBe(true);
    expect(google.updateStatus.mock.calls.every((call) => call[1].startsWith("google_"))).toBe(
      true,
    );
  });

  it("keeps one provider's outage off the other's Tasks during a whole-Workspace refresh", async () => {
    const googleTask = await capture("Send the pricing sheet", GOOGLE);
    const asanaTask = await capture("Book the room", ASANA);
    google.read.mockRejectedValue(Object.assign(new Error("offline"), { code: 503 }));

    const refreshed = await app.inject({ method: "POST", url: "/api/tasks/refresh" });

    expect(refreshed.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/api/tasks/${googleTask.id}` })).json<Task>()
        .externalLink,
    ).toMatchObject({ state: "failed", failure: { kind: "network" } });
    expect(
      (await app.inject({ method: "GET", url: `/api/tasks/${asanaTask.id}` })).json<Task>()
        .externalLink,
    ).toMatchObject({ state: "synchronized" });
    /* And the Tasks themselves are untouched by either. */
    expect(tasks.get(googleTask.id)?.title).toBe("Send the pricing sheet");
    expect(tasks.get(asanaTask.id)?.title).toBe("Book the room");
  });
});
