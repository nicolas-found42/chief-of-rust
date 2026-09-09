import { randomBytes } from "node:crypto";
import type {
  ExternalTaskLink,
  Task,
  TaskCreateInput,
  TaskDestination,
  TaskDuplicateCandidate,
  TaskList,
  TaskPriority,
  TaskResponsiblePerson,
  TaskSource,
  TaskStatus,
  TaskUpdateInput,
} from "@chief-of-staff-demo/shared";
import {
  INBOX_TASK_LIST_ID,
  INBOX_TASK_LIST_NAME,
  LOCAL_TASK_DESTINATION,
  TASK_PRIORITIES,
  compareTasks,
} from "@chief-of-staff-demo/shared";
import type { TaskStore } from "./store.js";

/** A refused Task operation, named by a stable code the surfaces render. */
export class TaskValidationError extends Error {
  constructor(
    public readonly code:
      | "invalid-title"
      | "invalid-notes"
      | "invalid-list-name"
      | "invalid-due-date"
      | "invalid-priority"
      | "invalid-responsible-person"
      | "invalid-destination"
      | "invalid-token"
      | "task-list-not-found"
      | "task-list-not-empty"
      | "inbox-is-permanent"
      | "task-not-found"
      | "task-not-in-trash"
      | "link-not-drifted"
      | "link-not-conflicted"
      | "confirmation-required"
      | "task-already-linked"
      | "task-not-linked"
      | "link-not-missing"
      | "action-item-not-found"
      | "action-item-already-promoted"
      | "action-item-dismissed",
    message: string,
  ) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export interface WorkspaceTasksDeps {
  store: TaskStore;
  now?: () => Date;
  /**
   * Whether one Person Profile may carry responsibility: it has to exist and
   * be confirmed. Responsibility is recorded against canonical identity, never
   * against a name typed into a field. Absent, only the owner is available —
   * which is what a Workspace with no Profile directory can honestly offer.
   */
  isConfirmedPerson?: (profileId: string) => boolean;
  /**
   * The Workspace timezone, read live. Due dates are calendar dates, so which
   * day "today" is has to be decided somewhere — and it is decided here, once,
   * rather than in every surface that draws a group.
   */
  timezone?: () => string;
  /**
   * Whether Google Tasks is enabled as a Task Destination right now (issue
   * #184). Read live rather than captured, so disabling it stops new Tasks
   * being filed outward without restarting anything. Absent — the honest
   * default — local is the only destination there is.
   */
  isGoogleTasksEnabled?: () => boolean;
  /**
   * Whether Asana is enabled as a Task Destination right now (issue #189).
   * Live, like the Google Tasks gate above: an outward destination is a
   * decision the Workspace can take back, and the next Task must read the
   * decision of the moment, not the decision of boot. Absent, Asana is not
   * a destination at all.
   */
  isAsanaEnabled?: () => boolean;
}

/**
 * Which Responsible Person a query narrows to: the owner, nobody, or one
 * Person Profile. A separate union rather than `TaskResponsiblePerson | null`,
 * because "nobody" is a filter value here and an absent filter is not.
 */
export type ResponsibleFilter =
  { kind: "owner" } | { kind: "nobody" } | { kind: "person-profile"; profileId: string };

/** What a Task query narrows on. Everything is optional; nothing is required. */
export interface TaskQuery {
  listId?: string;
  status?: TaskStatus;
  /** Trashed Tasks are excluded unless this asks for them, and then only them. */
  trashed?: boolean;
  /** Case-insensitive, over title and notes. */
  search?: string;
  priority?: TaskPriority;
  responsible?: ResponsibleFilter;
  /** Whether the Task carries an External Task Link. */
  linked?: boolean;
}

/**
 * The Tasks product area's Workspace-owned interface (ADR-0052).
 *
 * One deep module over the file store: Task capture, editing, completion and
 * Task List management, with every refusal named rather than thrown as a bare
 * string. No provider is reachable from here — a local Task operation succeeds
 * or fails on the Workspace write alone, which is exactly why the product
 * works with no external account at all.
 */
export class WorkspaceTasks {
  private readonly store: TaskStore;
  private readonly now: () => Date;
  private readonly isConfirmedPerson: (profileId: string) => boolean;
  private readonly timezone: () => string;
  private readonly isGoogleTasksEnabled: () => boolean;
  private readonly isAsanaEnabled: () => boolean;

  constructor(deps: WorkspaceTasksDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.isConfirmedPerson = deps.isConfirmedPerson ?? (() => false);
    this.timezone = deps.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.isGoogleTasksEnabled = deps.isGoogleTasksEnabled ?? (() => false);
    this.isAsanaEnabled = deps.isAsanaEnabled ?? (() => false);
  }

  // ---------------------------------------------------------------------------
  // Task Lists
  // ---------------------------------------------------------------------------

  /**
   * Inbox first, then the owner's own lists in creation order. Inbox is
   * synthesized when nothing has persisted it, so a Workspace that has never
   * written a Task List file still reports the list every Task can be filed
   * into. Reading never writes.
   */
  lists(): TaskList[] {
    const persisted = this.store.readLists();
    const inbox = persisted.find((list) => list.id === INBOX_TASK_LIST_ID) ?? {
      id: INBOX_TASK_LIST_ID,
      name: INBOX_TASK_LIST_NAME,
      defaultDestination: LOCAL_TASK_DESTINATION,
    };
    return [inbox, ...persisted.filter((list) => list.id !== INBOX_TASK_LIST_ID)];
  }

  getList(listId: string): TaskList | null {
    return this.lists().find((list) => list.id === listId) ?? null;
  }

  createList(input: { name: string; defaultDestination?: TaskDestination }): TaskList {
    const list: TaskList = {
      id: newId("list", this.now()),
      name: requireName(input.name),
      defaultDestination: this.normalizeDestination(input.defaultDestination),
    };
    /* `lists()` carries Inbox, synthesized or not, so the first list the owner
       creates is also what persists Inbox for the first time. */
    this.store.writeLists([...this.lists(), list]);
    return list;
  }

  /**
   * Change one list. Both fields together, in one write: a rejected rename
   * must not leave a destination change persisted behind it.
   *
   * A name belongs to the owner's own lists only — Inbox has to stay
   * recognizable as the default every Task falls back to — while any list,
   * Inbox included, may name a default Task Destination. That default reaches
   * newly created Tasks only: an existing Task resolved its destination when
   * it was created, and the list changing its mind afterwards must not
   * silently redirect work already accepted.
   */
  updateList(
    listId: string,
    input: { name?: string; defaultDestination?: TaskDestination },
  ): TaskList {
    const lists = this.lists();
    const current = lists.find((list) => list.id === listId);
    if (!current) {
      throw new TaskValidationError("task-list-not-found", `No Task List with id ${listId}`);
    }
    if (input.name !== undefined && listId === INBOX_TASK_LIST_ID) {
      throw new TaskValidationError("inbox-is-permanent", "Inbox cannot be renamed");
    }
    const next: TaskList = {
      ...current,
      ...(input.name === undefined ? {} : { name: requireName(input.name) }),
      ...(input.defaultDestination === undefined
        ? {}
        : { defaultDestination: this.normalizeDestination(input.defaultDestination) }),
    };
    this.store.writeLists(lists.map((list) => (list.id === listId ? next : list)));
    return next;
  }

  /**
   * Delete an empty list of the owner's own. A non-empty list is refused
   * rather than emptied: its Tasks have to be moved or deleted deliberately,
   * so no accepted work disappears with a container.
   */
  deleteList(listId: string): void {
    if (listId === INBOX_TASK_LIST_ID) {
      throw new TaskValidationError("inbox-is-permanent", "Inbox cannot be deleted");
    }
    const lists = this.lists();
    if (!lists.some((list) => list.id === listId)) {
      throw new TaskValidationError("task-list-not-found", `No Task List with id ${listId}`);
    }
    const held = this.store.readTasks().filter((task) => task.listId === listId);
    if (held.length > 0) {
      throw new TaskValidationError(
        "task-list-not-empty",
        `That Task List still holds ${held.length} Task${held.length === 1 ? "" : "s"}. Move or delete them first.`,
      );
    }
    this.store.writeLists(lists.filter((list) => list.id !== listId));
  }

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  /**
   * The Tasks a query selects, in the default order: due date, then
   * high/medium/low/no priority, then oldest first (issue #175).
   *
   * Trash is opt-in and exclusive. A trashed Task is not a Task with an extra
   * flag to be remembered at every call site — it is out of the ordinary
   * results until something asks for Trash by name.
   */
  list(query: TaskQuery = {}): Task[] {
    const term = query.search?.trim().toLowerCase() ?? "";
    return this.store
      .readTasks()
      .filter(
        (task) =>
          (query.trashed === true) === (task.deletedAt !== null) &&
          matches(query.listId, task.listId) &&
          matches(query.status, task.status) &&
          matches(query.priority, task.priority) &&
          matches(query.linked, task.externalLink !== null) &&
          responsibleMatches(query.responsible, task.responsiblePerson) &&
          (term === "" ||
            task.title.toLowerCase().includes(term) ||
            task.notes.toLowerCase().includes(term)),
      )
      .sort(compareTasks);
  }

  /**
   * Today as a calendar date in the Workspace timezone. `en-CA` because it
   * formats as `YYYY-MM-DD`, which is the same shape a due date is stored in
   * and therefore comparable as a string.
   */
  today(now = this.now()): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }

  get(taskId: string): Task | null {
    return this.store.readTasks().find((task) => task.id === taskId) ?? null;
  }

  /**
   * The open Tasks a would-be Task would duplicate (issue #180): an exact
   * match on the normalized title, the Responsible Person, and the due date.
   * Only open work can be duplicated — a completed or trashed Task is
   * history, not a competing commitment. The answer feeds a warning and
   * nothing else: this method refuses no one and creates nothing, because
   * whether two similarly-described commitments are really the same work is
   * the owner's judgment, not the Workspace's.
   */
  findDuplicates(candidate: TaskDuplicateCandidate): Task[] {
    const title = normalizedTitle(requireTitle(candidate.title));
    const dueDate = requireDueDate(candidate.dueDate ?? null);
    /* Absent, like in `create`: the owner. `null` stays Nobody. */
    const responsible: TaskResponsiblePerson | null =
      candidate.responsiblePerson === undefined ? { kind: "owner" } : candidate.responsiblePerson;
    return this.store
      .readTasks()
      .filter(
        (task) =>
          task.status === "open" &&
          task.deletedAt === null &&
          task.dueDate === dueDate &&
          normalizedTitle(task.title) === title &&
          sameResponsiblePerson(task.responsiblePerson, responsible),
      )
      .sort(compareTasks);
  }

  /**
   * Capture one Task. Quick Add supplies a title and nothing else; the
   * defaults are Inbox, the workspace owner, open, no due date and no
   * priority, with the destination taken from the Task List unless this
   * creation overrides it.
   *
   * A source is supplied only by a promotion (issue #178), which is the one
   * caller that has one: a Task captured by hand has nothing to be a snapshot
   * of, and no route lets a request name a source of its own.
   */
  create(input: TaskCreateInput, source: TaskSource | null = null): Task {
    const title = requireTitle(input.title);
    const listId = input.listId ?? INBOX_TASK_LIST_ID;
    const list = this.getList(listId);
    if (!list) {
      throw new TaskValidationError("task-list-not-found", `No Task List with id ${listId}`);
    }
    const at = this.now().toISOString();
    const task: Task = {
      id: newId("task", this.now()),
      title,
      notes: requireNotes(input.notes ?? ""),
      status: "open",
      dueDate: requireDueDate(input.dueDate ?? null),
      priority: requirePriority(input.priority ?? "none"),
      listId,
      responsiblePerson: this.requireResponsiblePerson(
        input.responsiblePerson === undefined ? { kind: "owner" } : input.responsiblePerson,
      ),
      destination: this.normalizeDestination(input.destination ?? list.defaultDestination),
      source: source,
      externalLink: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      deletedAt: null,
    };
    this.store.writeTasks([...this.store.readTasks(), task]);
    return task;
  }

  /**
   * Edit the mutable fields. Identity, source, creation time and destination
   * are untouched by construction: accepted work evolves independently of
   * whatever proposed it, and an edit is never a replacement.
   */
  update(taskId: string, input: TaskUpdateInput): Task {
    return this.edit(taskId, (task) => {
      const next: Task = { ...task };
      if (input.title !== undefined) next.title = requireTitle(input.title);
      if (input.notes !== undefined) next.notes = requireNotes(input.notes);
      if (input.dueDate !== undefined) next.dueDate = requireDueDate(input.dueDate);
      if (input.priority !== undefined) next.priority = requirePriority(input.priority);
      if (input.listId !== undefined) {
        if (!this.getList(input.listId)) {
          throw new TaskValidationError(
            "task-list-not-found",
            `No Task List with id ${input.listId}`,
          );
        }
        next.listId = input.listId;
      }
      if (input.responsiblePerson !== undefined) {
        next.responsiblePerson = this.requireResponsiblePerson(input.responsiblePerson);
      }
      return next;
    });
  }

  /** Idempotent: completing a completed Task keeps its original completion time. */
  complete(taskId: string): Task {
    return this.edit(taskId, (task) =>
      task.status === "completed"
        ? task
        : { ...task, status: "completed", completedAt: this.now().toISOString() },
    );
  }

  /** Idempotent, and the reverse of completion: the completion time is cleared. */
  reopen(taskId: string): Task {
    return this.edit(taskId, (task) =>
      task.status === "open" ? task : { ...task, status: "open", completedAt: null },
    );
  }

  /**
   * Move a Task to Trash. Recoverable by construction: nothing is removed and
   * `status` is left exactly as it was, which is what lets a restore return
   * the Task to the open or completed state it already had (ADR-0054).
   */
  trash(taskId: string): Task {
    return this.edit(taskId, (task) =>
      task.deletedAt === null ? { ...task, deletedAt: this.now().toISOString() } : task,
    );
  }

  /** The reverse, and idempotent: a Task not in Trash is already restored. */
  restore(taskId: string): Task {
    return this.edit(taskId, (task) =>
      task.deletedAt === null ? task : { ...task, deletedAt: null },
    );
  }

  /**
   * Remove a Task for good. Only from Trash, and only when the caller says so
   * in as many words: this is the one Task operation with nothing behind it,
   * so an accidental one has to be impossible rather than merely unlikely.
   */
  deleteForever(taskId: string, options: { confirmed: boolean }): void {
    const tasks = this.store.readTasks();
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new TaskValidationError("task-not-found", `No Task with id ${taskId}`);
    }
    if (task.deletedAt === null) {
      throw new TaskValidationError(
        "task-not-in-trash",
        "Only a Task in Trash can be permanently deleted. Move it to Trash first.",
      );
    }
    if (!options.confirmed) {
      throw new TaskValidationError(
        "confirmation-required",
        "Permanent deletion cannot be undone and has to be confirmed explicitly.",
      );
    }
    this.store.writeTasks(tasks.filter((candidate) => candidate.id !== taskId));
  }

  /**
   * Record the one External Task Link a Task may have (ADR-0056, #185).
   * Refused when the Task already carries a link whose record Google may
   * still hold — a synchronized link, or a failed outward write on top of
   * one: two live records must never answer for one piece of accepted work.
   * A link with no remote id reached nothing Google kept, and a missing
   * link's record is gone by definition, so writing over either is the
   * attempt being recorded (or the replacement `recreate` promised), not a
   * second link.
   *
   * Only the link changes, and only through here: the outward write happens
   * after the local commit, so this is always an update to a Task that
   * already exists and is already usable.
   */
  recordExternalLink(taskId: string, link: Omit<ExternalTaskLink, "updatedAt">): Task {
    return this.edit(taskId, (task) => {
      const existing = task.externalLink;
      if (
        existing !== null &&
        (existing.state === "synchronized" ||
          (existing.state === "failed" && existing.remoteId !== null))
      ) {
        throw new TaskValidationError(
          "task-already-linked",
          "That Task already has an External Task Link.",
        );
      }
      return {
        ...task,
        destination: link.destination,
        externalLink: { ...link, updatedAt: this.now().toISOString() },
      };
    });
  }
  /**
   * Overwrite the External Task Link a synchronization step just resolved
   * (issue #185). Unlike creation above, this runs on a Task that already
   * carries a link — pushing a completion, recording a failure, or marking
   * the remote record missing all rewrite the link rather than adding one.
   */
  refreshExternalLink(taskId: string, link: Omit<ExternalTaskLink, "updatedAt">): Task {
    return this.edit(taskId, (task) => {
      if (task.externalLink === null) {
        throw new TaskValidationError(
          "task-not-linked",
          "That Task has no External Task Link to update.",
        );
      }
      return { ...task, externalLink: { ...link, updatedAt: this.now().toISOString() } };
    });
  }

  /**
   * Remove the External Task Link while keeping the Task (issue #185).
   * Idempotent: removing a link that is already gone is the same Task.
   * Never reaches the provider, so the remote record is preserved by
   * construction rather than by asking it to survive.
   */
  clearExternalLink(taskId: string): Task {
    return this.edit(taskId, (task) =>
      task.externalLink === null ? task : { ...task, externalLink: null },
    );
  }

  // ---------------------------------------------------------------------------

  private edit(taskId: string, change: (task: Task) => Task): Task {
    const tasks = this.store.readTasks();
    const current = tasks.find((task) => task.id === taskId);
    if (!current) {
      throw new TaskValidationError("task-not-found", `No Task with id ${taskId}`);
    }
    const changed = change(current);
    if (changed === current) return current;
    const next: Task = { ...changed, updatedAt: this.now().toISOString() };
    this.store.writeTasks(tasks.map((task) => (task.id === taskId ? next : task)));
    return next;
  }

  /**
   * `unknown` rather than the typed shape: this runs over a request body, and
   * the profile it names has to be a Profile this Workspace actually holds.
   */
  private requireResponsiblePerson(value: unknown): TaskResponsiblePerson | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "object") {
      const candidate = value as { kind?: unknown; profileId?: unknown };
      if (candidate.kind === "owner") return { kind: "owner" };
      if (
        candidate.kind === "person-profile" &&
        typeof candidate.profileId === "string" &&
        this.isConfirmedPerson(candidate.profileId)
      ) {
        return { kind: "person-profile", profileId: candidate.profileId };
      }
    }
    throw new TaskValidationError(
      "invalid-responsible-person",
      "A Responsible Person is the workspace owner or a confirmed Person Profile.",
    );
  }

  /**
   * Local only until the owner enables an external Task Destination (issues
   * #184, #189): an outward write is a decision, and a request naming a
   * provider the Workspace is not connected to is refused rather than
   * downgraded silently to local.
   */
  private normalizeDestination(value: unknown): TaskDestination {
    if (value === undefined) return LOCAL_TASK_DESTINATION;
    const candidate = (typeof value === "object" && value !== null ? value : {}) as {
      provider?: unknown;
      googleTaskListId?: unknown;
      googleTaskListTitle?: unknown;
      workspaceGid?: unknown;
      workspaceName?: unknown;
      projectGid?: unknown;
      projectName?: unknown;
      sectionGid?: unknown;
      sectionName?: unknown;
    };
    if (candidate.provider === "local") return LOCAL_TASK_DESTINATION;
    if (
      candidate.provider === "google-tasks" &&
      typeof candidate.googleTaskListId === "string" &&
      candidate.googleTaskListId !== "" &&
      typeof candidate.googleTaskListTitle === "string"
    ) {
      if (!this.isGoogleTasksEnabled()) {
        throw new TaskValidationError(
          "invalid-destination",
          "Google Tasks is not enabled as a Task Destination.",
        );
      }
      return {
        provider: "google-tasks",
        googleTaskListId: candidate.googleTaskListId,
        googleTaskListTitle: candidate.googleTaskListTitle,
      };
    }
    if (
      candidate.provider === "asana" &&
      typeof candidate.workspaceGid === "string" &&
      candidate.workspaceGid !== "" &&
      typeof candidate.workspaceName === "string" &&
      typeof candidate.projectGid === "string" &&
      candidate.projectGid !== "" &&
      typeof candidate.projectName === "string"
    ) {
      /* A section is either properly absent or completely named: a gid without
         the name (or the reverse) is not a destination anyone chose. */
      const sectionGid =
        typeof candidate.sectionGid === "string" && candidate.sectionGid !== ""
          ? candidate.sectionGid
          : null;
      const sectionName =
        sectionGid !== null && typeof candidate.sectionName === "string"
          ? candidate.sectionName
          : null;
      if ((sectionGid !== null) !== (sectionName !== null)) {
        throw new TaskValidationError("invalid-destination", "That is not a Task Destination.");
      }
      if (!this.isAsanaEnabled()) {
        throw new TaskValidationError(
          "invalid-destination",
          "Asana is not enabled as a Task Destination.",
        );
      }
      return {
        provider: "asana",
        workspaceGid: candidate.workspaceGid,
        workspaceName: candidate.workspaceName,
        projectGid: candidate.projectGid,
        projectName: candidate.projectName,
        sectionGid,
        sectionName,
      };
    }
    throw new TaskValidationError("invalid-destination", "That is not a Task Destination.");
  }
}

/** An unset filter matches everything; a set one has to be equal. */
function matches<T>(expected: T | undefined, actual: T): boolean {
  return expected === undefined || expected === actual;
}

/** An unset Responsible Person filter matches everything; "nobody" matches null. */
function responsibleMatches(
  expected: ResponsibleFilter | undefined,
  actual: TaskResponsiblePerson | null,
): boolean {
  if (expected === undefined) return true;
  if (expected.kind === "nobody") return actual === null;
  if (actual === null) return false;
  if (expected.kind === "owner") return actual.kind === "owner";
  return actual.kind === "person-profile" && actual.profileId === expected.profileId;
}

/** Identity for Responsible Person: the owner, nobody, or the same Profile. */
function sameResponsiblePerson(
  a: TaskResponsiblePerson | null,
  b: TaskResponsiblePerson | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "owner" || b.kind === "owner") {
    return a.kind === "owner" && b.kind === "owner";
  }
  return a.profileId === b.profileId;
}

/**
 * A title reduced to what the duplicate comparison treats as its identity:
 * trimmed, lowercased, inner whitespace collapsed. So "Call Dana", "call dana"
 * and "Call  Dana" are one title. Both sides of the comparison go through
 * here, which is what keeps them in lockstep.
 */
function normalizedTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function requireTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (title === "") {
    throw new TaskValidationError("invalid-title", "A Task needs a title.");
  }
  return title;
}

function requireName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "") {
    throw new TaskValidationError("invalid-list-name", "A Task List needs a name.");
  }
  return name;
}

function requireNotes(value: unknown): string {
  if (typeof value !== "string") {
    throw new TaskValidationError("invalid-notes", "Notes are text.");
  }
  return value;
}

/**
 * A date-only calendar date, read in the Workspace timezone. `2026-02-30`
 * parses as a shape and is still not a day, so the round trip through UTC is
 * what actually decides.
 */
function requireDueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) {
      return value;
    }
  }
  throw new TaskValidationError("invalid-due-date", "A due date is a calendar date, YYYY-MM-DD.");
}

function requirePriority(value: unknown): TaskPriority {
  if (TASK_PRIORITIES.includes(value as TaskPriority)) return value as TaskPriority;
  throw new TaskValidationError(
    "invalid-priority",
    `Task Priority is one of ${TASK_PRIORITIES.join(", ")}.`,
  );
}

function newId(prefix: "task" | "list", now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}
