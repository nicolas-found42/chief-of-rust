import type { Task } from "@chief-of-staff-demo/shared";

/**
 * The Asana REST client (issue #189): the one place that knows Asana's HTTP
 * shapes, so nothing above it ever sees a URL, a header or a response body.
 *
 * Every function takes the personal access token as an argument and puts it
 * nowhere but the Authorization header. Errors carry the HTTP status and a
 * sanitized sentence built from Asana's own error strings — never the token,
 * never a request dump — because provider failures become link state and UI
 * text, and both outlive the call that made them.
 *
 * Like the Google Tasks client, this reads and writes one linked record at a
 * time. Nothing here lists a workspace's Tasks, and no Asana Task ever
 * becomes a Workspace Task.
 */

const API_BASE = "https://app.asana.com/api/1.0";

/** The container fields a Task destination carries, by their Asana names. */
export interface AsanaTaskDestination {
  workspaceGid: string;
  projectGid: string;
  /** Null sends the Task to the project's default section. */
  sectionGid: string | null;
}

export interface AsanaUser {
  gid: string;
  name: string;
  email: string | null;
  /** Every workspace the token's user can reach — Check connection's answer. */
  workspaces: { gid: string; name: string }[];
}

/** A provider failure with its status attached, for failure classification. */
export class AsanaApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AsanaApiError";
    this.status = status;
  }
}

/**
 * Asana answers failures with `{ errors: [string, ...] }`. The first string is
 * the one meant for a person; it is capped and never carries the credential,
 * which travels in the header alone. An unreadable body keeps the status, so
 * classification still works.
 */
async function asanaFetch(path: string, token: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        ...init?.headers,
      },
    });
  } catch {
    throw new AsanaApiError(0, "Asana could not be reached.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    /* Asana's error body is { errors: [{ message }] } — an array of objects
       (developers.asana.com/docs/errors). Plain strings are tolerated, but
       the objects are the real shape: filtering for strings alone would
       discard every actual message and leave only the generic fallback. */
    const errors =
      typeof body === "object" &&
      body !== null &&
      Array.isArray((body as { errors?: unknown }).errors)
        ? (body as { errors: unknown[] }).errors
            .map((entry) => {
              if (typeof entry === "string") return entry;
              if (
                typeof entry === "object" &&
                entry !== null &&
                typeof (entry as { message?: unknown }).message === "string"
              ) {
                return (entry as { message: string }).message;
              }
              return null;
            })
            .filter((message): message is string => message !== null)
        : [];
    const detail = errors[0] ?? "";
    throw new AsanaApiError(
      response.status,
      detail === "" ? `Asana answered ${response.status}.` : detail.slice(0, 280),
    );
  }
  return body;
}

/** The one record Check connection reads: the authenticated user and their workspaces. */
export async function asanaMe(token: string): Promise<AsanaUser> {
  const body = (await asanaFetch(
    "/users/me?opt_fields=gid,name,email,workspaces.gid,workspaces.name",
    token,
  )) as {
    data?: {
      gid?: string;
      name?: string;
      email?: string | null;
      workspaces?: { gid?: string; name?: string }[];
    };
  };
  if (!body.data?.gid) {
    throw new AsanaApiError(0, "Asana answered without a user record.");
  }
  return {
    gid: body.data.gid,
    name: body.data.name ?? body.data.gid,
    email: body.data.email ?? null,
    workspaces: (body.data.workspaces ?? [])
      .filter((workspace): workspace is { gid: string; name?: string } => Boolean(workspace.gid))
      .map((workspace) => ({ gid: workspace.gid, name: workspace.name ?? workspace.gid })),
  };
}

/**
 * The projects of one workspace, following Asana's offset pagination. Only
 * containers are listed — no project's Tasks are ever read.
 */
export async function listAsanaProjects(
  token: string,
  workspaceGid: string,
): Promise<{ gid: string; name: string }[]> {
  const projects: { gid: string; name: string }[] = [];
  let offset: string | undefined;
  do {
    const query = new URLSearchParams({
      workspace: workspaceGid,
      opt_fields: "gid,name",
      limit: "100",
    });
    if (offset !== undefined) query.set("offset", offset);
    const body = (await asanaFetch(`/projects?${query}`, token)) as {
      data?: { gid?: string; name?: string }[];
      next_page?: { offset?: string } | null;
    };
    for (const project of body.data ?? []) {
      if (project.gid !== undefined) {
        projects.push({ gid: project.gid, name: project.name ?? project.gid });
      }
    }
    offset = body.next_page?.offset;
  } while (offset !== undefined);
  return projects;
}

/** The sections of one project — the only read that follows a project choice. */
export async function listAsanaSections(
  token: string,
  projectGid: string,
): Promise<{ gid: string; name: string }[]> {
  /* The documented canonical form: the project is a path parameter
     (GET /projects/{project_gid}/sections), not the legacy query form. */
  const body = (await asanaFetch(
    `/projects/${encodeURIComponent(projectGid)}/sections?opt_fields=gid,name&limit=100`,
    token,
  )) as { data?: { gid?: string; name?: string }[] };
  return (body.data ?? [])
    .filter((section): section is { gid: string; name?: string } => Boolean(section.gid))
    .map((section) => ({ gid: section.gid, name: section.name ?? section.gid }));
}

/**
 * Create one Asana Task from a Workspace Task (issue #189). Deliberately the
 * outward image of `insertGoogleTask`: the Task's own title and notes go out
 * unchanged — nothing is appended, nothing is inferred. The due date is a
 * calendar date, which is what `due_on` holds. A section travels as the
 * create-only `memberships` field, so one successful call places the Task
 * completely; no second write can strand it between project and section.
 *
 * The record is created open. Completion is its own call through
 * `setAsanaTaskStatus`, so a completed Task's outward write is the same
 * recoverable create-then-complete sequence on every provider. There is no
 * assignee field and never will be: a Responsible Person is a local concept,
 * not an identity mapping into someone else's account (ADR-0056).
 */
export async function createAsanaTask(
  token: string,
  destination: AsanaTaskDestination,
  task: Pick<Task, "title" | "notes" | "dueDate">,
): Promise<{ remoteId: string; url: string | null }> {
  const body = (await asanaFetch("/tasks?opt_fields=gid,permalink_url", token, {
    method: "POST",
    body: JSON.stringify({
      data: {
        name: task.title,
        notes: task.notes,
        ...(task.dueDate ? { due_on: task.dueDate } : {}),
        workspace: destination.workspaceGid,
        projects: [destination.projectGid],
        ...(destination.sectionGid
          ? {
              memberships: [{ project: destination.projectGid, section: destination.sectionGid }],
            }
          : {}),
      },
    }),
  })) as { data?: { gid?: string; permalink_url?: string } };
  if (!body.data?.gid) {
    throw new AsanaApiError(0, `Asana accepted "${task.title}" but returned no id.`);
  }
  return { remoteId: body.data.gid, url: body.data.permalink_url ?? null };
}

/**
 * Read one Task's completion. Null when Asana no longer holds the record —
 * the caller marks the link missing rather than failing the local Task.
 */
export async function getAsanaTaskStatus(
  token: string,
  remoteId: string,
): Promise<{ completed: boolean } | null> {
  let body: { data?: { completed?: boolean } };
  try {
    body = (await asanaFetch(
      `/tasks/${encodeURIComponent(remoteId)}?opt_fields=completed`,
      token,
    )) as { data?: { completed?: boolean } };
  } catch (error) {
    if (error instanceof AsanaApiError && error.status === 404) return null;
    throw error;
  }
  return { completed: body.data?.completed === true };
}

/**
 * Read one linked Asana Task whole (issue #186): the three content fields and
 * the completion, in the Workspace's own terms. `due_on` is already a
 * date-only value, which is what a Workspace due date is. Null when Asana no
 * longer holds the record.
 */
export async function getAsanaTask(
  token: string,
  remoteId: string,
): Promise<{ title: string; notes: string; dueDate: string | null; completed: boolean } | null> {
  let body: {
    data?: { name?: string; notes?: string; due_on?: string | null; completed?: boolean };
  };
  try {
    body = (await asanaFetch(
      `/tasks/${encodeURIComponent(remoteId)}?opt_fields=name,notes,due_on,completed`,
      token,
    )) as typeof body;
  } catch (error) {
    if (error instanceof AsanaApiError && error.status === 404) return null;
    throw error;
  }
  return {
    title: body.data?.name ?? "",
    notes: body.data?.notes ?? "",
    dueDate: body.data?.due_on ?? null,
    completed: body.data?.completed === true,
  };
}

/**
 * Write one linked Asana Task's content (issue #186). A cleared due date is
 * sent as null rather than omitted: omitting it would leave an outside edit
 * standing, which is the opposite of restoring the app version. The assignee
 * is untouched here as everywhere — a Responsible Person is a local concept.
 */
export async function setAsanaTaskContent(
  token: string,
  remoteId: string,
  content: { title: string; notes: string; dueDate: string | null },
): Promise<void> {
  await asanaFetch(`/tasks/${encodeURIComponent(remoteId)}`, token, {
    method: "PUT",
    body: JSON.stringify({
      data: { name: content.title, notes: content.notes, due_on: content.dueDate },
    }),
  });
}

/** Set one Task's completion. Idempotent, like the local operation. */
export async function setAsanaTaskStatus(
  token: string,
  remoteId: string,
  completed: boolean,
): Promise<void> {
  await asanaFetch(`/tasks/${encodeURIComponent(remoteId)}`, token, {
    method: "PUT",
    body: JSON.stringify({ data: { completed } }),
  });
}

/** Delete the one record whose link the owner chose to remove with Trash. */
export async function deleteAsanaTask(token: string, remoteId: string): Promise<void> {
  await asanaFetch(`/tasks/${encodeURIComponent(remoteId)}`, token, { method: "DELETE" });
}
