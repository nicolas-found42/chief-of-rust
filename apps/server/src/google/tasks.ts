import { google } from "googleapis";
import type { ExtractionResult, TaskItem } from "@chief-of-staff-demo/shared";
import type { GoogleAuth } from "./oauth.js";

/**
 * Compose Google Task notes in the exact order of `createTask_` in the
 * routine's Code.gs (parity requirement):
 * Owner / item notes / Quote / Source / source URL, one per line,
 * each line present only when its value is.
 */
export function composeTaskNotes(
  item: TaskItem,
  source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">,
): string {
  const lines: string[] = [];
  if (item.owner) {
    lines.push(`Owner: ${item.owner}`);
  }
  if (item.notes) {
    lines.push(item.notes);
  }
  if (item.sourceQuote) {
    lines.push(`Quote: "${item.sourceQuote}"`);
  }
  if (source.sourceFileName) {
    lines.push(`Source: ${source.sourceFileName}`);
  }
  if (source.sourceUrl) {
    lines.push(source.sourceUrl);
  }
  return lines.join("\n");
}

/**
 * The Tasks API wants RFC 3339 but stores the DATE only. The extraction
 * contract is YYYY-MM-DD; normalize to midnight UTC (parity with createTask_).
 */
export function normalizeDue(due: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00Z` : due;
}

/** Find the tasklist by title or create it (parity with findOrCreateTasklist_). */
export async function findOrCreateTasklist(auth: GoogleAuth, title: string): Promise<string> {
  const tasks = google.tasks({ version: "v1", auth });
  const res = await tasks.tasklists.list();
  const items = res.data.items ?? [];
  const existing = items.find((item) => item.title === title && item.id);
  if (existing?.id) {
    return existing.id;
  }
  const created = await tasks.tasklists.insert({ requestBody: { title } });
  if (!created.data.id) {
    throw new Error(`tasklist insert returned no id for "${title}"`);
  }
  return created.data.id;
}

/**
 * Create one Google Task from a Workspace Task (issue #184). Deliberately not
 * `createGoogleTask` above: that one composes the routine's parity notes from
 * an extraction, while a Workspace Task carries its own title and notes and
 * must not have anything appended to them.
 */
export async function insertGoogleTask(
  auth: GoogleAuth,
  tasklistId: string,
  task: { title: string; notes: string; dueDate: string | null },
): Promise<CreatedTask> {
  const tasks = google.tasks({ version: "v1", auth });
  const res = await tasks.tasks.insert({
    tasklist: tasklistId,
    requestBody: {
      title: task.title,
      notes: task.notes,
      ...(task.dueDate ? { due: normalizeDue(task.dueDate) } : {}),
    },
  });
  if (!res.data.id) {
    throw new Error(`task insert returned no id for "${task.title}"`);
  }
  return { googleId: res.data.id, webViewLink: res.data.webViewLink ?? null };
}

/**
 * The Google Task Lists this account holds, by id and title. Listing the
 * containers is not importing their contents: nothing here reads a single
 * Google Task, and nothing ever brings one into the Workspace.
 */
export async function listGoogleTaskLists(
  auth: GoogleAuth,
): Promise<{ id: string; title: string }[]> {
  const tasks = google.tasks({ version: "v1", auth });
  const res = await tasks.tasklists.list({ maxResults: 100 });
  return (res.data.items ?? [])
    .filter((item): item is { id: string; title: string | null } => Boolean(item.id))
    .map((item) => ({ id: item.id, title: item.title ?? item.id }));
}

export interface CreatedTask {
  googleId: string;
  /** Absolute link to the task in Google's Tasks Web UI, as Google returned it. */
  webViewLink: string | null;
}

export async function createGoogleTask(
  auth: GoogleAuth,
  tasklistId: string,
  item: TaskItem,
  source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">,
): Promise<CreatedTask> {
  const tasks = google.tasks({ version: "v1", auth });
  const requestBody: Record<string, string> = {
    title: item.title,
    notes: composeTaskNotes(item, source),
  };
  if (item.due) {
    requestBody.due = normalizeDue(item.due);
  }

  const res = await tasks.tasks.insert({ tasklist: tasklistId, requestBody });
  if (!res.data.id) {
    throw new Error(`task insert returned no id for "${item.title}"`);
  }
  return { googleId: res.data.id, webViewLink: res.data.webViewLink ?? null };
}

/**
 * Reads one Task's completion from Google Tasks (issue #158). Null when
 * Google no longer holds the Task — the caller falls back to local state.
 */
export async function getGoogleTaskStatus(
  auth: GoogleAuth,
  tasklistId: string,
  taskId: string,
): Promise<{ completed: boolean } | null> {
  const tasks = google.tasks({ version: "v1", auth });
  try {
    const res = await tasks.tasks.get({ tasklist: tasklistId, task: taskId });
    return { completed: res.data.status === "completed" };
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Reads one linked Google Task whole (issue #186): the three content fields
 * and the completion, in the Workspace's own terms. Drift detection compares
 * against what the Workspace last sent, so the due date is narrowed back to
 * the date Google actually stores rather than the RFC 3339 instant it
 * answers with. Null when Google no longer holds the Task.
 */
export async function getGoogleTask(
  auth: GoogleAuth,
  tasklistId: string,
  taskId: string,
): Promise<{ title: string; notes: string; dueDate: string | null; completed: boolean } | null> {
  const tasks = google.tasks({ version: "v1", auth });
  try {
    const res = await tasks.tasks.get({ tasklist: tasklistId, task: taskId });
    return {
      title: res.data.title ?? "",
      notes: res.data.notes ?? "",
      dueDate: dateOnly(res.data.due ?? null),
      completed: res.data.status === "completed",
    };
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Writes one linked Google Task's content (issue #186). A cleared field is
 * sent as an empty value rather than omitted: omitting it would leave the
 * outside edit standing, which is the opposite of restoring the app version.
 */
export async function setGoogleTaskContent(
  auth: GoogleAuth,
  tasklistId: string,
  taskId: string,
  content: { title: string; notes: string; dueDate: string | null },
): Promise<void> {
  const tasks = google.tasks({ version: "v1", auth });
  await tasks.tasks.patch({
    tasklist: tasklistId,
    task: taskId,
    requestBody: {
      title: content.title,
      notes: content.notes,
      due: content.dueDate === null ? null : normalizeDue(content.dueDate),
    },
  });
}

/** Google answers a due date as an instant; the Workspace holds the date. */
function dateOnly(due: string | null): string | null {
  if (due === null || due === "") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(due);
  return match?.[1] ?? null;
}

/**
 * Sets one Google Task's completion (issue #185). Idempotent: completing a
 * completed Task, or reopening an open one, is the same state written again.
 * A Task Google no longer holds surfaces as the caller's 404, which the
 * linking layer records as a missing link rather than a failed write.
 */
export async function setGoogleTaskStatus(
  auth: GoogleAuth,
  tasklistId: string,
  taskId: string,
  completed: boolean,
): Promise<void> {
  const tasks = google.tasks({ version: "v1", auth });
  await tasks.tasks.patch({
    tasklist: tasklistId,
    task: taskId,
    requestBody: completed ? { status: "completed" } : { status: "needsAction" },
  });
}

/** Delete only the explicitly linked record. A missing record is already deleted. */
export async function deleteGoogleTask(
  auth: GoogleAuth,
  tasklistId: string,
  taskId: string,
): Promise<void> {
  const tasks = google.tasks({ version: "v1", auth });
  await tasks.tasks.delete({ tasklist: tasklistId, task: taskId });
}
