import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  AsanaApiError,
  asanaMe,
  createAsanaTask,
  getAsanaTaskStatus,
  listAsanaProjects,
  listAsanaSections,
  setAsanaTaskStatus,
} from "../../../apps/server/src/asana/client";

/**
 * The Asana client against a mocked fetch (issue #189). What is under test is
 * the mapping through the connector contract — title/notes/due date out,
 * provider identity and URL back, completion read and written — and the
 * sanitation guarantees: the token travels in the Authorization header alone,
 * and no request ever names an assignee.
 */

const TOKEN = "pat-secret-token-value-4242";

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(200, { data: {} }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

describe("asanaMe", () => {
  it("identifies the user and their accessible workspaces in one read", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          gid: "1201",
          name: "Nicolas",
          email: "nicolas@example.com",
          workspaces: [
            { gid: "501", name: "Personal" },
            { gid: "502", name: "Acme" },
          ],
        },
      }),
    );
    await expect(asanaMe(TOKEN)).resolves.toEqual({
      gid: "1201",
      name: "Nicolas",
      email: "nicolas@example.com",
      workspaces: [
        { gid: "501", name: "Personal" },
        { gid: "502", name: "Acme" },
      ],
    });
    const { url, init } = lastCall();
    expect(url).toBe(
      "https://app.asana.com/api/1.0/users/me?opt_fields=gid,name,email,workspaces.gid,workspaces.name",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses an invalid token with Asana's own words and no credential in them", async () => {
    /* The documented error body is { errors: [{ message }] } — objects, not
       strings; the message must survive extraction. */
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { errors: [{ message: "Not Authorized" }] }));
    await expect(asanaMe("wrong-token")).rejects.toMatchObject({
      status: 401,
      message: "Not Authorized",
    });
  });
});

describe("listAsanaProjects", () => {
  it("scopes projects to the workspace and follows offset pagination", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [{ gid: "p1", name: "Blog" }],
          next_page: { offset: "o2" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ gid: "p2", name: "Ops" }], next_page: null }),
      );
    await expect(listAsanaProjects(TOKEN, "501")).resolves.toEqual([
      { gid: "p1", name: "Blog" },
      { gid: "p2", name: "Ops" },
    ]);
    const first = new URL((fetchMock.mock.calls[0] as [string, RequestInit])[0]);
    expect(first.pathname).toBe("/api/1.0/projects");
    expect(first.searchParams.get("workspace")).toBe("501");
    const second = new URL((fetchMock.mock.calls[1] as [string, RequestInit])[0]);
    expect(second.searchParams.get("offset")).toBe("o2");
  });
});

describe("listAsanaSections", () => {
  it("scopes sections to the chosen project", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { gid: "s1", name: "Untitled section" },
          { gid: "s2", name: "Doing" },
        ],
      }),
    );
    await expect(listAsanaSections(TOKEN, "p1")).resolves.toEqual([
      { gid: "s1", name: "Untitled section" },
      { gid: "s2", name: "Doing" },
    ]);
    const { url } = lastCall();
    expect(url).toBe(
      "https://app.asana.com/api/1.0/projects/p1/sections?opt_fields=gid,name&limit=100",
    );
  });
});

describe("createAsanaTask", () => {
  const destination = { workspaceGid: "501", projectGid: "p1", sectionGid: null };

  it("maps title, notes and date-only due date, and answers provider identity", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { gid: "t9", permalink_url: "https://app.asana.com/0/1/9" } }),
    );
    await expect(
      createAsanaTask(TOKEN, destination, {
        title: "Ship the thing",
        notes: "Carefully",
        dueDate: "2026-09-30",
      }),
    ).resolves.toEqual({ remoteId: "t9", url: "https://app.asana.com/0/1/9" });
    const { init } = lastCall();
    expect(JSON.parse(init.body as string).data).toEqual({
      name: "Ship the thing",
      notes: "Carefully",
      due_on: "2026-09-30",
      workspace: "501",
      projects: ["p1"],
    });
  });

  it("omits the due date when the Task has none, and never names an assignee", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { gid: "t1" } }));
    await createAsanaTask(TOKEN, destination, { title: "T", notes: "", dueDate: null });
    const sent = JSON.parse(lastCall().init.body as string).data;
    expect(sent.due_on).toBeUndefined();
    expect(sent.assignee).toBeUndefined();
    expect(sent.assignee_section).toBeUndefined();
    expect(JSON.stringify(sent)).not.toMatch(/assignee/i);
  });

  it("places a sectioned Task with the create-only membership, not a second write", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { gid: "t2" } }));
    await createAsanaTask(
      TOKEN,
      { workspaceGid: "501", projectGid: "p1", sectionGid: "s2" },
      { title: "T", notes: "", dueDate: null },
    );
    const sent = JSON.parse(lastCall().init.body as string).data;
    expect(sent.memberships).toEqual([{ project: "p1", section: "s2" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises Asana's own validation message, sanitized, on a refused create", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { errors: [{ message: "Not a member of the project" }] }),
    );
    await expect(
      createAsanaTask(TOKEN, destination, { title: "T", notes: "", dueDate: null }),
    ).rejects.toMatchObject({ status: 403, message: "Not a member of the project" });
  });
});

describe("task status", () => {
  it("reads completion and writes it idempotently", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { completed: true } }));
    await expect(getAsanaTaskStatus(TOKEN, "t9")).resolves.toEqual({ completed: true });
    await setAsanaTaskStatus(TOKEN, "t9", true);
    const put = lastCall();
    expect(put.init.method).toBe("PUT");
    expect(JSON.parse(put.init.body as string)).toEqual({ data: { completed: true } });
  });

  it("answers null — not an error — when Asana no longer holds the Task", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errors: [{ message: "Not Found" }] }));
    await expect(getAsanaTaskStatus(TOKEN, "gone")).resolves.toBeNull();
  });

  it("keeps non-404 failures as classified errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { errors: [{ message: "Not Authorized" }] }));
    await expect(getAsanaTaskStatus(TOKEN, "t9")).rejects.toBeInstanceOf(AsanaApiError);
  });
});
