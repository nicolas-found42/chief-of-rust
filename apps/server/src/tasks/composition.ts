import { createHash } from "node:crypto";
import type { ConfigStore } from "../config.js";
import type { GoogleConnectionState } from "@chief-of-staff-demo/shared";
import type { GoogleConnection } from "../google/connection.js";
import {
  deleteGoogleTask,
  getGoogleTask,
  insertGoogleTask,
  listGoogleTaskLists,
  setGoogleTaskContent,
  setGoogleTaskStatus,
} from "../google/tasks.js";
import {
  asanaMe,
  createAsanaTask,
  deleteAsanaTask,
  getAsanaTask,
  listAsanaProjects,
  listAsanaSections,
  setAsanaTaskContent,
  setAsanaTaskStatus,
} from "../asana/client.js";
import { AsanaLinking } from "./asana-link.js";
import {
  TaskLinking,
  type AsanaDestination,
  type GoogleTasksDestination,
  type RemoteTaskConnector,
} from "./external-link.js";
import { WorkspaceActionItems, type ActionItemMaterialization } from "./action-items.js";
import { materializeUnderPolicy } from "./auto-promotion.js";
import { TaskStore } from "./store.js";
import { WorkspaceTasks } from "./tasks.js";

/**
 * What the Shell hands the Tasks product, and nothing more: Workspace handles,
 * credentials, and the identity and timezone questions only the Workspace can
 * answer. Everything inside — the store, the two Workspace interfaces, the
 * provider adapters, and the promotion policy — is this module's own, so the
 * Shell holds a handle rather than the graph (ADR-0052, issue #200).
 */
export interface TasksCompositionDeps {
  workspaceDir: string;
  configStore: ConfigStore;
  googleConnection: GoogleConnection;
  /** Why a Google call cannot be made right now, in the Shell's own words. */
  googleFailureHint: (state: GoogleConnectionState) => string;
  /** Whether a Profile is one responsibility may be recorded against. */
  isConfirmedPerson: (profileId: string) => boolean;
  /** The confirmed owner's Profile, for owner-assigned proposals; null until confirmed. */
  ownerProfileId: () => string | null;
  /** The Workspace timezone a date-only due date is read in. */
  timezone: () => string;
  /** Called before a materialization commits, so derived briefings can go stale. */
  onActionItemsChanged?: () => void;
  log?: (message: string) => void;
}

/** The Tasks product as one handle. Routes and ordering stay with the Shell. */
export interface TasksComposition {
  tasks: WorkspaceTasks;
  actionItems: WorkspaceActionItems;
  linking: TaskLinking;
  asanaLinking: AsanaLinking;
  /** The Google Tasks connector, for the one caller outside linking: receipt migration. */
  googleConnector: RemoteTaskConnector<GoogleTasksDestination>;
  /** Materialize a Debrief's proposals under the Action Item Policy (issue #181). */
  materialize: (handover: ActionItemMaterialization) => void;
  start(): void;
  stop(): void;
}

/**
 * Compose the Tasks product (issue #200).
 *
 * One file-backed store under both Workspace interfaces, so a Debrief
 * materializing proposals and an owner completing a Task write the same
 * directory rather than two copies of it. The provider adapters live here
 * because they are this product's own semantics — a Task is written outward
 * one record at a time, and nothing is ever listed or imported — while the
 * credentials they read stay the Shell's.
 */
export function composeTasks(deps: TasksCompositionDeps): TasksComposition {
  const log = deps.log ?? (() => {});
  const store = new TaskStore(deps.workspaceDir);
  const tasks = new WorkspaceTasks({
    store,
    isConfirmedPerson: deps.isConfirmedPerson,
    isGoogleTasksEnabled: () => deps.configStore.get().tasks.googleTasks.enabled,
    isAsanaEnabled: () => deps.configStore.get().tasks.asana.enabled,
    timezone: deps.timezone,
  });
  const actionItems = new WorkspaceActionItems({ store, ownerProfileId: deps.ownerProfileId });

  /* Google Tasks and Asana as optional Task Destinations (issues #184, #185,
     #189). The Workspace write always commits first; linking only ever adds a
     representation of it. Completion is read and written per linked Task —
     nothing is ever listed or imported, so unrelated account Tasks stay out.
     The Asana token is read live from the config on every call: it is stored
     after this composition ran, and connecting must not need a restart. */
  const googleAuth = (status?: number) => {
    const access = deps.googleConnection.auth();
    if (!access.ok) {
      const error = new Error(deps.googleFailureHint(access.state));
      throw status === undefined ? error : Object.assign(error, { status });
    }
    return access.auth;
  };
  const resolveGoogleDestination = async (
    destination: GoogleTasksDestination,
  ): Promise<GoogleTasksDestination> => {
    if (destination.googleTaskListId) return destination;
    const matches = (await listGoogleTaskLists(googleAuth(401))).filter(
      (list) => list.title === destination.googleTaskListTitle,
    );
    if (matches.length !== 1)
      throw Object.assign(new Error("Historical Google Task List cannot be resolved uniquely."), {
        status: 400,
      });
    return { ...destination, googleTaskListId: matches[0]!.id };
  };
  const googleConnector: RemoteTaskConnector<GoogleTasksDestination> = {
    resolveDestination: resolveGoogleDestination,
    delete: async (destination, remoteId) =>
      deleteGoogleTask(googleAuth(401), destination.googleTaskListId, remoteId),
    create: async (task, destination) => {
      const created = await insertGoogleTask(googleAuth(401), destination.googleTaskListId, task);
      return { remoteId: created.googleId, url: created.webViewLink };
    },
    read: async (destination, remoteId) => {
      const resolved = await resolveGoogleDestination(destination);
      const remote = await getGoogleTask(googleAuth(401), resolved.googleTaskListId, remoteId);
      return remote === null
        ? null
        : {
            title: remote.title,
            notes: remote.notes,
            dueDate: remote.dueDate,
            status: remote.completed ? "completed" : "open",
          };
    },
    updateStatus: async (destination, remoteId, completed) => {
      await setGoogleTaskStatus(googleAuth(), destination.googleTaskListId, remoteId, completed);
    },
    updateContent: async (destination, remoteId, content) => {
      await setGoogleTaskContent(googleAuth(), destination.googleTaskListId, remoteId, content);
    },
  };

  /** The stored Asana token, or the refusal an unconnected Workspace owes its calls. */
  const requireAsanaToken = (): string => {
    const token = deps.configStore.get().tasks.asana.token;
    if (token === "") throw new Error("Asana is not connected. Connect Asana in Tasks first.");
    return token;
  };
  const asanaConnector: RemoteTaskConnector<AsanaDestination> = {
    delete: async (_destination, remoteId) => deleteAsanaTask(requireAsanaToken(), remoteId),
    create: async (task, destination) => createAsanaTask(requireAsanaToken(), destination, task),
    read: async (_destination, remoteId) => {
      const remote = await getAsanaTask(requireAsanaToken(), remoteId);
      return remote === null
        ? null
        : {
            title: remote.title,
            notes: remote.notes,
            dueDate: remote.dueDate,
            status: remote.completed ? "completed" : "open",
          };
    },
    updateStatus: async (_destination, remoteId, completed) => {
      await setAsanaTaskStatus(requireAsanaToken(), remoteId, completed);
    },
    updateContent: async (_destination, remoteId, content) => {
      await setAsanaTaskContent(requireAsanaToken(), remoteId, content);
    },
  };

  const linking = new TaskLinking({
    tasks,
    authorizationRevision: (provider) => {
      const config = deps.configStore.get();
      return createHash("sha256")
        .update(
          JSON.stringify(
            provider === "asana"
              ? [config.tasks.asana.token, config.tasks.asana.lastVerifiedAt]
              : [config.google.refreshToken, config.google.lastConnectedAt],
          ),
        )
        .digest("hex");
    },
    settings: () => deps.configStore.get().tasks.googleTasks,
    save: (settings) => {
      deps.configStore.setGoogleTasksDestination(settings);
      /* The Tasks scope is part of the grant only while this is enabled, so
         the remembered connection state has to be asked again. */
      deps.googleConnection.invalidate();
    },
    listRemoteLists: async () => listGoogleTaskLists(googleAuth()),
    google: googleConnector,
    asana: asanaConnector,
  });
  const asanaLinking = new AsanaLinking({
    settings: () => deps.configStore.get().tasks.asana,
    save: (settings) => deps.configStore.setAsanaDestination(settings),
    me: (token) => asanaMe(token),
    projects: (token, workspaceGid) => listAsanaProjects(token, workspaceGid),
    sections: (token, projectGid) => listAsanaSections(token, projectGid),
  });

  /* Automatic promotion (issue #181). The Debrief hands proposals over here
     rather than straight to the queue, because the policy's eligibility
     depends on what the queue held before this extraction. Delivery to a
     configured provider happens after the local Task has committed, and its
     failure lands on the External Task Link rather than on the work. */
  const materialize = (handover: ActionItemMaterialization): void => {
    /* Canonical materialization is what touches briefing staleness now: the
       positional decisions that used to do it are gone (issue #199), and the
       Briefings read the canonical records. Best effort, never into the
       extraction path. */
    try {
      deps.onActionItemsChanged?.();
    } catch {
      /* a staleness touch must not fail an extraction */
    }
    materializeUnderPolicy(
      {
        tasks,
        actionItems,
        policy: () => deps.configStore.get().tasks.actionItemPolicy,
        deliver: (taskId) => linking.link(taskId),
        log,
      },
      handover,
    );
  };

  return {
    tasks,
    actionItems,
    linking,
    asanaLinking,
    googleConnector,
    materialize,
    start: () => linking.start(),
    stop: () => linking.stop(),
  };
}
