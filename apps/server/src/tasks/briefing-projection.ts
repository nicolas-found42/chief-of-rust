import {
  TASK_COMPACT_LIMIT,
  compareTasks,
  taskGroupOf,
  type DailyBriefingActionItem,
  type DailyBriefingTask,
  type DailyBriefingWork,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceActionItems } from "./action-items.js";
import type { WorkspaceTasks } from "./tasks.js";

export interface BriefingWorkDeps {
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
}

/**
 * The bounded Task projection a Briefing reads (issue #192). The Tasks product
 * hands the Meeting Wizard a projection rather than its records: a Briefing
 * shows work without owning any of it, and cannot edit what it draws.
 *
 * Tasks and Action Items stay two lists with two identities. An Action Item is
 * a proposal awaiting a decision, and a Briefing that merged them would be
 * telling the owner they had committed to something they had not.
 */
export function buildDailyBriefingWork(deps: BriefingWorkDeps): DailyBriefingWork {
  const today = deps.tasks.today();
  const open = deps.tasks.list({ status: "open" }).sort(compareTasks);
  const project = (task: (typeof open)[number]): DailyBriefingTask => ({
    taskId: task.id,
    title: task.title,
    dueDate: task.dueDate,
    priority: task.priority,
  });
  const overdue = open.filter((task) => taskGroupOf(task, today) === "overdue");
  const dueToday = open.filter((task) => taskGroupOf(task, today) === "today");
  /* Urgency the day's dates do not already carry. A high-priority Task due
     today is on the list above, and repeating it here would inflate the day. */
  const highPriority = open.filter(
    (task) => task.priority === "high" && !overdue.includes(task) && !dueToday.includes(task),
  );
  const pending = deps.actionItems.list({ state: "pending" });
  const proposals: DailyBriefingActionItem[] = pending.map((item) => ({
    actionItemId: item.id,
    title: item.proposal.title,
    dueDate: item.proposal.dueDate,
    meetingId: item.source.meetingId,
  }));
  return {
    overdue: overdue.slice(0, TASK_COMPACT_LIMIT).map(project),
    dueToday: dueToday.slice(0, TASK_COMPACT_LIMIT).map(project),
    highPriority: highPriority.slice(0, TASK_COMPACT_LIMIT).map(project),
    pendingActionItems: proposals.slice(0, TASK_COMPACT_LIMIT),
    totals: {
      overdue: overdue.length,
      dueToday: dueToday.length,
      highPriority: highPriority.length,
      pendingActionItems: proposals.length,
    },
  };
}

/** The empty projection a Workspace with no composed Tasks product reads. */
export const NO_BRIEFING_WORK: DailyBriefingWork = {
  overdue: [],
  dueToday: [],
  highPriority: [],
  pendingActionItems: [],
  totals: { overdue: 0, dueToday: 0, highPriority: 0, pendingActionItems: 0 },
};
