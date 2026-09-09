import { createHash } from "node:crypto";
import type {
  ActionItem,
  ActionItemState,
  MeetingDebriefActionItem,
  TaskResponsiblePerson,
} from "@chief-of-staff-demo/shared";
import type { TaskStore } from "./store.js";
import { TaskValidationError } from "./tasks.js";

/** One extraction's proposed commitments, as the Meeting Debrief hands them over. */
export interface ActionItemMaterialization {
  debriefRunId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to; null until one is placed. */
  meetingId: string | null;
  actionItems: MeetingDebriefActionItem[];
}

/** What an Action Item query narrows on. Everything is optional. */
export interface ActionItemQuery {
  state?: ActionItemState;
  debriefRunId?: string;
  transcriptId?: string;
  meetingId?: string;
}

export interface WorkspaceActionItemsDeps {
  store: TaskStore;
  now?: () => Date;
  /**
   * The confirmed owner's Person Profile id, read live. An extraction that
   * resolved a commitment to that Profile proposes the owner as Responsible
   * Person; every other resolved Profile proposes itself, and an unresolved
   * one proposes nobody rather than guessing.
   */
  ownerProfileId?: () => string | null;
}

/**
 * The Workspace's Action Items (ADR-0053, issue #177).
 *
 * A Meeting Debrief produces these; it does not own them. Materialization is
 * the one write the Debrief performs here, and it is idempotent: an Action
 * Item's identity is derived from its Debrief Run and the proposal's own
 * content, so re-running the same extraction returns the same records — with
 * whatever review decisions they already carry — rather than duplicating them,
 * and reordering the extracted array changes nothing at all.
 */
export class WorkspaceActionItems {
  private readonly store: TaskStore;
  private readonly now: () => Date;
  private readonly ownerProfileId: () => string | null;

  constructor(deps: WorkspaceActionItemsDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.ownerProfileId = deps.ownerProfileId ?? (() => null);
  }

  /**
   * Record one Action Item per proposed commitment. Items already held for
   * this Debrief Run are left exactly as they are, so a retry cannot rewrite a
   * decision or reset a proposal the owner has been reviewing.
   *
   * The extraction revision counts the extractions of this Run that produced
   * something new: the first materialization is revision 1, and a
   * re-materialization that proposes nothing unseen keeps that number.
   */
  materialize(input: ActionItemMaterialization): ActionItem[] {
    const stored = this.store.readActionItems();
    const held = new Map(
      stored
        .filter((item) => item.source.debriefRunId === input.debriefRunId)
        .map((i) => [i.id, i]),
    );
    const revision = nextRevision([...held.values()], input);
    const at = this.now().toISOString();
    const materialized: ActionItem[] = [];
    const added: ActionItem[] = [];
    for (const proposed of input.actionItems) {
      const id = actionItemId(input.debriefRunId, proposed);
      const existing = held.get(id);
      if (existing) {
        materialized.push(existing);
        continue;
      }
      const item: ActionItem = {
        id,
        source: {
          debriefRunId: input.debriefRunId,
          transcriptId: input.transcriptId,
          meetingId: input.meetingId,
        },
        extractionRevision: revision,
        evidence: {
          responsibleMentionId: proposed.ownerMentionId,
          responsibleSurfaceName: proposed.owner,
        },
        proposal: {
          title: proposed.title,
          notes: "",
          dueDate: proposed.dueDate,
          responsiblePerson: this.proposedResponsiblePerson(proposed.ownerProfileId),
        },
        state: "pending",
        promotedTaskId: null,
        createdAt: at,
        updatedAt: at,
        decidedAt: null,
      };
      /* Two proposals with the same title, owner and due date are one
         commitment stated twice, and share one identity by construction. */
      if (added.some((candidate) => candidate.id === id)) continue;
      added.push(item);
      materialized.push(item);
    }
    if (added.length > 0) this.store.writeActionItems([...stored, ...added]);
    return materialized;
  }

  /**
   * Stored order, which is materialization order: extraction order inside one
   * Debrief, and chronological across Debriefs because materializing appends.
   * Nothing re-sorts it — a queue that reshuffles itself when the model
   * reorders its output is the problem stable identities exist to avoid.
   */
  list(query: ActionItemQuery = {}): ActionItem[] {
    return this.store
      .readActionItems()
      .filter(
        (item) =>
          matches(query.state, item.state) &&
          matches(query.debriefRunId, item.source.debriefRunId) &&
          matches(query.transcriptId, item.source.transcriptId) &&
          matches(query.meetingId, item.source.meetingId),
      );
  }

  /**
   * Record that this Action Item became that Task. The one write outside
   * materialization, and deliberately narrow: the proposal, the evidence and
   * the source are untouched, so the queue keeps saying what the meeting said
   * while the Task goes on to say whatever the owner makes of it.
   *
   * Promotion is one-way. Nothing here unpromotes, because a decision the
   * owner made is history rather than a toggle.
   */
  recordPromotion(actionItemId: string, taskId: string): ActionItem {
    const stored = this.store.readActionItems();
    const current = stored.find((item) => item.id === actionItemId);
    if (!current) {
      throw new Error(`No Action Item with id ${actionItemId}`);
    }
    if (current.state === "promoted") return current;
    const at = this.now().toISOString();
    const next: ActionItem = {
      ...current,
      state: "promoted",
      promotedTaskId: taskId,
      updatedAt: at,
      decidedAt: at,
    };
    this.store.writeActionItems(stored.map((item) => (item.id === actionItemId ? next : item)));
    return next;
  }

  /**
   * Dismiss one pending Action Item (issue #179). Immediate and local-only:
   * no Task is created and no provider is reached — the proposal simply stops
   * being pending. Idempotent, so a double-clicked Dismiss is the same answer
   * rather than a second decision. A promoted Action Item is history and
   * cannot be dismissed.
   */
  dismiss(actionItemId: string): ActionItem {
    return this.decide(
      actionItemId,
      "dismissed",
      "That Action Item was already promoted and cannot be dismissed.",
    );
  }

  /**
   * Return one dismissed Action Item to pending (issue #179). This is both the
   * temporary Undo after a dismissal and the later restore from Debrief
   * history: the record keeps its identity, source, revision and proposal, and
   * only the decision is cleared. Idempotent while pending; a promoted Action
   * Item cannot be unpromoted.
   */
  restore(actionItemId: string): ActionItem {
    return this.decide(
      actionItemId,
      "pending",
      "That Action Item was already promoted and cannot be restored to pending.",
    );
  }

  /**
   * Move one Action Item between the two undecided states. Dismissal records
   * the decision time; restoration clears it. Already there is the same answer
   * rather than a second decision, and a promoted Action Item is history that
   * neither direction may rewrite.
   */
  private decide(actionItemId: string, to: "pending" | "dismissed", refused: string): ActionItem {
    const stored = this.store.readActionItems();
    const current = stored.find((item) => item.id === actionItemId);
    if (!current) {
      throw new TaskValidationError(
        "action-item-not-found",
        `No Action Item with id ${actionItemId}`,
      );
    }
    if (current.state === to) return current;
    if (current.state === "promoted") {
      throw new TaskValidationError("action-item-already-promoted", refused);
    }
    const at = this.now().toISOString();
    const next: ActionItem = {
      ...current,
      state: to,
      updatedAt: at,
      decidedAt: to === "dismissed" ? at : null,
    };
    this.store.writeActionItems(stored.map((item) => (item.id === actionItemId ? next : item)));
    return next;
  }

  get(actionItemId: string): ActionItem | null {
    return this.store.readActionItems().find((item) => item.id === actionItemId) ?? null;
  }

  private proposedResponsiblePerson(profileId: string | null): TaskResponsiblePerson | null {
    if (profileId === null) return null;
    return profileId === this.ownerProfileId()
      ? { kind: "owner" }
      : { kind: "person-profile", profileId };
  }
}

/** An unset filter matches everything; a set one has to be equal. */
function matches<T>(expected: T | undefined, actual: T): boolean {
  return expected === undefined || expected === actual;
}

/**
 * The revision this materialization writes. A Run with nothing held is on its
 * first extraction; otherwise a proposal nobody has seen means a new revision,
 * and a re-run of the same extraction means the one already recorded.
 */
function nextRevision(held: ActionItem[], input: ActionItemMaterialization): number {
  if (held.length === 0) return 1;
  const known = new Set(held.map((item) => item.id));
  const highest = held.reduce((max, item) => Math.max(max, item.extractionRevision), 1);
  const unseen = input.actionItems.some(
    (proposed) => !known.has(actionItemId(input.debriefRunId, proposed)),
  );
  return unseen ? highest + 1 : highest;
}

/**
 * Identity from content, not from position: the Debrief Run plus the
 * normalized title, inferred owner and due date. Reordering the model's output
 * produces the same ids, which is the whole reason review decisions survive
 * regeneration.
 */
function actionItemId(debriefRunId: string, proposed: MeetingDebriefActionItem): string {
  const material = [
    debriefRunId,
    normalize(proposed.title),
    normalize(proposed.owner ?? ""),
    proposed.dueDate ?? "",
  ].join("\u0000");
  return `action_item_${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
