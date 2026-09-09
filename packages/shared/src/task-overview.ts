/**
 * The compact rollup Home and the Meeting Wizard read (issue #192): canonical
 * Tasks and materialized Action Items, counted once on the server so two
 * surfaces cannot disagree about how much work is open.
 *
 * Compact, not partial: every list is capped and every cap is paired with the
 * total it was taken from, so a surface that shows eight rows can still say
 * how many there are. Nothing here is writable — the Tasks product owns the
 * records, and each row links back to it.
 */

import type { Task } from "./task.js";
import type { ActionItem } from "./action-item.js";

/** Rows a compact surface may draw, per group (spec: user story 104). */
export const TASK_COMPACT_LIMIT = 8;

/**
 * The counts a metric strip reads. Every one of them counts active work only:
 * completed, dismissed and trashed records are excluded by construction, so a
 * cleared queue reads as zero rather than as history.
 */
export interface TaskOverviewCounts {
  /** Open, untrashed Tasks. */
  open: number;
  /** Open Tasks whose due date is before the Workspace's today. */
  overdue: number;
  /** Open Tasks due on the Workspace's today. */
  dueToday: number;
  /** Action Items still awaiting a decision. */
  pendingActionItems: number;
  /** Tasks whose External Task Link last write failed and is retryable. */
  failedLinks: number;
  /** Tasks whose link needs the owner to settle drift or a completion conflict. */
  conflictedLinks: number;
}

/** GET /api/tasks/overview — what a compact surface needs, in one read. */
export interface TaskOverview {
  /** The Workspace's own calendar day, `YYYY-MM-DD`, never the browser's. */
  today: string;
  counts: TaskOverviewCounts;
  /** At most `TASK_COMPACT_LIMIT`, in the default Task order. */
  tasks: Task[];
  /** At most `TASK_COMPACT_LIMIT`, oldest proposal first. */
  actionItems: ActionItem[];
}
