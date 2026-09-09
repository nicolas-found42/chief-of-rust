import { TaskCutoverReceiptSchema } from "@chief-of-staff-demo/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionItem, Task, TaskList, TaskCutoverReceipt } from "@chief-of-staff-demo/shared";
import { atomicWriteJson } from "../engine/atomic.js";

/**
 * The Tasks product area's file-backed Workspace state (ADR-0058): Tasks, the
 * Task Lists they are filed into, and the Action Items a Meeting Debrief
 * proposed. No database and no event log — one trusted local user and the
 * agreed query volume do not justify a second persistence model.
 *
 * Like the Meetings store beside it, this holds nothing in memory: every call
 * re-reads the file and writes the whole list back atomically, so a Debrief
 * materializing Action Items and an owner completing a Task cannot lose each
 * other's writes.
 *
 * A file that exists and will not read as what it claims to be is refused, not
 * quietly narrowed to the records that still parse: every write persists the
 * whole list, so a silently shortened read is a silent deletion on the next
 * one.
 */
export class TaskStore {
  private readonly snapshotFile: string;
  private readonly tasksFile: string;
  private readonly listsFile: string;
  private readonly actionItemsFile: string;

  constructor(workspaceDir: string) {
    const dir = join(workspaceDir, "tasks");
    this.snapshotFile = join(dir, "state.json");
    this.tasksFile = join(dir, "tasks.json");
    this.listsFile = join(dir, "task-lists.json");
    this.actionItemsFile = join(dir, "action-items.json");
  }

  /**
   * Tasks written before Trash and External Task Links existed carry neither
   * field. They are filled in on the way out rather than rejected: an absent
   * field is a Task from an earlier version of this Workspace, not a damaged
   * record, and reading never writes.
   */
  readTasks(): Task[] {
    return this.read<Task>(this.tasksFile, "Task", isTask).map((task) => ({
      ...task,
      externalLink: task.externalLink ?? null,
      deletedAt: task.deletedAt ?? null,
    }));
  }

  writeTasks(tasks: Task[]): void {
    this.write("tasks", this.tasksFile, tasks);
  }

  readLists(): TaskList[] {
    return this.read<TaskList>(this.listsFile, "Task List", isTaskList);
  }

  writeLists(lists: TaskList[]): void {
    this.write("lists", this.listsFile, lists);
  }

  readActionItems(): ActionItem[] {
    return this.read<ActionItem>(this.actionItemsFile, "Action Item", isActionItem);
  }

  writeActionItems(items: ActionItem[]): void {
    this.write("actionItems", this.actionItemsFile, items);
  }

  cutoverReceipt(): TaskCutoverReceipt | null {
    return this.bundle()?.receipt ?? null;
  }

  /** One atomic publication: readers observe either all old records or all migrated records. */
  publishCutover(
    records: { tasks: Task[]; lists: TaskList[]; actionItems: ActionItem[] },
    receipt: TaskCutoverReceipt,
  ): void {
    atomicWriteJson(this.snapshotFile, { ...records, receipt });
  }

  private bundle(): {
    tasks: Task[];
    lists: TaskList[];
    actionItems: ActionItem[];
    receipt: TaskCutoverReceipt;
  } | null {
    if (!existsSync(this.snapshotFile)) return null;
    try {
      const value = JSON.parse(readFileSync(this.snapshotFile, "utf8")) as ReturnType<
        TaskStore["bundle"]
      >;
      if (
        !value ||
        !Array.isArray(value.tasks) ||
        !value.tasks.every(isTask) ||
        !Array.isArray(value.lists) ||
        !value.lists.every(isTaskList) ||
        !Array.isArray(value.actionItems) ||
        !value.actionItems.every(isActionItem) ||
        !TaskCutoverReceiptSchema.safeParse(value.receipt).success
      )
        throw new Error("invalid snapshot");
      return value;
    } catch {
      throw new TaskStoreCorruptionError(this.snapshotFile, "the canonical snapshot is unreadable");
    }
  }

  private write(
    key: "tasks" | "lists" | "actionItems",
    path: string,
    records: Task[] | TaskList[] | ActionItem[],
  ): void {
    const bundle = this.bundle();
    if (bundle) atomicWriteJson(this.snapshotFile, { ...bundle, [key]: records });
    else atomicWriteJson(path, records);
  }

  private read<T>(path: string, record: string, guard: (value: unknown) => value is T): T[] {
    const bundle = this.bundle();
    if (bundle)
      return (
        path === this.tasksFile
          ? bundle.tasks
          : path === this.listsFile
            ? bundle.lists
            : bundle.actionItems
      ) as T[];
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new TaskStoreCorruptionError(path, `the ${record} file is not valid JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new TaskStoreCorruptionError(path, `the ${record} file is not a list`);
    }
    /* Every entry, or none. Dropping the ones that fail the guard would read
       as a shorter list, and the next write — which persists the whole list —
       would then delete them for good. Refusing loudly keeps a damaged file
       recoverable. */
    const index = parsed.findIndex((entry) => !guard(entry));
    if (index !== -1) {
      throw new TaskStoreCorruptionError(path, `${record} ${index} is not a valid record`);
    }
    return parsed as T[];
  }
}

/**
 * A persisted file that exists and cannot be read as what it claims to be.
 * Explicit corruption, never an empty store: the difference between "you have
 * no Tasks" and "your Tasks are unreadable" is the whole point.
 */
export class TaskStoreCorruptionError extends Error {
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(`Workspace Tasks are unreadable: ${detail}`);
    this.name = "TaskStoreCorruptionError";
  }
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.listId === "string" &&
    typeof candidate.createdAt === "string" &&
    (candidate.status === "open" || candidate.status === "completed")
  );
}

function isTaskList(value: unknown): value is TaskList {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

function isActionItem(value: unknown): value is ActionItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.proposal === "object" &&
    typeof candidate.source === "object" &&
    (candidate.state === "pending" ||
      candidate.state === "promoted" ||
      candidate.state === "dismissed")
  );
}
