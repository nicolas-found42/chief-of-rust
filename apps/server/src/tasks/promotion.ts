import type { ActionItem, Task, TaskCreateInput } from "@chief-of-staff-demo/shared";
import type { WorkspaceActionItems } from "./action-items.js";
import { TaskValidationError, type WorkspaceTasks } from "./tasks.js";

/**
 * Promoting one reviewed Action Item into a Task (ADR-0053, issue #178).
 *
 * A function over both Workspace modules rather than a method on either: an
 * Action Item is a proposal and a Task is accepted work, and neither should
 * have to know how the other is stored in order to stay itself. The two writes
 * meet here and nowhere else.
 *
 * Promotion is a decision, not a copy. The review supplies the accepted
 * fields, the Task snapshots them, and the Action Item keeps its own proposal
 * text exactly as extracted — so a later Task edit changes nothing about the
 * Meeting Debrief it came from.
 */
export interface PromotionDeps {
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
}

/** What one promotion accepts: the Task fields, and which state to create in. */
export interface PromotionInput extends Partial<TaskCreateInput> {
  /** Create the Task already completed — the meeting's work is already done. */
  completed?: boolean;
}

export interface PromotionResult {
  task: Task;
  actionItem: ActionItem;
  /** False when this call found the promotion already recorded. */
  created: boolean;
}

/**
 * Promote once, whatever happens afterwards. An Action Item already promoted
 * answers with the Task it already has: a retry — a double-clicked button, a
 * reissued request, a client that lost the response — must never produce a
 * second Task for one commitment.
 *
 * The Task is written before the relationship, deliberately. The two files
 * cannot commit as one, so the order is chosen for what an interruption
 * leaves behind: a Task with no relationship is recoverable — the next attempt
 * finds it by its own source and adopts it — while a relationship pointing at
 * no Task would have lost the accepted work itself.
 */
export function promoteActionItem(
  deps: PromotionDeps,
  actionItemId: string,
  input: PromotionInput = {},
): PromotionResult {
  const item = deps.actionItems.get(actionItemId);
  if (!item) {
    throw new TaskValidationError("task-not-found", `No Action Item with id ${actionItemId}`);
  }
  if (item.state === "dismissed") {
    throw new TaskValidationError(
      "action-item-dismissed",
      "That Action Item was dismissed. Restore it to pending before creating a Task.",
    );
  }
  if (item.state === "promoted" && item.promotedTaskId !== null) {
    const existing = deps.tasks.get(item.promotedTaskId);
    /* A promoted Action Item stays promoted even when its Task has been
       trashed or permanently deleted: the decision is history, and history
       does not become available again because the work went away. */
    if (existing) {
      return { task: existing, actionItem: item, created: false };
    }
    throw new TaskValidationError(
      "task-not-found",
      "That Action Item was already promoted and its Task no longer exists.",
    );
  }
  /* An interrupted promotion — the Task written, the relationship not — leaves
     a Task whose source names this Action Item and an Action Item still
     pending. Adopting that Task is what makes the retry safe: the two files
     cannot commit as one, so the recovery is to recognize the half that did. */
  const orphan = deps.tasks
    .list({ trashed: false })
    .concat(deps.tasks.list({ trashed: true }))
    .find((candidate) => candidate.source?.actionItemId === item.id);
  if (orphan) {
    if (input.completed === true && orphan.status !== "completed") deps.tasks.complete(orphan.id);
    return {
      task: deps.tasks.get(orphan.id) ?? orphan,
      actionItem: deps.actionItems.recordPromotion(item.id, orphan.id),
      created: false,
    };
  }
  const task = deps.tasks.create(
    {
      title: input.title ?? item.proposal.title,
      notes: input.notes ?? item.proposal.notes,
      dueDate: input.dueDate === undefined ? item.proposal.dueDate : input.dueDate,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.listId === undefined ? {} : { listId: input.listId }),
      responsiblePerson:
        input.responsiblePerson === undefined
          ? item.proposal.responsiblePerson
          : input.responsiblePerson,
      ...(input.destination === undefined ? {} : { destination: input.destination }),
    },
    {
      kind: "action-item",
      actionItemId: item.id,
      debriefRunId: item.source.debriefRunId,
      transcriptId: item.source.transcriptId,
      meetingId: item.source.meetingId,
    },
  );
  if (input.completed === true) {
    deps.tasks.complete(task.id);
  }
  const actionItem = deps.actionItems.recordPromotion(item.id, task.id);
  return { task: deps.tasks.get(task.id) ?? task, actionItem, created: true };
}
