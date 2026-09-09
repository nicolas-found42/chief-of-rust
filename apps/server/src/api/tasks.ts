import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ActionItemIndex,
  ActionItemPolicy,
  ActionItemState,
  TaskCreateInput,
  TaskDestination,
  TaskDuplicateCandidate,
  TaskDuplicateCheck,
  TaskIndex,
  TaskPriority,
} from "@chief-of-staff-demo/shared";
import {
  ACTION_ITEM_POLICIES,
  INBOX_TASK_LIST_ID,
  TASK_PRIORITIES,
} from "@chief-of-staff-demo/shared";
import {
  TaskValidationError,
  type ResponsibleFilter,
  type TaskQuery,
  type WorkspaceTasks,
} from "../tasks/tasks.js";
import type { ActionItemQuery, WorkspaceActionItems } from "../tasks/action-items.js";
import { promoteActionItem } from "../tasks/promotion.js";
import type { TaskLinking, TaskLinkResolution } from "../tasks/external-link.js";
import type { AsanaLinking } from "../tasks/asana-link.js";
import { buildTaskOverview } from "../tasks/overview.js";

export interface TasksApiContext {
  /** The Tasks product area's Workspace-owned interface; routes stay thin over it. */
  tasks: WorkspaceTasks;
  /** The Action Items a Meeting Debrief proposed, read here and owned there. */
  actionItems: WorkspaceActionItems;
  /**
   * Google Tasks as an optional Task Destination. Absent when the Workspace
   * composes no Google connection at all, and every Task route below still
   * works — which is the point of the destination being optional.
   */
  linking?: TaskLinking;
  /**
   * Asana as an optional Task Destination (issue #189). Absent when the
   * Workspace composes no Asana connection; every route below still answers.
   */
  asana?: AsanaLinking;
  /**
   * The Action Item Policy (issue #181), read and written here because it is
   * the Tasks product's own setting. Absent when the Workspace composes no
   * configuration store, and then the policy is the Stage all default that
   * every other route already behaves as if it were.
   */
  actionItemPolicy?: {
    get: () => ActionItemPolicy;
    set: (policy: ActionItemPolicy) => void;
  };
}

/** HTTP status per refusal: bad input, a missing record, or a refused state change. */
const REFUSAL_STATUS: Record<TaskValidationError["code"], number> = {
  "invalid-title": 400,
  "invalid-notes": 400,
  "invalid-list-name": 400,
  "invalid-due-date": 400,
  "invalid-priority": 400,
  "invalid-responsible-person": 400,
  "invalid-destination": 400,
  "invalid-token": 400,
  "task-list-not-found": 404,
  "task-not-found": 404,
  "task-list-not-empty": 409,
  "inbox-is-permanent": 409,
  "task-not-in-trash": 409,
  "task-already-linked": 409,
  "task-not-linked": 409,
  "link-not-missing": 409,
  "link-not-drifted": 409,
  "link-not-conflicted": 409,
  "action-item-not-found": 404,
  "action-item-already-promoted": 409,
  "action-item-dismissed": 409,
  /* 428: the request is well-formed and the Task is deletable — what is
     missing is the person saying so. */
  "confirmation-required": 428,
};

/** Query strings carry text; the Responsible Person filter is three shapes. */
function responsibleFilter(value: string | undefined): ResponsibleFilter | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "owner") return { kind: "owner" };
  if (value === "nobody") return { kind: "nobody" };
  return { kind: "person-profile", profileId: value };
}

const ACTION_ITEM_STATES: readonly ActionItemState[] = ["pending", "promoted", "dismissed"];

/** The body the policy routes refuse with when no configuration is composed. */
const NO_POLICY = {
  error: "action-item-policy-unavailable",
  message: "This Workspace has no Action Item Policy setting.",
};

/** The refusal a resolution request without a side earns. */
const KEEP_REQUIRED = {
  error: "invalid-resolution",
  message: 'Resolving a link needs "keep": "app" or "keep": "external".',
};

/** Which side a resolution request kept, or null when it named neither. */
function resolutionOf(body: unknown): TaskLinkResolution | null {
  const keep = (body as { keep?: unknown } | null)?.keep;
  return keep === "app" || keep === "external" ? keep : null;
}

/** The body `requireLinking` refuses with, alongside the 409 it sets. */
const NO_DESTINATION = {
  error: "invalid-destination",
  message: "No external Task Destination is available.",
};

/**
 * The Tasks product namespace (ADR-0052): Task capture and editing, Task List
 * management, and the readable queue of Action Items awaiting review. No
 * provider is reachable here — every route is a Workspace-local operation, so
 * the whole product works with no external account connected.
 *
 * Action Items are readable but never writable through this namespace: they
 * are proposals until a decision is made, and they are not Tasks.
 */
export function registerTasksApi(app: FastifyInstance, ctx: TasksApiContext): void {
  const tasks = ctx.tasks;

  app.post("/api/tasks/refresh", async () => ({ tasks: (await ctx.linking?.refresh()) ?? [] }));
  app.post("/api/tasks/retry-failed", async () => ({
    tasks: (await ctx.linking?.refresh({ failedOnly: true, manual: true })) ?? [],
  }));

  /**
   * The external destination, or the one refusal every route that needs it
   * gives: a Workspace that composes no Google connection has nothing to file
   * outward to, and says so once rather than four times.
   */
  function requireLinking(reply: FastifyReply): TaskLinking | null {
    if (ctx.linking) return ctx.linking;
    reply.code(409);
    return null;
  }

  /**
   * The Asana destination service, or the one refusal every Asana route
   * gives: a Workspace that composes no Asana connection has nothing to
   * configure, and says so once rather than six times.
   */
  function requireAsana(reply: FastifyReply): AsanaLinking | null {
    if (ctx.asana) return ctx.asana;
    reply.code(409);
    return null;
  }

  /** Every refused Task operation answers with its stable code and message. */
  function refuse(reply: FastifyReply, error: unknown): { error: string; message: string } {
    if (error instanceof TaskValidationError) {
      reply.code(REFUSAL_STATUS[error.code]);
      return { error: error.code, message: error.message };
    }
    throw error;
  }

  /**
   * The Tasks a query selects, the lists they file into, and today's calendar
   * date in the Workspace timezone (issue #175). Today is served rather than
   * left to the browser: a date-only due date belongs to the owner's day.
   */
  /**
   * The compact rollup Home and the Meeting Wizard read (issue #192). A pure
   * projection of the canonical stores: counts, two capped lists, and the
   * Workspace's own today, so no compact surface has to fetch every Task and
   * count them itself — or resolve "today" in the browser's timezone.
   */
  app.get("/api/tasks/overview", async () =>
    buildTaskOverview({ tasks, actionItems: ctx.actionItems }),
  );

  app.get("/api/tasks", async (request: FastifyRequest) => {
    const query = request.query as {
      listId?: string;
      status?: string;
      trashed?: string;
      search?: string;
      priority?: string;
      responsible?: string;
      linked?: string;
    };
    const status =
      query.status === "open" || query.status === "completed" ? query.status : undefined;
    const responsible = responsibleFilter(query.responsible);
    const filter: TaskQuery = {
      ...(query.listId ? { listId: query.listId } : {}),
      ...(status ? { status } : {}),
      ...(query.trashed === "true" ? { trashed: true } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(TASK_PRIORITIES.includes(query.priority as TaskPriority)
        ? { priority: query.priority as TaskPriority }
        : {}),
      ...(responsible ? { responsible } : {}),
      ...(query.linked === "true" || query.linked === "false"
        ? { linked: query.linked === "true" }
        : {}),
    };
    const selected = tasks.list(filter);
    const index: TaskIndex = {
      tasks: selected,
      lists: tasks.lists(),
      today: tasks.today(),
      /* Asked of the Action Items rather than stored on the Task: a source
         becomes unavailable long after the Task was written, and a snapshot
         that rewrote itself when its source went away would not be one. */
      unavailableSources: selected
        .filter(
          (task) => task.source !== null && ctx.actionItems.get(task.source.actionItemId) === null,
        )
        .map((task) => task.id),
    };
    return index;
  });

  /**
   * Capture one Task. The Workspace write commits first and answers alone; an
   * external destination is a second, separate step the surface takes with the
   * Task it already has (ADR-0056), so Google being slow or broken can never
   * cost someone the Task they just captured.
   */
  app.post("/api/tasks", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const created = tasks.create((request.body ?? {}) as TaskCreateInput);
      reply.code(201);
      return created;
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * The open Tasks a would-be Task would duplicate (issue #180). A read that
   * creates nothing and refuses nothing: the answer feeds the review form's
   * Possible duplicate warning, and the decision it informs stays with the
   * owner — no confirmation token, no gate on creation itself.
   */
  app.post("/api/tasks/duplicates", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const candidate = (request.body ?? {}) as TaskDuplicateCandidate;
      const check: TaskDuplicateCheck = { duplicates: tasks.findDuplicates(candidate) };
      return check;
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.get("/api/tasks/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.get(taskId);
    if (!task) {
      reply.code(404);
      return { error: "task-not-found", message: `No Task with id ${taskId}` };
    }
    return task;
  });

  app.patch("/api/tasks/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      tasks.update(taskId, request.body ?? {});
      if (ctx.linking) return await ctx.linking.pushContent(taskId);
      return tasks.get(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /* POST, not PUT: completing is an action on a Task, and both directions are
     idempotent, so a repeated request is the same answer rather than a
     second completion time. The local commit answers first; a linked Google
     Task is then pushed best-effort (issue #185), and a Google failure is
     recorded on the link the answer carries rather than failing the Task. */
  app.post("/api/tasks/:taskId/complete", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      tasks.complete(taskId);
      if (ctx.linking) return await ctx.linking.pushStatus(taskId);
      return tasks.get(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post("/api/tasks/:taskId/reopen", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      tasks.reopen(taskId);
      if (ctx.linking) return await ctx.linking.pushStatus(taskId);
      return tasks.get(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post("/api/tasks/:taskId/trash", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      const choice = (request.body as { external?: unknown } | null)?.external;
      if (ctx.linking)
        return await ctx.linking.trash(
          taskId,
          choice === "delete" || choice === "preserve" ? choice : undefined,
        );
      if (tasks.get(taskId)?.externalLink) {
        throw new TaskValidationError(
          "confirmation-required",
          "Remove the External Task Link before moving this Task to Trash.",
        );
      }
      return tasks.trash(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post("/api/tasks/:taskId/restore", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return tasks.restore(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /* Confirmation travels in the request rather than being assumed by the
     method: DELETE says what to do, and `confirm` says that someone meant it. */
  app.delete("/api/tasks/:taskId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const { confirm } = request.query as { confirm?: string };
    try {
      tasks.deleteForever(taskId, { confirmed: confirm === "true" });
      return { deleted: taskId };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * Send one already-committed Task outward. Answers with the Task and its
   * link whether Google accepted or refused: a failed link is a state of a
   * perfectly good Task, not an error about it.
   */
  app.post("/api/tasks/:taskId/link", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    try {
      return await linking.link(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * Synchronize one linked Task with its Google Task (issue #185). Applies an
   * unopposed external completion or reopening, marks a gone record missing,
   * and otherwise answers with the Task unchanged: repeated reads that agree
   * write nothing. A Task with nothing linked is refused, not silently
   * answered.
   */
  app.post("/api/tasks/:taskId/sync", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    try {
      return await linking.synchronize(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post(
    "/api/tasks/:taskId/recover-creation",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { taskId } = request.params as { taskId: string };
      const linking = requireLinking(reply);
      if (!linking) return NO_DESTINATION;
      const body = request.body as { remoteId?: unknown } | null;
      if (typeof body?.remoteId !== "string")
        return reply.code(400).send({ error: "remote-id-required" });
      try {
        return await linking.recoverCreation(taskId, body.remoteId);
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.post("/api/tasks/:taskId/retry", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    try {
      return await linking.retry(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * Recreate the remote record for a missing link (issue #185). Answers with
   * the Task carrying the replacement identity; a Task whose link is not
   * missing is refused rather than duplicated outward.
   */
  app.post("/api/tasks/:taskId/recreate", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    try {
      return await linking.recreate(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * Settle an External Task Drift or a Task Link Conflict (issue #186). The
   * body names the side the owner kept — `app` or `external` — and nothing
   * else: an outside edit and an outside completion are different facts about
   * a link, so each has its own route rather than one that guesses which the
   * caller meant.
   *
   * Both refuse a link that is not in the state they resolve, and both leave
   * the state standing when the operation the owner chose fails.
   */
  app.post("/api/tasks/:taskId/drift", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    const choice = resolutionOf(request.body);
    if (choice === null) {
      reply.code(400);
      return KEEP_REQUIRED;
    }
    try {
      return await linking.resolveDrift(taskId, choice);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.post("/api/tasks/:taskId/conflict", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    const choice = resolutionOf(request.body);
    if (choice === null) {
      reply.code(400);
      return KEEP_REQUIRED;
    }
    try {
      return await linking.resolveConflict(taskId, choice);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * Remove one External Task Link (issue #185). The local Task is preserved
   * and the remote record is never deleted by this route. Idempotent: a Task
   * with no link answers with itself.
   */
  app.delete("/api/tasks/:taskId/link", async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    try {
      return await linking.removeLink(taskId);
    } catch (error) {
      return refuse(reply, error);
    }
  });
  /**
   * The Google Tasks destination (issue #184). Reading it never reaches
   * Google; only choosing a list does, and only to list the containers the
   * account offers.
   */
  app.get("/api/tasks/google-destination", async () => {
    if (!ctx.linking) {
      return { enabled: false, taskListId: "", taskListTitle: "", available: false };
    }
    return { ...ctx.linking.settings(), available: true };
  });

  app.get("/api/tasks/google-lists", async (_request: FastifyRequest, reply: FastifyReply) => {
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    try {
      return { lists: await linking.availableLists() };
    } catch (error) {
      reply.code(502);
      return {
        error: "google-unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.put("/api/tasks/google-destination", async (request: FastifyRequest, reply: FastifyReply) => {
    const linking = requireLinking(reply);
    if (!linking) return NO_DESTINATION;
    const body = (request.body ?? {}) as { enabled?: boolean; taskListId?: string };
    try {
      return {
        ...(await linking.select({
          enabled: body.enabled === true,
          ...(body.taskListId === undefined ? {} : { taskListId: body.taskListId }),
        })),
        available: true,
      };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Asana (issue #189)
  // ---------------------------------------------------------------------------

  /**
   * The Asana destination, as the Tasks page reads and writes it. The token
   * is never in this answer — `connected` and `tokenHint` are all a person
   * gets, which is the whole point of storing a secret through the
   * credential boundary.
   */
  app.get("/api/tasks/asana-destination", async () => {
    if (!ctx.asana) {
      return {
        connected: false,
        tokenHint: "",
        lastVerifiedAt: null,
        enabled: false,
        /* The gids and names ride along at their defaults so the answer has
           one shape whether or not this Workspace composes Asana. */
        workspaceGid: "",
        workspaceName: "",
        projectGid: "",
        projectName: "",
        sectionGid: null,
        sectionName: null,
        available: false,
      };
    }
    return { ...ctx.asana.status(), available: true };
  });

  /**
   * Verify a personal access token against Asana and store it when Asana
   * accepts it. The answer names the user the token belongs to and the
   * workspaces it reaches — Check connection's first use, before any
   * destination is chosen.
   */
  app.post("/api/tasks/asana/connect", async (request: FastifyRequest, reply: FastifyReply) => {
    const asana = requireAsana(reply);
    if (!asana) return NO_DESTINATION;
    const body = (request.body ?? {}) as { token?: unknown };
    if (typeof body.token !== "string") {
      reply.code(400);
      return { error: "invalid-token", message: "An Asana personal access token is required." };
    }
    try {
      return await asana.connect(body.token);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /** Forget the token and disable the destination. Local Tasks are untouched. */
  app.post("/api/tasks/asana/disconnect", async (_request: FastifyRequest, reply: FastifyReply) => {
    const asana = requireAsana(reply);
    if (!asana) return NO_DESTINATION;
    return asana.disconnect();
  });

  /**
   * Check connection on demand: the user and workspaces the stored token
   * reaches right now. A stale token is refused with what to do about it,
   * and changes nothing.
   */
  app.post("/api/tasks/asana/check", async (_request: FastifyRequest, reply: FastifyReply) => {
    const asana = requireAsana(reply);
    if (!asana) return NO_DESTINATION;
    try {
      return await asana.checkConnection();
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /** The projects of one workspace. Containers only — never a project's Tasks. */
  app.get("/api/tasks/asana/projects", async (request: FastifyRequest, reply: FastifyReply) => {
    const asana = requireAsana(reply);
    if (!asana) return NO_DESTINATION;
    const { workspace } = request.query as { workspace?: string };
    if (!workspace) {
      reply.code(400);
      return { error: "invalid-destination", message: "Which workspace?" };
    }
    try {
      return { projects: await asana.availableProjects(workspace) };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /** The sections of one project, scoped to it by construction. */
  app.get("/api/tasks/asana/sections", async (request: FastifyRequest, reply: FastifyReply) => {
    const asana = requireAsana(reply);
    if (!asana) return NO_DESTINATION;
    const { project } = request.query as { project?: string };
    if (!project) {
      reply.code(400);
      return { error: "invalid-destination", message: "Which project?" };
    }
    try {
      return { sections: await asana.availableSections(project) };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * Enable the destination, or choose where Tasks go. Enabling validates the
   * whole chain live — the project against the workspace, the section against
   * the project — so an inaccessible destination is refused here, once,
   * instead of failing one Task at a time.
   */
  app.put("/api/tasks/asana-destination", async (request: FastifyRequest, reply: FastifyReply) => {
    const asana = requireAsana(reply);
    if (!asana) return NO_DESTINATION;
    const body = (request.body ?? {}) as {
      enabled?: boolean;
      workspaceGid?: string;
      projectGid?: string;
      sectionGid?: string | null;
    };
    try {
      return {
        ...(await asana.select({
          enabled: body.enabled === true,
          ...(body.workspaceGid === undefined ? {} : { workspaceGid: body.workspaceGid }),
          ...(body.projectGid === undefined ? {} : { projectGid: body.projectGid }),
          ...(body.sectionGid === undefined ? {} : { sectionGid: body.sectionGid }),
        })),
        available: true,
      };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.get("/api/task-lists", async () => ({ lists: tasks.lists() }));

  app.post("/api/task-lists", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { name?: string; defaultDestination?: TaskDestination };
    try {
      const created = tasks.createList({
        name: body.name ?? "",
        ...(body.defaultDestination ? { defaultDestination: body.defaultDestination } : {}),
      });
      reply.code(201);
      return created;
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.patch("/api/task-lists/:listId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { listId } = request.params as { listId: string };
    try {
      return tasks.updateList(listId, request.body ?? {});
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.delete("/api/task-lists/:listId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { listId } = request.params as { listId: string };
    try {
      tasks.deleteList(listId);
      /* The remaining lists rather than an empty 204: the surface that just
         deleted one needs to redraw them, and one answer beats two calls. */
      return { lists: tasks.lists() };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  /**
   * The pending Action Item queue. A read, never a write: an Action Item is a
   * proposal until the owner promotes or dismisses it, and this namespace does
   * not treat one as a Task.
   */
  app.get("/api/action-items", async (request: FastifyRequest) => {
    const query = request.query as {
      state?: string;
      debriefRunId?: string;
      transcriptId?: string;
      meetingId?: string;
    };
    const filter: ActionItemQuery = {
      ...(ACTION_ITEM_STATES.includes(query.state as ActionItemState)
        ? { state: query.state as ActionItemState }
        : {}),
      ...(query.debriefRunId ? { debriefRunId: query.debriefRunId } : {}),
      ...(query.transcriptId ? { transcriptId: query.transcriptId } : {}),
      ...(query.meetingId ? { meetingId: query.meetingId } : {}),
    };
    const index: ActionItemIndex = { items: ctx.actionItems.list(filter) };
    return index;
  });

  /**
   * Promote one reviewed Action Item into a Task (issue #178). The body is the
   * review panel's accepted fields; anything it leaves out falls back to the
   * proposal, so an owner who changed nothing gets what the meeting said.
   *
   * 201 for the promotion that happened, 200 for one that already had: a retry
   * answers with the same Task rather than making a second one.
   */
  app.post(
    "/api/action-items/:actionItemId/promote",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { actionItemId } = request.params as { actionItemId: string };
      try {
        const result = promoteActionItem(
          { tasks, actionItems: ctx.actionItems },
          actionItemId,
          request.body ?? {},
        );
        reply.code(result.created ? 201 : 200);
        return { task: result.task, actionItem: result.actionItem };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  /**
   * Dismiss one pending Action Item (issue #179). Immediate and local-only:
   * no Task is created and no provider is reached. Idempotent, so a repeated
   * Dismiss answers with the same dismissed record. A promoted Action Item
   * cannot be dismissed.
   */
  app.post(
    "/api/action-items/:actionItemId/dismiss",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { actionItemId } = request.params as { actionItemId: string };
      try {
        return { actionItem: ctx.actionItems.dismiss(actionItemId) };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  /**
   * Restore one dismissed Action Item to pending (issue #179). This is both
   * the temporary Undo after a dismissal and the later restore from Debrief
   * history: identity, source, revision and proposal are kept, only the
   * decision is cleared. Idempotent while pending; promoted stays promoted.
   */
  app.post(
    "/api/action-items/:actionItemId/restore",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { actionItemId } = request.params as { actionItemId: string };
      try {
        return { actionItem: ctx.actionItems.restore(actionItemId) };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  /**
   * The Action Item Policy (issue #181). Stage all is what a Workspace does
   * until the owner says otherwise here, and turning automatic promotion on
   * while Tasks are filed outward is a decision with an outbound consequence:
   * a Debrief would then write into a provider with nobody watching. So that
   * one combination is refused until the request says the owner was told —
   * 428, the same shape permanent deletion uses, because what is missing is
   * the person saying so rather than anything about the request.
   */
  app.get("/api/action-item-policy", async () => policyAnswer());

  app.put("/api/action-item-policy", async (request: FastifyRequest, reply: FastifyReply) => {
    const setting = ctx.actionItemPolicy;
    if (!setting) {
      reply.code(409);
      return NO_POLICY;
    }
    const body = (request.body ?? {}) as { policy?: string; confirmedExternalWrites?: boolean };
    if (!ACTION_ITEM_POLICIES.includes(body.policy as ActionItemPolicy)) {
      reply.code(400);
      return {
        error: "invalid-action-item-policy",
        message: `Action Item Policy has to be one of: ${ACTION_ITEM_POLICIES.join(", ")}.`,
      };
    }
    const policy = body.policy as ActionItemPolicy;
    const outward = outwardDestination();
    if (
      policy === "auto-create-mine" &&
      outward !== null &&
      body.confirmedExternalWrites !== true
    ) {
      reply.code(428);
      return {
        error: "confirmation-required",
        message:
          `Automatically created Tasks would be written to ${outward} without review. ` +
          "Confirm the outbound writes to turn this on.",
      };
    }
    setting.set(policy);
    return policyAnswer();
  });

  /** The policy and what selecting automatic promotion would send outward. */
  function policyAnswer(): {
    policy: ActionItemPolicy;
    externalDestination: string | null;
  } {
    return {
      policy: ctx.actionItemPolicy?.get() ?? "stage-all",
      externalDestination: outwardDestination(),
    };
  }

  /**
   * The provider an automatically promoted Task would reach, or null when
   * none would. Automatic promotion files into the default Task List with no
   * override, so that list's own default destination is the whole answer.
   */
  function outwardDestination(): string | null {
    const destination = tasks.getList(INBOX_TASK_LIST_ID)?.defaultDestination;
    if (!destination || destination.provider === "local") return null;
    return destination.provider === "asana" ? "Asana" : "Google Tasks";
  }
}
