/**
 * How open Tasks are read: four due-date groups and one deterministic order
 * (issue #175).
 *
 * Pure over a calendar date the caller supplies. The Workspace timezone lives
 * on the server, which resolves "today" once and serves it, so a date-only
 * Task near a UTC boundary is grouped by the owner's own day rather than by
 * whatever day the browser happens to be having.
 */

import type { Task, TaskPriority } from "./task.js";

export const TASK_GROUPS = ["overdue", "today", "upcoming", "no-due-date"] as const;
export type TaskGroupKey = (typeof TASK_GROUPS)[number];

export const TASK_GROUP_LABELS: Record<TaskGroupKey, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  "no-due-date": "No due date",
};

/** Which group one Task falls into, by comparing two `YYYY-MM-DD` strings. */
export function taskGroupOf(task: Task, today: string): TaskGroupKey {
  if (task.dueDate === null) return "no-due-date";
  if (task.dueDate < today) return "overdue";
  return task.dueDate === today ? "today" : "upcoming";
}

/** Highest first; `none` last, because no priority is not a low one. */
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2, none: 3 };

/**
 * Due date, then high/medium/low/no priority, then oldest first. Total by
 * construction: two Tasks that tie on all three are ordered by identity, so
 * the list never reshuffles between reads.
 */
export function compareTasks(left: Task, right: Task): number {
  /* A Task with no due date sorts after every dated one. Within `no-due-date`
     every Task shares that, so the rule only ever decides across groups. */
  if (left.dueDate !== right.dueDate) {
    if (left.dueDate === null) return 1;
    if (right.dueDate === null) return -1;
    return left.dueDate < right.dueDate ? -1 : 1;
  }
  const byPriority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (byPriority !== 0) return byPriority;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id.localeCompare(right.id);
}

/** The four groups, each in the default order, from an already-filtered list. */
export function groupTasks(tasks: Task[], today: string): Record<TaskGroupKey, Task[]> {
  const groups: Record<TaskGroupKey, Task[]> = {
    overdue: [],
    today: [],
    upcoming: [],
    "no-due-date": [],
  };
  for (const task of [...tasks].sort(compareTasks)) {
    groups[taskGroupOf(task, today)].push(task);
  }
  return groups;
}
