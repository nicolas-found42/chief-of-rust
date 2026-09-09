import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskCutoverPreview, TaskCutoverReceipt } from "@chief-of-staff-demo/shared";
import { readMigrationState } from "../migration/workspace.js";
import { openRuns } from "../runs.js";
import { TaskStore } from "./store.js";
import { WorkspaceTasks } from "./tasks.js";
import { WorkspaceActionItems } from "./action-items.js";
import { migrateLegacyTaskReceipts } from "./legacy-migration.js";
import type { GoogleTasksDestination, RemoteTaskConnector } from "./external-link.js";

interface CutoverDeps {
  workspaceDir: string;
  readRemote?: RemoteTaskConnector<GoogleTasksDestination>["read"];
  meetingIdFor?: (transcriptId: string) => string | null;
}

/** A local, non-destructive cutover. All preparation happens outside the Workspace;
 * one atomic file publication commits canonical records and their receipt together. */
export class TaskCutover {
  private executing: Promise<TaskCutoverReceipt> | null = null;
  constructor(private readonly deps: CutoverDeps) {}

  state(): "required" | "completed" | "fresh" {
    if (this.receipt()) return "completed";
    const runs = openRuns(this.deps.workspaceDir);
    const items = new TaskStore(this.deps.workspaceDir).readActionItems();
    for (const summary of runs.list({ module: "meeting-debrief" }).runs) {
      const run = runs.open(summary.id);
      const raw = run?.readArtifact("result.json");
      if (!raw) continue;
      try {
        const result = JSON.parse(raw) as { debrief?: { actionItems?: unknown[] } };
        if (
          result.debrief?.actionItems?.length &&
          !items.some((item) => item.source.debriefRunId === summary.id)
        )
          return "required";
      } catch {
        throw new Error("Unreadable historical Debrief; repair it before cutover");
      }
    }
    return readMigrationState(this.deps.workspaceDir);
  }

  receipt(): TaskCutoverReceipt | null {
    return new TaskStore(this.deps.workspaceDir).cutoverReceipt();
  }

  async preview(): Promise<TaskCutoverPreview> {
    const staged = await this.stage(false);
    return staged.preview;
  }

  execute(input: {
    workspace: string;
    fingerprint: string;
    typedConfirmation: string;
  }): Promise<TaskCutoverReceipt> {
    if (
      input.typedConfirmation !== "MIGRATE TASKS" ||
      input.workspace !== realpathSync(this.deps.workspaceDir)
    )
      return Promise.reject(new Error("Exact Workspace authorization required"));
    const receipt = this.receipt();
    if (receipt) return Promise.resolve(receipt);
    if (this.executing) return this.executing;
    this.executing = this.commit(input.fingerprint).finally(() => {
      this.executing = null;
    });
    return this.executing;
  }

  private async commit(fingerprint: string): Promise<TaskCutoverReceipt> {
    if (this.fingerprint() !== fingerprint) throw new Error("Workspace changed; preview again");
    const staged = await this.stage(true);
    if (staged.preview.fingerprint !== fingerprint || this.fingerprint() !== fingerprint)
      throw new Error("Workspace changed during staging; preview again");
    const receipt: TaskCutoverReceipt = {
      ...staged.preview,
      completedAt: new Date().toISOString(),
    };
    new TaskStore(this.deps.workspaceDir).publishCutover(staged.records, receipt);
    return receipt;
  }

  private async stage(refresh: boolean) {
    const fingerprint = this.fingerprint();
    const temporary = mkdtempSync(join(tmpdir(), "cos-task-stage-"));
    try {
      const original = join(this.deps.workspaceDir, "tasks");
      if (existsSync(original)) cpSync(original, join(temporary, "tasks"), { recursive: true });
      const store = new TaskStore(temporary);
      const existingTasks = store.readTasks().length;
      const existingActionItems = store.readActionItems().length;
      const tasks = new WorkspaceTasks({ store });
      const actionItems = new WorkspaceActionItems({ store });
      const configPath = join(this.deps.workspaceDir, "config.json");
      const config = existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, "utf8")) as { tasklistName?: string })
        : {};
      const runs = openRuns(this.deps.workspaceDir);
      await migrateLegacyTaskReceipts({
        runs,
        tasks,
        actionItems,
        ...(this.deps.meetingIdFor ? { meetingIdFor: this.deps.meetingIdFor } : {}),
        destination: {
          provider: "google-tasks",
          googleTaskListId: "",
          googleTaskListTitle: config.tasklistName ?? "Meeting Followups",
        },
        read:
          refresh && this.deps.readRemote
            ? this.deps.readRemote
            : async () => {
                throw Object.assign(new Error("Remote state awaits refresh"), { status: 503 });
              },
      });
      const records = {
        tasks: store.readTasks(),
        lists: store.readLists(),
        actionItems: store.readActionItems(),
      };
      const preview: TaskCutoverPreview = {
        kind: "canonical-tasks",
        workspace: realpathSync(this.deps.workspaceDir),
        fingerprint,
        counts: {
          legacyRuns: runs.list({ module: "meeting-debrief" }).runs.length,
          receipts: records.tasks.filter((task) => task.externalLink !== null).length,
          tasks: records.tasks.length,
          actionItems: records.actionItems.length,
          taskLists: records.lists.length,
          tasksToCreate: records.tasks.length - existingTasks,
          actionItemsToCreate: records.actionItems.length - existingActionItems,
        },
        authenticationPreserved: true,
        historicalRunsPreserved: true,
      };
      return { preview, records };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  private fingerprint(): string {
    const hash = createHash("sha256");
    const visit = (relative: string): void => {
      const path = join(this.deps.workspaceDir, relative);
      if (!existsSync(path)) return;
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const child = join(relative, entry.name);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) {
          hash.update(child);
          hash.update(readFileSync(join(this.deps.workspaceDir, child)));
        } else throw new Error("Workspace contains an unsupported filesystem entry");
      }
    };
    for (const file of ["config.json", "relay.json"]) {
      const path = join(this.deps.workspaceDir, file);
      if (existsSync(path)) {
        hash.update(file);
        hash.update(readFileSync(path));
      }
    }
    for (const directory of ["tasks", "runs"]) visit(directory);
    return hash.digest("hex");
  }
}
