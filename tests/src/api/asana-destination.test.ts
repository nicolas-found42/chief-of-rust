import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { ConfigSchema, type Task } from "@chief-of-staff-demo/shared";
import { redactConfig } from "../../../apps/server/src/config";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { registerTasksApi } from "../../../apps/server/src/api/tasks";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import {
  TaskLinking,
  type AsanaDestination,
  type GoogleTasksDestinationSettings,
  type RemoteTaskConnector,
} from "../../../apps/server/src/tasks/external-link";
import {
  AsanaLinking,
  type AsanaDestinationSettings,
} from "../../../apps/server/src/tasks/asana-link";

/**
 * Asana as a Task Destination, at the assembled API seam (issue #189).
 *
 * The Asana client and the Google client are doubles here on purpose: what is
 * under test is that the token is verified before it is stored and never
 * comes back out, that a destination is validated against the account before
 * it is enabled, and that the shared link state machine commits locally first
 * and treats an Asana failure as link state on a perfectly good Task.
 */

/** The Asana user record a working token produces. */
interface FakeMe {
  gid: string;
  name: string;
  email: string | null;
  workspaces: { gid: string; name: string }[];
}

/** The destination the fake Task carries, as the connector receives it. */
const ASANA_DESTINATION: AsanaDestination = {
  provider: "asana",
  workspaceGid: "501",
  workspaceName: "Personal",
  projectGid: "p1",
  projectName: "Blog",
  sectionGid: null,
  sectionName: null,
};

let app: FastifyInstance;
let settings: AsanaDestinationSettings;
let googleSettings: GoogleTasksDestinationSettings;
let me: Mock<(token: string) => Promise<FakeMe>>;
let projects: Mock<
  (token: string, workspaceGid: string) => Promise<{ gid: string; name: string }[]>
>;
let sections: Mock<(token: string, projectGid: string) => Promise<{ gid: string; name: string }[]>>;
let createRemote: Mock<RemoteTaskConnector<AsanaDestination>["create"]>;
let readRemote: Mock<RemoteTaskConnector<AsanaDestination>["read"]>;
let updateRemote: Mock<RemoteTaskConnector<AsanaDestination>["updateStatus"]>;

function fakeMe(): FakeMe {
  return {
    gid: "1201",
    name: "Nicolas",
    email: "nicolas@example.com",
    workspaces: [
      { gid: "501", name: "Personal" },
      { gid: "502", name: "Acme" },
    ],
  };
}

function asanaSettings(): AsanaDestinationSettings {
  return {
    token: "",
    lastVerifiedAt: null,
    enabled: false,
    workspaceGid: "",
    workspaceName: "",
    projectGid: "",
    projectName: "",
    sectionGid: null,
    sectionName: null,
  };
}

beforeEach(() => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-asana-destination-"));
  const store = new TaskStore(workspaceDir);
  settings = asanaSettings();
  googleSettings = { enabled: false, taskListId: "", taskListTitle: "" };
  me = vi.fn(async () => fakeMe());
  projects = vi.fn(async () => [
    { gid: "p1", name: "Blog" },
    { gid: "p2", name: "Ops" },
  ]);
  sections = vi.fn(async () => [{ gid: "s1", name: "Doing" }]);
  createRemote = vi.fn(async () => ({ remoteId: "asana_1", url: "https://app.asana.com/0/1/1" }));
  readRemote = vi.fn(async () => ({
    title: "",
    notes: "",
    dueDate: null,
    status: "open" as const,
  }));
  updateRemote = vi.fn(async () => {});
  const tasks = new WorkspaceTasks({
    store,
    now: () => new Date("2026-09-04T09:00:00.000Z"),
    isGoogleTasksEnabled: () => googleSettings.enabled,
    isAsanaEnabled: () => settings.enabled,
  });
  app = fastify();
  registerTasksApi(app, {
    tasks,
    actionItems: new WorkspaceActionItems({ store }),
    linking: new TaskLinking({
      tasks,
      settings: () => googleSettings,
      save: (next) => {
        googleSettings = next;
      },
      listRemoteLists: async () => [],
      google: {
        create: async () => ({ remoteId: "google_1", url: null }),
        read: async () => ({ title: "", notes: "", dueDate: null, status: "open" as const }),
        updateContent: async () => {},
        delete: async () => {},
        updateStatus: async () => {},
      },
      asana: {
        create: createRemote,
        read: readRemote,
        updateStatus: updateRemote,
        updateContent: async () => {},
        delete: async () => {},
      },
    }),
    asana: new AsanaLinking({
      settings: () => settings,
      save: (next) => {
        settings = next;
      },
      me: (token) => me(token),
      projects: (token, workspaceGid) => projects(token, workspaceGid),
      sections: (token, projectGid) => sections(token, projectGid),
    }),
  });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

async function connect(): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/tasks/asana/connect",
    payload: { token: "valid-token" },
  });
  expect(response.statusCode).toBe(200);
}

async function enableDestination(): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: "/api/tasks/asana-destination",
    payload: { enabled: true, workspaceGid: "501", projectGid: "p1" },
  });
  expect(response.statusCode).toBe(200);
}

async function captureToAsana(title: string): Promise<Task> {
  const response = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: { title, destination: ASANA_DESTINATION },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Task>();
}

/** The outward write is its own step over a Task that already exists. */
async function link(task: Task): Promise<Task> {
  const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/link` });
  expect(response.statusCode).toBe(200);
  return response.json<Task>();
}

describe("storing and redacting the personal access token", () => {
  it("verifies the token against Asana before storing it, and answers with a hint only", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/asana/connect",
      payload: { token: "valid-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { gid: "1201", name: "Nicolas" },
      workspaces: [
        { gid: "501", name: "Personal" },
        { gid: "502", name: "Acme" },
      ],
      tokenHint: "…oken",
    });
    expect(settings.token).toBe("valid-token");
    expect(settings.lastVerifiedAt).toBeTypeOf("string");
  });

  it("never returns the full token from any destination read", async () => {
    await connect();
    const response = await app.inject({ method: "GET", url: "/api/tasks/asana-destination" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.connected).toBe(true);
    expect(body.tokenHint).toBe("…oken");
    expect(JSON.stringify(body)).not.toContain("valid-token");
  });

  it("redacts the token from the config surface", () => {
    /* The guarantee the /api/config route is built on: redactConfig rebuilds
       the answer field by field and has no tasks section, so no client read
       can carry the stored token. */
    const config = ConfigSchema.parse({
      provider: "mock",
      model: "mock-model",
      apiKey: "test-key",
      google: { clientId: "", clientSecret: "", refreshToken: null },
      notion: { token: "valid-token" },
      drive: {},
      ollama: {},
      tasks: {
        googleTasks: { enabled: false, taskListId: "", taskListTitle: "" },
        asana: {
          token: "valid-token",
          lastVerifiedAt: null,
          enabled: false,
          workspaceGid: "",
          workspaceName: "",
          projectGid: "",
          projectName: "",
          sectionGid: null,
          sectionName: null,
        },
      },
    });
    const redacted = redactConfig(config);
    expect(JSON.stringify(redacted)).not.toContain("valid-token");
    expect(redacted).not.toHaveProperty("tasks");
  });

  it("lets an owner clear a stored section by selecting none", async () => {
    await connect();
    await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: true, workspaceGid: "501", projectGid: "p1", sectionGid: "s1" },
    });
    expect(settings).toMatchObject({ enabled: true, sectionGid: "s1" });

    const cleared = await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: true, workspaceGid: "501", projectGid: "p1", sectionGid: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(settings).toMatchObject({ enabled: true, sectionGid: null, sectionName: null });
  });

  it("lets the owner switch projects after a section was chosen", async () => {
    await connect();
    await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: true, workspaceGid: "501", projectGid: "p1", sectionGid: "s1" },
    });
    /* The project switch clears the section client-side and sends an explicit
       "no section"; the stale s1 must not be validated against the new p2. */
    const switched = await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: true, workspaceGid: "501", projectGid: "p2", sectionGid: null },
    });
    expect(switched.statusCode).toBe(200);
    expect(settings).toMatchObject({
      enabled: true,
      projectGid: "p2",
      projectName: "Ops",
      sectionGid: null,
    });
  });

  it("refuses an invalid token with an actionable error and stores nothing", async () => {
    me.mockRejectedValueOnce(Object.assign(new Error("Not Authorized"), { status: 401 }));
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/asana/connect",
      payload: { token: "wrong-token" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid-token", message: "Not Authorized" });
    expect(settings.token).toBe("");
    /* The previous connection is untouched, and local Tasks work as before. */
    const local = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Local" },
    });
    expect(local.statusCode).toBe(201);
    expect(local.json<Task>().destination).toEqual({ provider: "local" });
  });

  it("forgets the token on disconnect and disables the destination", async () => {
    await connect();
    await enableDestination();
    const response = await app.inject({ method: "POST", url: "/api/tasks/asana/disconnect" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ connected: false, enabled: false });
    expect(settings.token).toBe("");
  });
});

describe("check connection", () => {
  it("identifies the authenticated user and their accessible workspaces", async () => {
    await connect();
    me.mockClear();
    const response = await app.inject({ method: "POST", url: "/api/tasks/asana/check" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { gid: "1201", name: "Nicolas", email: "nicolas@example.com" },
      workspaces: fakeMe().workspaces,
    });
    expect(me).toHaveBeenCalledWith("valid-token");
    expect(settings.lastVerifiedAt).toBeTypeOf("string");
  });

  it("refuses when no token is stored", async () => {
    const response = await app.inject({ method: "POST", url: "/api/tasks/asana/check" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid-token");
    expect(me).not.toHaveBeenCalled();
  });

  it("refuses a stale token without changing stored state", async () => {
    await connect();
    const verifiedAt = settings.lastVerifiedAt;
    me.mockRejectedValueOnce(Object.assign(new Error("Not Authorized"), { status: 401 }));
    const response = await app.inject({ method: "POST", url: "/api/tasks/asana/check" });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Not Authorized");
    expect(settings.lastVerifiedAt).toBe(verifiedAt);
  });
});

describe("choosing a destination", () => {
  it("scopes projects to the workspace and sections to the project", async () => {
    await connect();
    const projectsResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/asana/projects?workspace=501",
    });
    expect(projectsResponse.json()).toEqual({
      projects: [
        { gid: "p1", name: "Blog" },
        { gid: "p2", name: "Ops" },
      ],
    });
    expect(projects).toHaveBeenCalledWith("valid-token", "501");
    const sectionsResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/asana/sections?project=p1",
    });
    expect(sectionsResponse.json()).toEqual({ sections: [{ gid: "s1", name: "Doing" }] });
    expect(sections).toHaveBeenCalledWith("valid-token", "p1");
  });

  it("requires a token and a real project in the chosen workspace before enabling", async () => {
    const unconnected = await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: true, workspaceGid: "501", projectGid: "p1" },
    });
    expect(unconnected.statusCode).toBe(400);
    expect(settings.enabled).toBe(false);

    await connect();
    const unknown = await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: true, workspaceGid: "501", projectGid: "p_missing" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toContain("does not have that project");
    expect(settings.enabled).toBe(false);

    await enableDestination();
    expect(settings).toMatchObject({
      enabled: true,
      workspaceGid: "501",
      workspaceName: "Personal",
      projectGid: "p1",
      projectName: "Blog",
      sectionGid: null,
    });
  });

  it("refuses a section the project does not hold", async () => {
    await connect();
    const response = await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: true, workspaceGid: "501", projectGid: "p1", sectionGid: "s_missing" },
    });
    expect(response.statusCode).toBe(400);
    expect(settings.enabled).toBe(false);

    const good = await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: true, workspaceGid: "501", projectGid: "p1", sectionGid: "s1" },
    });
    expect(good.statusCode).toBe(200);
    expect(settings).toMatchObject({ enabled: true, sectionGid: "s1", sectionName: "Doing" });
  });

  it("disabling keeps the remembered destination and local Tasks keep working", async () => {
    await connect();
    await enableDestination();
    await app.inject({
      method: "PUT",
      url: "/api/tasks/asana-destination",
      payload: { enabled: false },
    });
    expect(settings.enabled).toBe(false);
    expect(settings.projectGid).toBe("p1");
    const refused = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Not outward", destination: ASANA_DESTINATION },
    });
    expect(refused.statusCode).toBe(400);
    const local = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Local" },
    });
    expect(local.statusCode).toBe(201);
  });
});

describe("creating one linked Task in Asana", () => {
  it("commits the Task locally before Asana is asked at all", async () => {
    await connect();
    await enableDestination();
    let asanaCalls = 0;
    createRemote.mockImplementation(async () => {
      asanaCalls += 1;
      /* The Task is already readable in the Workspace by the time Asana is
         reached: local-first is an ordering, not an aspiration. */
      const read = await app.inject({ method: "GET", url: "/api/tasks" });
      const held = read.json<{ tasks: Task[] }>().tasks;
      expect(held).toHaveLength(1);
      expect(held[0].externalLink?.state).toBe("waiting");
      return { remoteId: "asana_1", url: "https://app.asana.com/0/1/1" };
    });
    const task = await captureToAsana("Ship the thing");
    expect(createRemote).not.toHaveBeenCalled();
    const created = await link(task);
    expect(asanaCalls).toBe(1);
    expect(created.title).toBe("Ship the thing");
    expect(created.externalLink).toMatchObject({
      state: "synchronized",
      remoteId: "asana_1",
      url: "https://app.asana.com/0/1/1",
    });
  });

  it("keeps the Task usable and records a classified failure when Asana refuses", async () => {
    await connect();
    await enableDestination();
    createRemote.mockRejectedValueOnce(Object.assign(new Error("Not Authorized"), { status: 401 }));
    const task = await captureToAsana("Doomed outward, fine inward");
    expect(task.externalLink).toBeNull();
    const created = await link(task);
    expect(created.status).toBe("open");
    expect(created.externalLink).toMatchObject({
      state: "failed",
      remoteId: null,
      failure: {
        kind: "authorization",
        message: "Asana refused the saved credential. Reconnect Asana.",
      },
    });
    const read = await app.inject({ method: "GET", url: `/api/tasks/${created.id}` });
    expect(read.statusCode).toBe(200);
    const completed = await app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/complete`,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json<Task>().status).toBe("completed");
  });

  it("maps title, notes and due date, and completes a completed Task in the same operation", async () => {
    await connect();
    await enableDestination();
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Publish the post",
        notes: "With screenshots",
        dueDate: "2026-09-30",
        destination: ASANA_DESTINATION,
      },
    });
    expect(response.statusCode).toBe(201);
    const task = response.json<Task>();
    expect(task.externalLink).toBeNull();
    await link(task);
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/complete` });
    expect(createRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Publish the post",
        notes: "With screenshots",
        dueDate: "2026-09-30",
        destination: ASANA_DESTINATION,
      }),
      ASANA_DESTINATION,
    );
    expect(updateRemote).toHaveBeenCalledWith(ASANA_DESTINATION, "asana_1", true);
    /* The completion is pushed, then an unopposed read applies the same state
       — the link converges rather than fighting the owner's own change. */
    /* The provider now holds the completion, and the content the Workspace
       sent it — so the read converges rather than reporting a drift. */
    readRemote.mockResolvedValueOnce({
      title: "Publish the post",
      notes: "With screenshots",
      dueDate: "2026-09-30",
      status: "completed",
    });
    const synced = await app.inject({
      method: "POST",
      url: `/api/tasks/${response.json<Task>().id}/sync`,
    });
    expect(synced.json<Task>().externalLink).toMatchObject({ state: "synchronized" });
  });

  it("links a Task for another Responsible Person without provider identity mapping", async () => {
    await connect();
    await enableDestination();
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Their work, my Asana",
        responsiblePerson: null,
        destination: ASANA_DESTINATION,
      },
    });
    expect(created.statusCode).toBe(201);
    const linked = await link(created.json<Task>());
    expect(linked.externalLink?.state).toBe("synchronized");
    const sent = createRemote.mock.calls[0][0];
    expect(sent.responsiblePerson).toBeNull();
    /* The Task object travels to the connector; whether an assignee leaves the
       Workspace is the Asana client's contract, tested there: it never sends
       one. What is proven here is that responsibility does not gate linking. */
    expect(sent.title).toBe("Their work, my Asana");
  });
});
