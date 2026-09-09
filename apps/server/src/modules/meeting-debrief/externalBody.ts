import type { MeetingDebriefExtraction } from "@chief-of-staff-demo/shared";

/**
 * The external-safe Debrief body (issue #141, AC 3 and AC 4).
 *
 * This is the only text that leaves the Workspace, so it is built by naming
 * what may appear rather than by removing what may not. The extraction holds
 * coaching advice, effectiveness evidence, per-decision transcript quotes and
 * Catalog identity ids; none of them is read here, so no future field added
 * to the extraction can leak by default.
 *
 * Retained actions are the action items the owner did not drop in review.
 * The approved extraction shape has no separate "next steps" field — the
 * retained actions are the next steps, and inventing a second list would mean
 * inventing content the meeting did not produce.
 */
export function composeExternalDebriefBody(
  extraction: MeetingDebriefExtraction,
  droppedActionItems: readonly number[],
): string {
  const dropped = new Set(droppedActionItems);
  const retained = extraction.actionItems.filter((_, index) => !dropped.has(index));

  const lines: string[] = [extraction.summary];

  if (extraction.decisions.length > 0) {
    lines.push("", "Decisions");
    /* The statement only. `evidence` is the transcript quote it stands on:
       private evidence, and the reason a decision is stated rather than
       quoted. */
    for (const decision of extraction.decisions) lines.push(`- ${decision.statement}`);
  }

  if (retained.length > 0) {
    lines.push("", "Next steps");
    for (const action of retained) {
      /* The owner is the surface name the meeting used. Whether the Catalog
         resolved it to a Profile is review state, not news for a reader. */
      const owner = action.owner ? ` — ${action.owner}` : "";
      const due = action.dueDate ? ` (due ${action.dueDate})` : "";
      lines.push(`- ${action.title}${owner}${due}`);
    }
  }

  if (extraction.openQuestions.length > 0) {
    lines.push("", "Open questions");
    for (const question of extraction.openQuestions) {
      const raisedBy = question.raisedBy ? ` — raised by ${question.raisedBy}` : "";
      lines.push(`- ${question.question}${raisedBy}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
