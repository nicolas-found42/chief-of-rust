import {
  TASK_COMPACT_LIMIT,
  compareTasks,
  taskGroupOf,
  type TaskOverview,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceActionItems } from "./action-items.js";
import type { WorkspaceTasks } from "./tasks.js";

export interface TaskOverviewDeps {
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
}

/**
 * The compact Tasks rollup (issue #192), derived on read from the canonical
 * stores. Pure derivation: nothing is persisted and nothing is written, so
 * every surface that draws it stays a reader of the Tasks product rather than
 * a second owner of the same numbers.
 *
 * Counted from the same filtered lists it caps, which is what keeps a total
 * honest — the number beside a compact list is the length of the list the cap
 * was taken from, never a separately maintained figure.
 */
export function buildTaskOverview(deps: TaskOverviewDeps): TaskOverview {
  const today = deps.tasks.today();
  const open = deps.tasks.list({ status: "open" }).sort(compareTasks);
  const pending = deps.actionItems.list({ state: "pending" });
  /* Link states over every untrashed Task, open or completed: a link that
     failed on a completed Task is still a write the owner has to settle. */
  const linked = deps.tasks.list();
  const stateIs = (state: string) =>
    linked.filter((task) => task.externalLink?.state === state).length;
  return {
    today,
    counts: {
      open: open.length,
      overdue: open.filter((task) => taskGroupOf(task, today) === "overdue").length,
      dueToday: open.filter((task) => taskGroupOf(task, today) === "today").length,
      pendingActionItems: pending.length,
      failedLinks: stateIs("failed"),
      conflictedLinks: stateIs("conflicted") + stateIs("changed-externally"),
    },
    tasks: open.slice(0, TASK_COMPACT_LIMIT),
    actionItems: pending.slice(0, TASK_COMPACT_LIMIT),
  };
}
