/**
 * One proposed commitment a Meeting Debrief extracted, materialized as a
 * durable Workspace record (ADR-0053, issue #177).
 *
 * An Action Item is not a Task and never becomes one implicitly. It carries a
 * stable identity of its own so that regeneration, retries and reordered model
 * output cannot corrupt a review decision — the identity is derived from the
 * proposal's own content and its Debrief Run, never from its position in the
 * extracted array.
 */

import type { TaskResponsiblePerson } from "./task.js";

/**
 * Pending until the owner decides. Promotion and dismissal are the two
 * decisions; both are recorded here rather than in the Meeting Debrief, so a
 * decision survives re-extraction of the Debrief it came from.
 */
export type ActionItemState = "pending" | "promoted" | "dismissed";

/** Where the proposal came from. Every reference may later be unavailable. */
export interface ActionItemSource {
  debriefRunId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to; null until one is placed. */
  meetingId: string | null;
}

/**
 * What the extraction stood on. References into the Transcript Catalog's own
 * review state rather than copied text: the evidence is re-readable from its
 * source while the source exists, and honestly missing when it does not.
 */
export interface ActionItemEvidence {
  /** The Catalog mention the extraction held responsible; null when none. */
  responsibleMentionId: string | null;
  /** The surface name the extraction inferred; null when nobody was named. */
  responsibleSurfaceName: string | null;
}

/**
 * The Task fields the extraction proposes. Editable during review — nothing
 * here has been accepted yet, and editing a proposal never rewrites the
 * Meeting Debrief's own extracted text.
 */
export interface ActionItemProposal {
  title: string;
  notes: string;
  /** Date-only `YYYY-MM-DD`; null when the meeting stated none. */
  dueDate: string | null;
  responsiblePerson: TaskResponsiblePerson | null;
}

export interface ActionItem {
  /**
   * Workspace identity, derived from the Debrief Run and the proposal's own
   * content. Reordering the extracted array cannot change it, and
   * re-materializing the same extraction returns the same record rather than a
   * duplicate.
   */
  id: string;
  source: ActionItemSource;
  /** Which extraction of this Run produced the proposal. The first is 1. */
  extractionRevision: number;
  evidence: ActionItemEvidence;
  proposal: ActionItemProposal;
  state: ActionItemState;
  /** The Task a promotion created; null while pending or dismissed. */
  promotedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the owner promoted or dismissed it; null while pending. */
  decidedAt: string | null;
}

/** The Action Item queue as the Tasks product reads it. */
export interface ActionItemIndex {
  items: ActionItem[];
}
