import type {
  ActionItem,
  ActionItemIndex,
  ActionItemPolicy,
  ActionItemState,
  Task,
  TaskCreateInput,
  TaskDuplicateCandidate,
  TaskDuplicateCheck,
  TaskIndex,
  TaskList,
  TaskOverview,
  TaskStatus,
  TaskUpdateInput,
} from "@chief-of-staff-demo/shared";
import { request } from "../client";

/**
 * The Tasks area's client: the Workspace's canonical record of accepted work —
 * capture, editing, completion and Task List management — and the readable
 * queue of Action Items a Meeting Debrief proposed. No endpoint here reaches a
 * provider, which is why the whole area works with nothing connected.
 * client.ts holds transport only.
 */

/** What the Tasks page narrows on (issue #175). Everything is optional. */
export interface TaskFilters {
  listId?: string;
  status?: TaskStatus;
  trashed?: boolean;
  search?: string;
  priority?: string;
  responsible?: string;
  linked?: boolean;
}

function taskQuery(query: TaskFilters = {}): string {
  const params = new URLSearchParams();
  if (query.listId) params.set("listId", query.listId);
  if (query.status) params.set("status", query.status);
  if (query.trashed) params.set("trashed", "true");
  if (query.search) params.set("search", query.search);
  if (query.priority) params.set("priority", query.priority);
  if (query.responsible) params.set("responsible", query.responsible);
  if (query.linked !== undefined) params.set("linked", String(query.linked));
  return params.size > 0 ? `?${params.toString()}` : "";
}

/** The Google Tasks destination, as the Tasks page reads and writes it. */
export interface GoogleTasksDestination {
  enabled: boolean;
  taskListId: string;
  taskListTitle: string;
  /** False when this Workspace composes no Google connection at all. */
  available: boolean;
}

/** The Asana destination, as the Tasks page reads and writes it (issue #189). */
export interface AsanaDestination {
  connected: boolean;
  /** The last four characters of the stored token; the full token never leaves the server. */
  tokenHint: string;
  lastVerifiedAt: string | null;
  enabled: boolean;
  workspaceGid: string;
  workspaceName: string;
  projectGid: string;
  projectName: string;
  sectionGid: string | null;
  sectionName: string | null;
  /** False when this Workspace composes no Asana destination at all. */
  available: boolean;
}

/**
 * The Action Item Policy and what turning it on would send outward (issue
 * #181). `externalDestination` names the provider an automatically created
 * Task would reach, or is null when none would — the surface warns from this
 * rather than deciding for itself what a destination implies.
 */
export interface ActionItemPolicySetting {
  policy: ActionItemPolicy;
  externalDestination: string | null;
}

/** What Check connection answers: who the token belongs to and what it reaches. */
export interface AsanaCheckConnection {
  user: { gid: string; name: string; email: string | null };
  workspaces: { gid: string; name: string }[];
}

export const tasksApi = {
  tasks: (query?: TaskFilters) => request<TaskIndex>(`/api/tasks${taskQuery(query)}`),
  /**
   * The compact rollup Home draws (issue #192): counts, two capped lists, and
   * the Workspace's own today. One read rather than fetching every Task and
   * counting them in the browser.
   */
  overview: () => request<TaskOverview>("/api/tasks/overview"),
  createTask: (input: TaskCreateInput) =>
    request<Task>("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  /** The open Tasks this candidate would duplicate — the warning's input. */
  checkDuplicates: (candidate: TaskDuplicateCandidate) =>
    request<TaskDuplicateCheck>("/api/tasks/duplicates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidate),
    }),
  updateTask: (taskId: string, input: TaskUpdateInput) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  completeTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: "POST" }),
  reopenTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/reopen`, { method: "POST" }),
  createTaskList: (name: string) =>
    request<TaskList>("/api/task-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  renameTaskList: (listId: string, name: string) =>
    request<TaskList>(`/api/task-lists/${encodeURIComponent(listId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  deleteTaskList: (listId: string) =>
    request<{ lists: TaskList[] }>(`/api/task-lists/${encodeURIComponent(listId)}`, {
      method: "DELETE",
    }),
  trashTask: (taskId: string, external?: "delete" | "preserve") =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/trash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ external }),
    }),
  refresh: () => request<{ tasks: Task[] }>("/api/tasks/refresh", { method: "POST" }),
  retryFailed: () => request<{ tasks: Task[] }>("/api/tasks/retry-failed", { method: "POST" }),
  recoverCreation: (taskId: string, remoteId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/recover-creation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteId }),
    }),
  retryTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST" }),
  restoreTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/restore`, { method: "POST" }),
  /* Confirmation travels in the request: the server refuses a deletion nobody
     said out loud, and this is the surface saying it. */
  deleteTaskForever: (taskId: string) =>
    request<{ deleted: string }>(`/api/tasks/${encodeURIComponent(taskId)}?confirm=true`, {
      method: "DELETE",
    }),
  actionItems: (query: { state?: ActionItemState; debriefRunId?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.state) params.set("state", query.state);
    if (query.debriefRunId) params.set("debriefRunId", query.debriefRunId);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return request<ActionItemIndex>(`/api/action-items${suffix}`);
  },
  promoteActionItem: (actionItemId: string, input: TaskUpdateInput & { completed?: boolean }) =>
    request<{ task: Task; actionItem: ActionItem }>(
      `/api/action-items/${encodeURIComponent(actionItemId)}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  dismissActionItem: (actionItemId: string) =>
    request<{ actionItem: ActionItem }>(
      `/api/action-items/${encodeURIComponent(actionItemId)}/dismiss`,
      { method: "POST" },
    ),
  restoreActionItem: (actionItemId: string) =>
    request<{ actionItem: ActionItem }>(
      `/api/action-items/${encodeURIComponent(actionItemId)}/restore`,
      { method: "POST" },
    ),
  actionItemPolicy: () => request<ActionItemPolicySetting>("/api/action-item-policy"),
  /* The confirmation travels in the request, like permanent deletion's does:
     the server refuses automatic outbound writes nobody agreed to, and this
     is the surface saying the owner agreed. */
  setActionItemPolicy: (policy: ActionItemPolicy, confirmedExternalWrites = false) =>
    request<ActionItemPolicySetting>("/api/action-item-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy, confirmedExternalWrites }),
    }),
  googleDestination: () => request<GoogleTasksDestination>("/api/tasks/google-destination"),
  googleLists: () => request<{ lists: { id: string; title: string }[] }>("/api/tasks/google-lists"),
  setGoogleDestination: (input: { enabled: boolean; taskListId?: string }) =>
    request<GoogleTasksDestination>("/api/tasks/google-destination", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  asanaDestination: () => request<AsanaDestination>("/api/tasks/asana-destination"),
  asanaConnect: (token: string) =>
    request<AsanaCheckConnection & { tokenHint: string }>("/api/tasks/asana/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  asanaDisconnect: () =>
    request<AsanaDestination>("/api/tasks/asana/disconnect", { method: "POST" }),
  asanaCheck: () => request<AsanaCheckConnection>("/api/tasks/asana/check", { method: "POST" }),
  asanaProjects: (workspaceGid: string) =>
    request<{ projects: { gid: string; name: string }[] }>(
      `/api/tasks/asana/projects?workspace=${encodeURIComponent(workspaceGid)}`,
    ),
  asanaSections: (projectGid: string) =>
    request<{ sections: { gid: string; name: string }[] }>(
      `/api/tasks/asana/sections?project=${encodeURIComponent(projectGid)}`,
    ),
  setAsanaDestination: (input: {
    enabled: boolean;
    workspaceGid?: string | undefined;
    projectGid?: string | undefined;
    sectionGid?: string | null | undefined;
  }) =>
    request<AsanaDestination>("/api/tasks/asana-destination", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  linkTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/link`, { method: "POST" }),
  recreateTask: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/recreate`, { method: "POST" }),
  /* One route per fact, like the server has: an outside edit and an outside
     completion are settled by different answers (issue #186). */
  resolveTaskLink: (taskId: string, kind: "drift" | "conflict", keep: "app" | "external") =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keep }),
    }),
  removeTaskLink: (taskId: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/link`, { method: "DELETE" }),
};

/** The typed surface a Tasks page (or its test double) binds to. */
export type TasksClient = typeof tasksApi;
