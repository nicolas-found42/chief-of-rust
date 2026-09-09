import type {
  MeetingDebriefRunResult,
  ExternalTaskBaseline,
  MeetingDebriefReviewState,
} from "@chief-of-staff-demo/shared";
import { MEETING_DEBRIEF_MODULE_ID } from "@chief-of-staff-demo/shared";
import type { RunHandle, Runs } from "../runs.js";
import type { WorkspaceActionItems } from "./action-items.js";
import { promoteActionItem } from "./promotion.js";
import { classifyTaskLinkError, type GoogleTasksDestination } from "./external-link.js";
import type { WorkspaceTasks } from "./tasks.js";

/**
 * Legacy Debrief review, carried into canonical records (ADR-0053, issue
 * #183).
 *
 * Before Tasks existed, a review decision was an array of positions:
 * `droppedActionItems` and `completedActionItems` held indexes into whatever
 * the extraction happened to return that time. Those decisions are real work
 * the owner did, and this is what carries them across — dismissals become
 * dismissed Action Items, local Done becomes a completed Task, and everything
 * undecided joins the pending queue like any other proposal.
 *
 * The old Run files are read and never written. They are the historical record
 * of what the Debrief said and what the owner decided at the time; a migration
 * that rewrote them would destroy the evidence that it was correct.
 *
 * Nothing here needs a marker to be safe to repeat. An Action Item's identity
 * comes from its Run and the proposal's own content, promotion is idempotent,
 * and both decisions refuse to move a record that already decided — so a
 * second pass, or a pass resuming after a crash halfway through a Run, reaches
 * exactly the same state as the first.
 */
export interface LegacyActionMigrationDeps {
  runs: Runs;
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
  /**
   * The Meeting the Transcript belongs to, asked live. A legacy Run predates
   * the Meeting it was later joined to, so the placement is read from the
   * Catalog now rather than from whatever the Run recorded then; an absent
   * answer is a Transcript with no Meeting, which is a normal Action Item.
   */
  meetingIdFor?: (transcriptId: string) => string | null;
  log?: (message: string) => void;
}

/** What one migration pass changed, for the log line and for the tests. */
export interface LegacyActionMigrationResult {
  /** Debrief Runs that held a readable extraction and were carried across. */
  runs: number;
  /** Action Items this pass materialized that the queue did not already hold. */
  actionItems: number;
  dismissed: number;
  /** Locally Done decisions that became completed Tasks. */
  completedTasks: number;
}

export function migrateLegacyActionReview(
  deps: LegacyActionMigrationDeps,
): LegacyActionMigrationResult {
  const result: LegacyActionMigrationResult = {
    runs: 0,
    actionItems: 0,
    dismissed: 0,
    completedTasks: 0,
  };
  for (const summary of deps.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
    const run = deps.runs.open(summary.id);
    if (!run) continue;
    const stored = readResult(run);
    /* A Run with no stored extraction never got as far as proposing anything.
       There is no review to carry, and inventing one from a failed Run would
       put words in the meeting's mouth. */
    if (!stored) continue;
    result.runs += 1;
    const before = new Set(
      deps.actionItems.list({ debriefRunId: summary.id }).map((item) => item.id),
    );
    const materialization = {
      debriefRunId: summary.id,
      transcriptId: stored.transcriptId,
      meetingId: deps.meetingIdFor?.(stored.transcriptId) ?? null,
      actionItems: stored.debrief.actionItems,
    };
    const materialized = deps.actionItems.materialize(materialization);
    result.actionItems += materialized.filter((item) => !before.has(item.id)).length;
    const review = readReview(run);
    if (!review) continue;
    /* Positions, resolved against the same extraction the decisions were made
       against — the array this Run stored, not a re-extraction of it. A
       position past the end is a decision about a proposal that is no longer
       there, and is dropped rather than guessed at. */
    const dropped = new Set(review.review.droppedActionItems);
    const done = new Set(review.review.completedActionItems);
    const receipted = taskReceiptIndexes(run);
    for (const [index, item] of deps.actionItems.materialize(materialization).entries()) {
      if (item.state !== "pending") continue;
      if (dropped.has(index)) {
        deps.actionItems.dismiss(item.id);
        result.dismissed += 1;
        continue;
      }
      /* A Done decision with a provider receipt is a Google-backed record,
         and carrying it across is issue #188's job — it needs the External
         Task Link this migration deliberately does not create. */
      if (!done.has(index) || receipted.has(index)) continue;
      promoteActionItem({ tasks: deps.tasks, actionItems: deps.actionItems }, item.id, {
        completed: true,
      });
      result.completedTasks += 1;
    }
  }
  if (result.runs > 0) {
    deps.log?.(
      `legacy Debrief review migrated: ${result.runs} run(s), ${result.actionItems} new Action Item(s), ` +
        `${result.dismissed} dismissed, ${result.completedTasks} completed Task(s)`,
    );
  }
  return result;
}

/** The Run's stored extraction, or null when it has none this can read. */
function readResult(run: RunHandle): MeetingDebriefRunResult | null {
  const raw = run.readArtifact("result.json");
  if (!raw) return null;
  try {
    /* Parsed as unknown and checked, not asserted: this reads files written
       by older builds, and the one thing a migration may not do is trust
       their shape. */
    const parsed = JSON.parse(raw) as Partial<MeetingDebriefRunResult>;
    const items: unknown = parsed.debrief?.actionItems;
    return Array.isArray(items) && typeof parsed.transcriptId === "string"
      ? (parsed as MeetingDebriefRunResult)
      : null;
  } catch {
    return null;
  }
}

/** The Run's stored review, or null when it holds none this can read. */
function readReview(run: RunHandle): MeetingDebriefReviewState | null {
  const raw = run.readArtifact("review.json");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MeetingDebriefReviewState>;
    const dropped: unknown = parsed.review?.droppedActionItems;
    const completed: unknown = parsed.review?.completedActionItems;
    return Array.isArray(dropped) && Array.isArray(completed)
      ? (parsed as MeetingDebriefReviewState)
      : null;
  } catch {
    return null;
  }
}

/** The action-item positions this Run already created a Google Task for. */
function taskReceiptIndexes(run: RunHandle): Set<number> {
  const indexes = new Set<number>();
  const raw = run.readArtifact("tasks.json");
  if (!raw) return indexes;
  try {
    const receipt = JSON.parse(raw) as { tasks?: Array<{ index: unknown }> };
    for (const entry of receipt.tasks ?? []) {
      if (typeof entry.index === "number") indexes.add(entry.index);
    }
  } catch {
    return indexes;
  }
  return indexes;
}

/** Adopt only remote identities proven by this app's historical receipts. */
export async function migrateLegacyTaskReceipts(
  deps: LegacyActionMigrationDeps & {
    destination: GoogleTasksDestination;
    read: (
      destination: GoogleTasksDestination,
      remoteId: string,
    ) => Promise<ExternalTaskBaseline | null>;
  },
): Promise<void> {
  migrateLegacyActionReview(deps);
  for (const summary of deps.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
    const run = deps.runs.open(summary.id);
    if (!run) continue;
    const stored = readResult(run);
    const raw = run.readArtifact("tasks.json");
    if (!stored || !raw) continue;
    let receipt: {
      taskListId?: string;
      tasks?: Array<{ index?: unknown; taskId?: unknown; taskListId?: string }>;
    };
    try {
      receipt = JSON.parse(raw) as typeof receipt;
    } catch {
      continue;
    }
    if (!Array.isArray(receipt.tasks)) continue;
    const items = deps.actionItems.materialize({
      debriefRunId: summary.id,
      transcriptId: stored.transcriptId,
      meetingId: deps.meetingIdFor?.(stored.transcriptId) ?? null,
      actionItems: stored.debrief.actionItems,
    });
    for (const entry of receipt.tasks) {
      if (
        typeof entry.index !== "number" ||
        !Number.isInteger(entry.index) ||
        typeof entry.taskId !== "string" ||
        entry.taskId === ""
      )
        continue;
      const destination = {
        ...deps.destination,
        googleTaskListId:
          entry.taskListId ?? receipt.taskListId ?? deps.destination.googleTaskListId,
      };
      const item = items[entry.index];
      if (!item) continue;
      if (
        item.state === "promoted" &&
        (!item.promotedTaskId || !deps.tasks.get(item.promotedTaskId))
      )
        continue;
      if (item.state === "dismissed") deps.actionItems.restore(item.id);
      const { task } = promoteActionItem(deps, item.id);
      if (task.externalLink) continue;
      const baseline: ExternalTaskBaseline = {
        title: task.title,
        notes: task.notes,
        dueDate: task.dueDate,
        status: task.status,
      };
      deps.tasks.recordExternalLink(task.id, {
        destination,
        remoteId: entry.taskId,
        url: null,
        state: "waiting",
        baseline,
        external: null,
        failure: null,
      });
      try {
        const remote = await deps.read(destination, entry.taskId);
        if (remote?.status === "completed") deps.tasks.complete(task.id);
        if (remote?.status === "open") deps.tasks.reopen(task.id);
        deps.tasks.refreshExternalLink(task.id, {
          destination,
          remoteId: entry.taskId,
          url: null,
          state: remote ? "synchronized" : "missing",
          baseline: remote ?? baseline,
          external: null,
          failure: remote
            ? null
            : { kind: "not-found", message: "Google Tasks no longer holds that Task." },
        });
      } catch (error) {
        const failure = classifyTaskLinkError(error, "Google Tasks");
        deps.tasks.refreshExternalLink(task.id, {
          destination,
          remoteId: entry.taskId,
          url: null,
          state: failure.kind === "not-found" ? "missing" : "failed",
          baseline,
          external: null,
          failure,
        });
      }
    }
  }
}
