import type { AppConfig, DraftItem, ExtractionResult, TaskItem } from "@chief-of-staff-demo/shared";
import { buildGoogleAuth, type GoogleAuth } from "./oauth.js";
import { createGmailDraft, gmailDraftInput } from "./gmail.js";
import {
  createGoogleTask,
  findOrCreateTasklist,
  getGoogleTaskStatus,
  type CreatedTask,
} from "./tasks.js";

/**
 * The only Google surface a Run talks to. Reached through the Google
 * connection, never built directly: whether the connection can hand one out is
 * the connection's decision to make.
 */
export interface GoogleOutputs {
  findOrCreateTasklist(title: string): Promise<string>;
  createTask(
    tasklistId: string,
    item: TaskItem,
    source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">,
  ): Promise<CreatedTask>;
  /** Reads one Task's completion; null when Google no longer holds it. */
  getTask(tasklistId: string, taskId: string): Promise<{ completed: boolean } | null>;
  createDraft(draft: DraftItem): Promise<string>;
}

export function googleOutputs(config: AppConfig, port: number): GoogleOutputs {
  const auth: GoogleAuth = buildGoogleAuth(config, port);
  return {
    findOrCreateTasklist: (title: string) => findOrCreateTasklist(auth, title),
    createTask: (
      tasklistId: string,
      item: TaskItem,
      source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">,
    ) => createGoogleTask(auth, tasklistId, item, source),
    getTask: (tasklistId: string, taskId: string) => getGoogleTaskStatus(auth, tasklistId, taskId),
    createDraft: (draft: DraftItem) => createGmailDraft(auth, gmailDraftInput(draft)),
  };
}
