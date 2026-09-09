/**
 * The Workspace's durable record of accepted work (ADR-0052, ADR-0054).
 *
 * A Task is canonical: it is created manually or promoted from an Action Item,
 * it is managed entirely without any external account, and an External Task
 * Link — when one exists at all — is a representation of it, never its source
 * of truth. Nothing here names a provider.
 *
 * A Task is also a snapshot. It survives deletion of the Meeting, Meeting
 * Debrief or Transcript it came from: `source` is a reference the surfaces
 * report as unavailable rather than a dependency that can take the Task with
 * it.
 */

/** The workspace owner's local ranking. Never mapped to a provider field. */
export const TASK_PRIORITIES = ["none", "low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type TaskStatus = "open" | "completed";

/**
 * Inbox always exists and is the default Task List, so every Task has a valid
 * destination without the owner configuring one. Its identity is fixed rather
 * than minted, so a Workspace that has never written a Task List file still
 * has an Inbox to file into.
 */
export const INBOX_TASK_LIST_ID = "inbox" as const;
export const INBOX_TASK_LIST_NAME = "Inbox" as const;

/**
 * The external system and container a new Task is delivered to. `local` is the
 * default and creates no External Task Link — an outward write never happens
 * by accident. Google Tasks and Asana are the two destinations, each carrying
 * the container fields that identify where the Task goes.
 */
export type TaskDestination =
  | { provider: "local" }
  | {
      /**
       * Google Tasks, which is enabled independently of the rest of the Google
       * connection (issue #184). The container is one Google Task List the
       * owner selected; nothing is ever read back out of it.
       */
      provider: "google-tasks";
      googleTaskListId: string;
      googleTaskListTitle: string;
    }
  | {
      /**
       * Asana, connected with a person-supplied personal access token (issue
       * #189). The container is one workspace, one project inside it, and an
       * optional section inside that project. Asana's gids are stored, never
       * interpreted; a Responsible Person is never mapped to an assignee.
       */
      provider: "asana";
      workspaceGid: string;
      workspaceName: string;
      projectGid: string;
      projectName: string;
      /** Null when the Task goes to the project's default section. */
      sectionGid: string | null;
      sectionName: string | null;
    };

export const LOCAL_TASK_DESTINATION: TaskDestination = { provider: "local" };

/**
 * How far one Task's outward representation has got. A local Task commits
 * before any external write, so `waiting` and `failed` are ordinary states of
 * a Task that is entirely usable — never a reason to refuse the local work.
 * `missing` means the provider no longer holds the remote record; the local
 * Task is intact and the owner recreates the record or removes the link.
 */
export type ExternalTaskLinkState =
  | "waiting"
  | "synchronized"
  | "failed"
  | "missing"
  /**
   * The provider's copy of the title, notes or due date has been edited
   * outside the Workspace (issue #186). The canonical Task is untouched —
   * an outside edit never silently replaces accepted content — and both
   * projections are available until the owner restores the app version or
   * accepts the external one.
   */
  | "changed-externally"
  /**
   * Both sides changed completion since the last baseline (issue #186).
   * Neither wins implicitly: the owner picks the app status or the external
   * one, and the link stays conflicted until the chosen operation succeeds.
   */
  | "conflicted";

/**
 * The one representation a Task may have in an external system (ADR-0056).
 * Provider-neutral by construction: the Workspace record is the source of
 * truth, and this is a pointer to a copy of it.
 */
export interface ExternalTaskLink {
  /** Persisted before create; an unacknowledged create must never be repeated blindly. */
  creationUncertain?: boolean;
  state: ExternalTaskLinkState;
  destination: TaskDestination;
  /**
   * The external system's own id; null while waiting or after a failure.
   * Kept while missing, so the link still names the record that went away.
   */
  remoteId: string | null;
  /** A link a person can open; null when the provider returned none. */
  url: string | null;
  /**
   * What the Workspace last sent outward. Synchronization compares against
   * this rather than against the live Task, which is how an external edit is
   * told apart from a local one.
   */
  baseline: ExternalTaskBaseline | null;
  /**
   * The provider's own projection, captured when drift or a conflict was
   * detected (issue #186); null at every other time. This is the second half
   * of "both projections available": `baseline` says what the Workspace last
   * sent, this says what the provider holds now, and the Task itself says
   * what the Workspace means — three readings the owner chooses between
   * rather than one the app picks for them.
   */
  external: ExternalTaskBaseline | null;
  /**
   * Why the last attempt failed, as a classified fact and the sentence that
   * carries it (ADR-0030: callers branch on the kind, never by matching the
   * message); null when the last attempt did not fail.
   */
  failure: TaskLinkFailure | null;
  updatedAt: string;
}

/**
 * One classified provider failure on an External Task Link (issue #185).
 * The kind is the fact retry policy branches on — an `authorization`
 * failure pauses automatic retry until reconnection, `not-found` becomes a
 * missing link, the rest stay transient — and the message is the sanitized
 * sentence a person reads. No provider body, URL, or credential survives
 * into either field.
 */
export type TaskLinkFailureKind =
  "authorization" | "validation" | "network" | "rate-limit" | "not-found" | "unavailable";

export interface TaskLinkFailure {
  /** Non-secret credential revision that failed; reconnect is a different revision. */
  authorizationRevision?: string;
  kind: TaskLinkFailureKind;
  message: string;
}

/** The fields the Workspace sends outward, as they were last sent. */
export interface ExternalTaskBaseline {
  title: string;
  notes: string;
  dueDate: string | null;
  status: TaskStatus;
}

/**
 * Who is expected to perform a Task: the workspace owner, or one confirmed
 * Person Profile. This records responsibility only — it grants no access, no
 * notification, and no provider assignment.
 */
export type TaskResponsiblePerson =
  { kind: "owner" } | { kind: "person-profile"; profileId: string };

/**
 * Where an accepted Task came from. Null for a Task captured by hand, which is
 * the whole point of the field: a manual Task has no source to be unavailable.
 */
export interface TaskSource {
  kind: "action-item";
  actionItemId: string;
  debriefRunId: string;
  transcriptId: string;
  meetingId: string | null;
}

export interface Task {
  /** Workspace identity. Stable across every edit, and never derived from position. */
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  /** Date-only `YYYY-MM-DD`, read as a calendar date in the Workspace timezone. */
  dueDate: string | null;
  priority: TaskPriority;
  /** Exactly one Task List. Inbox when the owner chose none. */
  listId: string;
  responsiblePerson: TaskResponsiblePerson | null;
  /** Resolved once at creation from the list default or an explicit override. */
  destination: TaskDestination;
  source: TaskSource | null;
  /**
   * At most one external representation, ever (ADR-0056). Null for a Task that
   * has none, which is every Task filed to a local destination.
   */
  externalLink: ExternalTaskLink | null;
  createdAt: string;
  updatedAt: string;
  /** Set while `status` is completed, cleared when the Task is reopened. */
  completedAt: string | null;
  /**
   * When the Task was moved to Trash; null while it is not. Orthogonal to
   * `status`, which is what lets a restore return a Task to the open or
   * completed state it already had rather than guessing one.
   */
  deletedAt: string | null;
}

/**
 * One named collection of Tasks. Inbox is present in every Workspace and
 * cannot be renamed or deleted; every other list is the owner's own.
 */
export interface TaskList {
  id: string;
  name: string;
  /** Applied to Tasks filed here unless the creation names its own destination. */
  defaultDestination: TaskDestination;
}

/** Quick Add needs only a title; every other field has a defensible default. */
export interface TaskCreateInput {
  title: string;
  notes?: string;
  dueDate?: string | null;
  priority?: TaskPriority;
  listId?: string;
  responsiblePerson?: TaskResponsiblePerson | null;
  /** Overrides the Task List's default for this Task only. */
  destination?: TaskDestination;
}

/**
 * The mutable fields. Identity, source, creation time and destination are not
 * among them: editing a Task must never look like replacing it.
 */
export interface TaskUpdateInput {
  title?: string;
  notes?: string;
  dueDate?: string | null;
  priority?: TaskPriority;
  listId?: string;
  responsiblePerson?: TaskResponsiblePerson | null;
}

/**
 * The candidate a Possible duplicate check compares (issue #180): exactly the
 * tuple the warning matches on. Everything else about a Task — notes, list,
 * priority, destination — says nothing about whether two records are the same
 * work, so none of it takes part.
 */
export type TaskDuplicateCandidate = Pick<
  TaskCreateInput,
  "title" | "dueDate" | "responsiblePerson"
>;

/** What the check answers: the open Tasks the candidate would duplicate. */
export interface TaskDuplicateCheck {
  duplicates: Task[];
}

/** What the Tasks product reads: the Tasks and the lists they are filed into. */
export interface TaskIndex {
  tasks: Task[];
  lists: TaskList[];
  /**
   * Today as a calendar date in the Workspace timezone. Served rather than
   * computed by the surface, so a date-only Task near a UTC boundary lands in
   * the group the owner's own day puts it in.
   */
  today: string;
  /**
   * The ids of Tasks whose source no longer exists. A Task survives the
   * deletion of what it came from (ADR-0054), and this is how a surface says
   * so out loud instead of offering a link into nothing.
   */
  unavailableSources: string[];
}

/**
 * What happens to a freshly materialized Action Item (ADR-0053, issue #181).
 *
 * `stage-all` is every Workspace's default: a model proposal waits for a
 * person. `auto-create-mine` is the owner's deliberate exception, and it is
 * deliberately narrow — only a first extraction's commitments that the
 * Debrief confidently resolved to the confirmed owner, and only ones no open
 * Task already duplicates, become Tasks without review.
 */
export const ACTION_ITEM_POLICIES = ["stage-all", "auto-create-mine"] as const;
export type ActionItemPolicy = (typeof ACTION_ITEM_POLICIES)[number];
