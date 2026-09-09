import type { ActionItem, ActionItemPolicy, Task } from "@chief-of-staff-demo/shared";
import type { ActionItemMaterialization, WorkspaceActionItems } from "./action-items.js";
import { promoteActionItem } from "./promotion.js";
import type { WorkspaceTasks } from "./tasks.js";

/**
 * Automatic promotion of the owner's own commitments (ADR-0053, issue #181).
 *
 * The Workspace default is Stage all: a model proposal waits for a person.
 * `auto-create-mine` is the owner's deliberate exception, and everything here
 * exists to keep that exception narrow enough to be safe — the cases it
 * refuses are the point of it, not gaps in it.
 *
 * Automatic promotion never decides anything a review could not; it only
 * decides sooner. So it declines every case where the answer is not already
 * obvious: an unassigned or ambiguously owned commitment, another person's
 * commitment, anything a re-extraction produced, and anything an open Task
 * already looks like. Those stay pending, which is exactly what Stage all
 * would have done with them.
 */
export interface AutoPromotionDeps {
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
  /** Read live: the policy can change between one Debrief and the next. */
  policy: () => ActionItemPolicy;
  /**
   * Deliver one committed Task to its configured external destination. The
   * local write has already happened when this is called, so a rejected
   * promise is recorded on the link and never costs the Task (ADR-0056).
   */
  deliver?: (taskId: string) => Promise<Task>;
  log?: (message: string) => void;
}

/**
 * Materialize one extraction's proposals, then promote the ones the policy
 * makes obvious. One function rather than two calls at the composition seam:
 * eligibility depends on what the queue held *before* this materialization —
 * whether this Transcript has been extracted before at all — and a caller that
 * had to remember to read that first would eventually forget.
 *
 * The answer is the materialized Action Items, in materialization order, with
 * whatever state this call left them in.
 */
export function materializeUnderPolicy(
  deps: AutoPromotionDeps,
  input: ActionItemMaterialization,
): ActionItem[] {
  const first = firstExtractionRunId(deps.actionItems, input);
  const materialized = deps.actionItems.materialize(input);
  if (deps.policy() !== "auto-create-mine") return materialized;
  /* A later extraction of the same Transcript is regeneration, and
     regeneration always stages: the owner has already reviewed this
     Transcript's proposals once, and automation must not answer for them a
     second time. */
  if (first !== null && first !== input.debriefRunId) return materialized;
  return materialized.map((item) => promoteIfEligible(deps, item));
}

/**
 * The Debrief Run that first extracted this Transcript, or null when nothing
 * has. Taken from the stored queue rather than from a flag on the Run: the
 * queue is what survives a restart mid-promotion, so asking it is what makes
 * a resumed materialization reach the same verdict as the interrupted one.
 */
function firstExtractionRunId(
  actionItems: WorkspaceActionItems,
  input: ActionItemMaterialization,
): string | null {
  const held = actionItems.list({ transcriptId: input.transcriptId });
  return held[0]?.source.debriefRunId ?? null;
}

/**
 * Promote one Action Item if the policy's conditions all hold, and answer with
 * the record either way. Failure to promote is never an error: this is an
 * optimization over a review the owner can still perform, so an item that
 * cannot be promoted automatically is simply an item still waiting for them.
 */
function promoteIfEligible(deps: AutoPromotionDeps, item: ActionItem): ActionItem {
  if (!isEligible(deps, item)) return item;
  try {
    /* Open, never completed: automation may accept a commitment the meeting
       made, but it may not invent the news that the work is already done. */
    const result = promoteActionItem(
      { tasks: deps.tasks, actionItems: deps.actionItems },
      item.id,
      {},
    );
    /* The Task has committed. Delivery is a second, separate step whose
       failure lands on the External Task Link, so an outage after this point
       costs a representation and never the accepted work itself. */
    if (deps.deliver && result.task.destination.provider !== "local") {
      void deps.deliver(result.task.id).catch((error: unknown) => {
        deps.log?.(`automatic delivery failed for ${result.task.id}: ${String(error)}`);
      });
    }
    return result.actionItem;
  } catch (error) {
    deps.log?.(`automatic promotion declined for ${item.id}: ${String(error)}`);
    return item;
  }
}

/**
 * Whether automatic promotion may answer for this Action Item. Every clause is
 * a case where a person's judgment is the only defensible answer, so an
 * ineligible item is left exactly as Stage all would have left it.
 */
function isEligible(deps: AutoPromotionDeps, item: ActionItem): boolean {
  /* A decision already made — promoted or dismissed — is not automation's to
     revisit; a retry of this same materialization simply finds it made. */
  if (item.state !== "pending") return false;
  /* Only the first extraction's own proposals. A revision beyond the first is
     something the model said the second time around. */
  if (item.extractionRevision !== 1) return false;
  /* "Mine", confidently: the Debrief resolved this commitment to the
     confirmed owner's Profile. Nobody, or somebody else, waits for review —
     automation must never write another person's work into my list. */
  if (item.proposal.responsiblePerson?.kind !== "owner") return false;
  /* An obvious duplicate is the case the owner most needs to see (issue
     #180). Automation warns nobody, so it declines instead. */
  return (
    deps.tasks.findDuplicates({
      title: item.proposal.title,
      dueDate: item.proposal.dueDate,
      responsiblePerson: item.proposal.responsiblePerson,
    }).length === 0
  );
}
